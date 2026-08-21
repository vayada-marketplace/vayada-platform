#!/usr/bin/env bash
set -euo pipefail
umask 077

version="${1:?usage: bootstrap-finance-folio-kms.sh <vN> <state-file>}"
state_file="${2:?usage: bootstrap-finance-folio-kms.sh <vN> <state-file>}"
[[ "${version}" =~ ^v[1-9][0-9]*$ ]] || { echo "Version must be vN with N >= 1." >&2; exit 2; }
[[ "${state_file}" = /* && ! -L "${state_file}" ]] || { echo "State file must be an absolute, non-symlink path." >&2; exit 2; }
for command_name in aws jq mktemp terraform uuidgen; do command -v "${command_name}" >/dev/null || { echo "Missing ${command_name}." >&2; exit 2; }; done

account="269416271598"
region="eu-west-1"
alias_name="alias/vayada/prod/finance-folio-recipient-current"
role_name="vayada-github-actions-platform-deploy"
state_lineage="3c8d6f2b-d4c4-f0ac-3be0-2a6280d72fe0"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
template="${repo_dir}/docs/finance-folio-kms-steady-state-policy.template.json"
address="aws_kms_key.finance_folio_recipient[\"${version}\"]"
expected_tags="$(jq -cn --arg version "${version}" '{Name:("vayada-finance-folio-recipient-"+$version),Project:"vayada",Environment:"production",Purpose:"finance-folio-recipient",Version:$version,ManagedBy:"terraform"}')"

configured_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[[ -z "${configured_region}" || "${configured_region}" == "${region}" ]] || { echo "Configured AWS region must be ${region}." >&2; exit 1; }
identity="$(aws sts get-caller-identity --region "${region}" --output json)"
[[ "$(jq -r .Account <<<"${identity}")" == "${account}" ]] || { echo "AWS account must be ${account}." >&2; exit 1; }
for name in db_master_password db_booking_password db_pms_password db_auth_password jwt_secret_key; do
  variable="TF_VAR_${name}"; [[ -n "${!variable:-}" ]] || { echo "Load production ${variable} before bootstrap." >&2; exit 1; }
done
terraform -chdir="${repo_dir}/infra" init -reconfigure -input=false \
  -backend-config="bucket=vayada-terraform-state" -backend-config="key=platform/terraform.tfstate" \
  -backend-config="region=${region}" -backend-config="dynamodb_table=vayada-terraform-lock" -backend-config="encrypt=true" >/dev/null
[[ "$(terraform -chdir="${repo_dir}/infra" workspace show)" == default ]] || { echo "Terraform workspace must be default." >&2; exit 1; }
remote_state="$(terraform -chdir="${repo_dir}/infra" state pull)"
[[ "$(jq -er .lineage <<<"${remote_state}")" == "${state_lineage}" ]] || { echo "Terraform state lineage mismatch." >&2; exit 1; }
declared="$(printf 'contains(keys(local.finance_folio_recipient_kms_key_versions), "%s")\n' "${version}" | terraform -chdir="${repo_dir}/infra" console -no-color)"
[[ "${declared}" == true ]] || { echo "Declare ${version} in the Terraform version map before bootstrap; do not apply it." >&2; exit 1; }
current_version="$(printf 'local.finance_folio_recipient_kms_current_key_version\n' | terraform -chdir="${repo_dir}/infra" console -no-color | tr -d '"')"
if [[ "${version}" == v1 ]]; then
  [[ "${current_version}" == v1 ]] || { echo "Initial bootstrap requires current v1." >&2; exit 1; }
else
  [[ "${current_version}" != "${version}" ]] || { echo "Rotation key cannot already be configured current." >&2; exit 1; }
  current_address="aws_kms_key.finance_folio_recipient[\"${current_version}\"]"
  current_state="$(terraform -chdir="${repo_dir}/infra" state show -no-color "${current_address}")"
  managed_current_key_id="$(sed -n 's/^[[:space:]]*id[[:space:]]*=[[:space:]]*//p' <<<"${current_state}" | tr -d '"' | head -1)"
  alias_state="$(terraform -chdir="${repo_dir}/infra" state show -no-color aws_kms_alias.finance_folio_recipient_current)"
  managed_alias_target="$(sed -n 's/^[[:space:]]*target_key_id[[:space:]]*=[[:space:]]*//p' <<<"${alias_state}" | tr -d '"' | head -1)"
  grep -Fq "id = \"${alias_name}\"" <<<"${alias_state}"
  [[ -n "${managed_current_key_id}" && "${managed_alias_target}" == "${managed_current_key_id}" ]] || { echo "Terraform current key/alias state mismatch." >&2; exit 1; }
fi

save_state() {
  local value="$1" temporary
  temporary="$(mktemp "${state_file}.tmp.XXXXXX")"
  printf '%s\n' "${value}" >"${temporary}"
  chmod 600 "${temporary}"
  mv "${temporary}" "${state_file}"
}
alias_target() {
  local target
  target="$(aws kms list-aliases --region "${region}" --query "Aliases[?AliasName=='${alias_name}'].TargetKeyId | [0]" --output text)" || { echo "Alias lookup failed." >&2; return 1; }
  [[ "${target}" == None ]] && target=""
  printf '%s' "${target}"
}
matching_keys() {
  local candidate description keys manager metadata tags tag_map
  keys="$(aws kms list-keys --region "${region}" --query 'Keys[].KeyId' --output text)" || return 1
  for candidate in ${keys}; do
    [[ "${candidate}" == None ]] && continue
    metadata="$(aws kms describe-key --region "${region}" --key-id "${candidate}" --output json)" || return 1
    manager="$(jq -er .KeyMetadata.KeyManager <<<"${metadata}")" || return 1
    [[ "${manager}" == CUSTOMER ]] || continue
    tags="$(aws kms list-resource-tags --region "${region}" --key-id "${candidate}" --output json)" || return 1
    tag_map="$(jq -Sce '.Tags | map({key:.TagKey,value:.TagValue}) | from_entries' <<<"${tags}")" || return 1
    [[ "${tag_map}" == "$(jq -Sc . <<<"${expected_tags}")" ]] || continue
    description="$(jq -er .KeyMetadata.Description <<<"${metadata}")" || return 1
    printf '%s\t%s\n' "${candidate}" "${description}"
  done
}

if [[ -e "${state_file}" ]]; then
  [[ -f "${state_file}" ]] || { echo "State path is not a regular file." >&2; exit 1; }
  state="$(jq -c . "${state_file}")"
  jq -e --arg v "${version}" --arg a "${account}" --arg r "${region}" '.schema==1 and .version==$v and .account==$a and .region==$r and (.bootstrapId|type=="string")' <<<"${state}" >/dev/null || { echo "State file contract mismatch." >&2; exit 1; }
else
  bootstrap_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  state="$(jq -cn --arg v "${version}" --arg a "${account}" --arg r "${region}" --arg b "${bootstrap_id}" '{schema:1,version:$v,account:$a,region:$r,bootstrapId:$b,phase:"unlocked"}')"
  save_state "${state}"
fi

bootstrap_id="$(jq -r .bootstrapId <<<"${state}")"
lock_id="finance-folio-kms/${account}/${region}/${version}"
session_id="${bootstrap_id}:$(uuidgen)"
lock_key="$(jq -cn --arg id "${lock_id}" '{LockID:{S:$id}}')"
hold_lock() {
  local now item values
  now="$(date +%s)"
  item="$(jq -cn --arg id "${lock_id}" --arg owner "${session_id}" --arg expiry "$((now + 3600))" '{LockID:{S:$id},Owner:{S:$owner},LeaseUntil:{N:$expiry}}')"
  values="$(jq -cn --arg owner "${session_id}" --arg now "${now}" '{":owner":{S:$owner},":now":{N:$now}}')"
  aws dynamodb put-item --region "${region}" --table-name vayada-terraform-lock --item "${item}" --condition-expression 'attribute_not_exists(LockID) OR #owner = :owner OR LeaseUntil < :now' --expression-attribute-names '{"#owner":"Owner"}' --expression-attribute-values "${values}" >/dev/null
}
release_lock() { local status=$?; trap - EXIT; aws dynamodb delete-item --region "${region}" --table-name vayada-terraform-lock --key "${lock_key}" --condition-expression '#owner = :owner' --expression-attribute-names '{"#owner":"Owner"}' --expression-attribute-values "$(jq -cn --arg owner "${session_id}" '{":owner":{S:$owner}}')" >/dev/null || { echo "Bootstrap lease release failed; wait for expiry." >&2; [[ "${status}" -ne 0 ]] || status=1; }; exit "${status}"; }
hold_lock || { echo "Another ${account}/${region}/${version} bootstrap lease is active." >&2; exit 1; }
trap release_lock EXIT

if [[ "$(jq -r .phase <<<"${state}")" == unlocked ]]; then
  matches="$(matching_keys)" || { echo "Key discovery failed; refusing CreateKey." >&2; exit 1; }
  existing=()
  while IFS= read -r line; do [[ -z "${line}" ]] || existing+=("${line}"); done <<<"${matches}"
  [[ "${#existing[@]}" == 0 ]] || { echo "Refusing unowned or ambiguous existing ${version} key state." >&2; exit 1; }
  before="$(alias_target)" || exit 1
  if [[ "${version}" == v1 ]]; then [[ -z "${before}" ]] || { echo "Refusing existing v1 alias state." >&2; exit 1; }
  else [[ "${before}" == "${managed_current_key_id}" ]] || { echo "Live alias is not the Terraform-managed current key." >&2; exit 1; }; fi
  state="$(jq -c --arg before "${before}" '.aliasTargetBefore=($before|if length>0 then . else null end) | .phase="planned"' <<<"${state}")"
  save_state "${state}"
fi

if [[ "${version}" != v1 ]]; then
  [[ "$(jq -r '.aliasTargetBefore // empty' <<<"${state}")" == "${managed_current_key_id}" ]] || { echo "Rotation state is not pinned to Terraform current." >&2; exit 1; }
fi
key_id="$(jq -r '.keyId // empty' <<<"${state}")"
if [[ -z "${key_id}" && "$(jq -r .phase <<<"${state}")" == creating ]]; then
  response_file="${state_file}.create.json"
  key_id="$(jq -r '.KeyMetadata.KeyId // empty' "${response_file}" 2>/dev/null || true)"
  if [[ -z "${key_id}" ]]; then
    matches="$(matching_keys)" || { echo "Recovery key discovery failed." >&2; exit 1; }
    recovered=()
    while IFS= read -r line; do [[ -z "${line}" ]] || recovered+=("${line}"); done <<<"$(awk -F '\t' -v marker="bootstrap=${bootstrap_id}" '$2 ~ marker {print $1}' <<<"${matches}")"
    [[ "${#recovered[@]}" == 1 ]] || { echo "Creation outcome is ambiguous; retry recovery later and never create another key." >&2; exit 1; }
    key_id="${recovered[0]}"
  fi
fi
if [[ -z "${key_id}" ]]; then
  [[ "$(jq -r .phase <<<"${state}")" == planned ]] || { echo "State has no recoverable key ID." >&2; exit 1; }
  matches="$(matching_keys)" || { echo "Race-check key discovery failed." >&2; exit 1; }
  raced=()
  while IFS= read -r line; do [[ -z "${line}" ]] || raced+=("${line}"); done <<<"${matches}"
  observed_alias="$(alias_target)" || exit 1
  [[ "${#raced[@]}" == 0 && "${observed_alias}" == "$(jq -r '.aliasTargetBefore // empty' <<<"${state}")" ]] || { echo "Key or alias state changed after preflight." >&2; exit 1; }
  hold_lock || { echo "Bootstrap lease was lost before CreateKey." >&2; exit 1; }
  state="$(jq -c '.phase="creating"' <<<"${state}")"; save_state "${state}"
  response_file="${state_file}.create.json"
  [[ ! -e "${response_file}" && ! -L "${response_file}" ]] || { echo "Refusing an existing create response path." >&2; exit 1; }
  aws kms create-key --region "${region}" --key-spec SYMMETRIC_DEFAULT --key-usage ENCRYPT_DECRYPT --description "Finance folio recipient ${version}; bootstrap=${bootstrap_id}" --tags "TagKey=Name,TagValue=vayada-finance-folio-recipient-${version}" TagKey=Project,TagValue=vayada TagKey=Environment,TagValue=production TagKey=Purpose,TagValue=finance-folio-recipient "TagKey=Version,TagValue=${version}" TagKey=ManagedBy,TagValue=terraform --output json >"${response_file}"
  key_id="$(jq -er .KeyMetadata.KeyId "${response_file}")"
fi
metadata="$(aws kms describe-key --region "${region}" --key-id "${key_id}" --output json)"
key_arn="$(jq -er .KeyMetadata.Arn <<<"${metadata}")"
state="$(jq -c --arg id "${key_id}" --arg arn "${key_arn}" '.keyId=$id | .keyArn=$arn | .phase="created"' <<<"${state}")"
save_state "${state}"
[[ ! -f "${state_file}.create.json" ]] || unlink "${state_file}.create.json"

jq -e --arg id "${key_id}" --arg arn "${key_arn}" --arg account "${account}" --arg region "${region}" --arg description "Finance folio recipient ${version}; bootstrap=${bootstrap_id}" '
  .KeyMetadata | .KeyId==$id and .Arn==$arn and .AWSAccountId==$account and .KeyManager=="CUSTOMER" and
  .KeySpec=="SYMMETRIC_DEFAULT" and .KeyUsage=="ENCRYPT_DECRYPT" and .Enabled==true and .KeyState=="Enabled" and
  .Description==$description and ($arn | startswith("arn:aws:kms:"+$region+":"+$account+":key/"))' <<<"${metadata}" >/dev/null || { echo "Created key metadata differs from the bootstrap contract." >&2; exit 1; }
tags="$(aws kms list-resource-tags --region "${region}" --key-id "${key_id}" --output json)"
jq -e --argjson expected "${expected_tags}" '(.Tags | map({key:.TagKey,value:.TagValue}) | from_entries) == $expected' <<<"${tags}" >/dev/null || { echo "Created key must have exactly the six reviewed tags." >&2; exit 1; }
aws kms enable-key-rotation --region "${region}" --key-id "${key_id}"
[[ "$(aws kms get-key-rotation-status --region "${region}" --key-id "${key_id}" --query KeyRotationEnabled --output text)" == True ]] || { echo "Key rotation is not enabled." >&2; exit 1; }

before="$(jq -r '.aliasTargetBefore // empty' <<<"${state}")"
current="$(alias_target)" || exit 1
if [[ "${version}" == v1 ]]; then
  if [[ -z "${current}" ]]; then aws kms create-alias --region "${region}" --alias-name "${alias_name}" --target-key-id "${key_id}"; current="$(alias_target)" || exit 1; fi
  [[ "${current}" == "${key_id}" ]] || { echo "Alias does not target the verified v1 key." >&2; exit 1; }
else
  [[ -n "${before}" && "${current}" == "${before}" && "${current}" != "${key_id}" ]] || { echo "Rotation alias moved before validation." >&2; exit 1; }
fi

policy_file="${state_file}.policy.json"
[[ ! -L "${policy_file}" ]] || { echo "Policy output must not be a symlink." >&2; exit 1; }
jq --arg arn "${key_arn}" 'walk(if . == "arn:aws:kms:eu-west-1:269416271598:key/00000000-0000-0000-0000-000000000000" then $arn else . end)' "${template}" >"${policy_file}"
grep -Fq "${key_arn}" "${policy_file}" && ! grep -Fq '00000000-0000-0000-0000-000000000000' "${policy_file}" || { echo "Exact-ARN policy rendering failed." >&2; exit 1; }
aws iam put-role-policy --role-name "${role_name}" --policy-name "platform-finance-folio-kms-${version}" --policy-document "file://${policy_file}"

if ! terraform -chdir="${repo_dir}/infra" state show -no-color "${address}" >/dev/null 2>&1; then terraform -chdir="${repo_dir}/infra" import "${address}" "${key_id}"; fi
terraform -chdir="${repo_dir}/infra" state show -no-color "${address}" | grep -Eq "^[[:space:]]*id[[:space:]]*=[[:space:]]*${key_id}$"
if [[ "${version}" == v1 ]]; then
  alias_address="aws_kms_alias.finance_folio_recipient_current"
  if ! terraform -chdir="${repo_dir}/infra" state show -no-color "${alias_address}" >/dev/null 2>&1; then terraform -chdir="${repo_dir}/infra" import "${alias_address}" "${alias_name}"; fi
  terraform -chdir="${repo_dir}/infra" state show -no-color "${alias_address}" | grep -Fq "id = \"${alias_name}\""
  terraform -chdir="${repo_dir}/infra" state show -no-color "${alias_address}" | grep -Fq "target_key_id = \"${key_id}\""
fi
policies="$(aws iam list-role-policies --role-name "${role_name}" --output json)" || { echo "Cannot verify deploy-role inline policies." >&2; exit 1; }
if jq -e '.PolicyNames | index("platform-finance-folio-kms-bootstrap")' <<<"${policies}" >/dev/null; then
  aws iam delete-role-policy --role-name "${role_name}" --policy-name platform-finance-folio-kms-bootstrap
fi
observed_alias="$(alias_target)" || exit 1
[[ "${observed_alias}" == "${current}" ]] || { echo "Alias changed during import verification." >&2; exit 1; }
policies="$(aws iam list-role-policies --role-name "${role_name}" --output json)" || { echo "Cannot verify deploy-role cleanup." >&2; exit 1; }
jq -e --arg exact "platform-finance-folio-kms-${version}" '.PolicyNames | index($exact) and (index("platform-finance-folio-kms-bootstrap") | not)' <<<"${policies}" >/dev/null || { echo "Exact policy missing or broad bootstrap still attached." >&2; exit 1; }
state="$(jq -c '.phase="complete"' <<<"${state}")"
save_state "${state}"
printf 'Finance folio KMS %s ready: %s\nState: %s\n' "${version}" "${key_arn}" "${state_file}"
