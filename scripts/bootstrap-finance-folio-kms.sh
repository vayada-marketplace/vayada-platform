#!/usr/bin/env bash
set -euo pipefail
umask 077

version="${1:?usage: bootstrap-finance-folio-kms.sh <vN> <state-file> [recipient|fingerprint]}"
state_file="${2:?usage: bootstrap-finance-folio-kms.sh <vN> <state-file> [recipient|fingerprint]}"
key_kind="${3:-recipient}"
[[ "${version}" =~ ^v[1-9][0-9]*$ ]] || { echo "Version must be vN with N >= 1." >&2; exit 2; }
[[ "${state_file}" = /* && ! -L "${state_file}" ]] || { echo "State file must be an absolute, non-symlink path." >&2; exit 2; }
[[ "${key_kind}" == recipient || "${key_kind}" == fingerprint ]] || { echo "Key kind must be recipient or fingerprint." >&2; exit 2; }
for command_name in aws jq mktemp terraform uuidgen; do command -v "${command_name}" >/dev/null || { echo "Missing ${command_name}." >&2; exit 2; }; done

account="269416271598"
region="eu-west-1"
role_name="vayada-github-actions-platform-deploy"
state_lineage="3c8d6f2b-d4c4-f0ac-3be0-2a6280d72fe0"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
if [[ "${key_kind}" == recipient ]]; then
  template="${repo_dir}/docs/finance-folio-kms-steady-state-policy.template.json"
  alias_name="alias/vayada/prod/finance-folio-recipient-current"
  version_map="finance_folio_recipient_kms_key_versions"
  current_local="finance_folio_recipient_kms_current_key_version"
  resource_name="finance_folio_recipient"
  name_prefix="vayada-finance-folio-recipient"
  purpose="finance-folio-recipient"
  description_prefix="Finance folio recipient"
  key_spec="SYMMETRIC_DEFAULT"
  key_usage="ENCRYPT_DECRYPT"
else
  template="${repo_dir}/docs/finance-folio-kms-fingerprint-steady-state-policy.template.json"
  alias_name=""
  version_map="finance_folio_recipient_fingerprint_key_versions"
  current_local="finance_folio_recipient_fingerprint_current_key_version"
  resource_name="finance_folio_recipient_fingerprint"
  name_prefix="vayada-finance-folio-recipient-fingerprint"
  purpose="finance-folio-recipient-fingerprint"
  description_prefix="Finance folio recipient fingerprint"
  key_spec="HMAC_256"
  key_usage="GENERATE_VERIFY_MAC"
fi
address="aws_kms_key.${resource_name}[\"${version}\"]"
expected_tags="$(jq -cn --arg version "${version}" --arg name "${name_prefix}" --arg purpose "${purpose}" '{Name:($name+"-"+$version),Project:"vayada",Environment:"production",Purpose:$purpose,Version:$version,ManagedBy:"terraform"}')"

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
declared="$(printf 'contains(keys(local.%s), "%s")\n' "${version_map}" "${version}" | terraform -chdir="${repo_dir}/infra" console -no-color | awk '$0=="true" || $0=="false" { value=$0; count++ } END { if (count==1) print value; else exit 1 }')"
[[ "${declared}" == true ]] || { echo "Declare ${version} in the Terraform version map before bootstrap; do not apply it." >&2; exit 1; }
current_version="$(printf 'local.%s\n' "${current_local}" | terraform -chdir="${repo_dir}/infra" console -no-color | awk '/^"[^"]*"$/ { value=substr($0,2,length($0)-2); count++ } END { if (count==1) print value; else exit 1 }')"
if [[ "${version}" == v1 ]]; then
  [[ "${current_version}" == v1 ]] || { echo "Initial bootstrap requires current v1." >&2; exit 1; }
else
  [[ "${current_version}" != "${version}" ]] || { echo "Rotation key cannot already be configured current." >&2; exit 1; }
  current_address="aws_kms_key.${resource_name}[\"${current_version}\"]"
  current_state="$(terraform -chdir="${repo_dir}/infra" state show -no-color "${current_address}")"
  managed_current_key_id="$(sed -n 's/^[[:space:]]*id[[:space:]]*=[[:space:]]*//p' <<<"${current_state}" | tr -d '"' | head -1)"
  [[ -n "${managed_current_key_id}" ]] || { echo "Terraform current key state mismatch." >&2; exit 1; }
  if [[ "${key_kind}" == recipient ]]; then
    alias_state="$(terraform -chdir="${repo_dir}/infra" state show -no-color aws_kms_alias.finance_folio_recipient_current)"
    managed_alias_target="$(sed -n 's/^[[:space:]]*target_key_id[[:space:]]*=[[:space:]]*//p' <<<"${alias_state}" | tr -d '"' | head -1)"
    grep -Fq "id = \"${alias_name}\"" <<<"${alias_state}"
    [[ "${managed_alias_target}" == "${managed_current_key_id}" ]] || { echo "Terraform current key/alias state mismatch." >&2; exit 1; }
  fi
fi

save_state() {
  local value="$1" temporary
  temporary="$(mktemp "${state_file}.tmp.XXXXXX")"
  printf '%s\n' "${value}" >"${temporary}"
  chmod 600 "${temporary}"
  mv "${temporary}" "${state_file}"
}
alias_target() {
  [[ -n "${alias_name}" ]] || return 0
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
  jq -e --arg v "${version}" --arg a "${account}" --arg r "${region}" --arg k "${key_kind}" '.schema==1 and .version==$v and .account==$a and .region==$r and (.kind//"recipient")==$k and (.bootstrapId|type=="string")' <<<"${state}" >/dev/null || { echo "State file contract mismatch." >&2; exit 1; }
else
  bootstrap_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  state="$(jq -cn --arg v "${version}" --arg a "${account}" --arg r "${region}" --arg b "${bootstrap_id}" --arg k "${key_kind}" '{schema:1,version:$v,kind:$k,account:$a,region:$r,bootstrapId:$b,phase:"unlocked"}')"
  save_state "${state}"
fi

bootstrap_id="$(jq -r .bootstrapId <<<"${state}")"
if [[ "${key_kind}" == recipient ]]; then
  lock_id="finance-folio-kms/${account}/${region}/${version}"
else
  lock_id="finance-folio-kms/${account}/${region}/${key_kind}/${version}"
fi
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
  if [[ "${key_kind}" == recipient ]]; then
    if [[ "${version}" == v1 ]]; then [[ -z "${before}" ]] || { echo "Refusing existing v1 alias state." >&2; exit 1; }
    else [[ "${before}" == "${managed_current_key_id}" ]] || { echo "Live alias is not the Terraform-managed current key." >&2; exit 1; }; fi
  fi
  state="$(jq -c --arg before "${before}" '.aliasTargetBefore=($before|if length>0 then . else null end) | .phase="planned"' <<<"${state}")"
  save_state "${state}"
fi

if [[ "${version}" != v1 && "${key_kind}" == recipient ]]; then
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
  aws kms create-key --region "${region}" --key-spec "${key_spec}" --key-usage "${key_usage}" --description "${description_prefix} ${version}; bootstrap=${bootstrap_id}" --tags "TagKey=Name,TagValue=${name_prefix}-${version}" TagKey=Project,TagValue=vayada TagKey=Environment,TagValue=production "TagKey=Purpose,TagValue=${purpose}" "TagKey=Version,TagValue=${version}" TagKey=ManagedBy,TagValue=terraform --output json >"${response_file}"
  key_id="$(jq -er .KeyMetadata.KeyId "${response_file}")"
fi
metadata="$(aws kms describe-key --region "${region}" --key-id "${key_id}" --output json)"
key_arn="$(jq -er .KeyMetadata.Arn <<<"${metadata}")"
state="$(jq -c --arg id "${key_id}" --arg arn "${key_arn}" '.keyId=$id | .keyArn=$arn | .phase="created"' <<<"${state}")"
save_state "${state}"
[[ ! -f "${state_file}.create.json" ]] || unlink "${state_file}.create.json"

jq -e --arg id "${key_id}" --arg arn "${key_arn}" --arg account "${account}" --arg region "${region}" --arg description "${description_prefix} ${version}; bootstrap=${bootstrap_id}" --arg spec "${key_spec}" --arg usage "${key_usage}" '
  .KeyMetadata | .KeyId==$id and .Arn==$arn and .AWSAccountId==$account and .KeyManager=="CUSTOMER" and
  .KeySpec==$spec and .KeyUsage==$usage and .Enabled==true and .KeyState=="Enabled" and
  .Description==$description and ($arn | startswith("arn:aws:kms:"+$region+":"+$account+":key/"))' <<<"${metadata}" >/dev/null || { echo "Created key metadata differs from the bootstrap contract." >&2; exit 1; }
tags="$(aws kms list-resource-tags --region "${region}" --key-id "${key_id}" --output json)"
jq -e --argjson expected "${expected_tags}" '(.Tags | map({key:.TagKey,value:.TagValue}) | from_entries) == $expected' <<<"${tags}" >/dev/null || { echo "Created key must have exactly the six reviewed tags." >&2; exit 1; }
if [[ "${key_kind}" == recipient ]]; then
  aws kms enable-key-rotation --region "${region}" --key-id "${key_id}"
  [[ "$(aws kms get-key-rotation-status --region "${region}" --key-id "${key_id}" --query KeyRotationEnabled --output text)" == True ]] || { echo "Key rotation is not enabled." >&2; exit 1; }
fi

before="$(jq -r '.aliasTargetBefore // empty' <<<"${state}")"
current="$(alias_target)" || exit 1
if [[ "${key_kind}" == recipient ]]; then
  if [[ "${version}" == v1 ]]; then
    if [[ -z "${current}" ]]; then aws kms create-alias --region "${region}" --alias-name "${alias_name}" --target-key-id "${key_id}"; current="$(alias_target)" || exit 1; fi
    [[ "${current}" == "${key_id}" ]] || { echo "Alias does not target the verified v1 key." >&2; exit 1; }
  else
    [[ -n "${before}" && "${current}" == "${before}" && "${current}" != "${key_id}" ]] || { echo "Rotation alias moved before validation." >&2; exit 1; }
  fi
fi

policy_file="${state_file}.policy.json"
[[ ! -L "${policy_file}" ]] || { echo "Policy output must not be a symlink." >&2; exit 1; }
jq --arg arn "${key_arn}" 'walk(if . == "arn:aws:kms:eu-west-1:269416271598:key/00000000-0000-0000-0000-000000000000" then $arn else . end)' "${template}" >"${policy_file}"
grep -Fq "${key_arn}" "${policy_file}" && ! grep -Fq '00000000-0000-0000-0000-000000000000' "${policy_file}" || { echo "Exact-ARN policy rendering failed." >&2; exit 1; }
policy_name="platform-finance-folio-kms-${key_kind}-${version}"
[[ "${key_kind}" != recipient ]] || policy_name="platform-finance-folio-kms-${version}"
aws iam put-role-policy --role-name "${role_name}" --policy-name "${policy_name}" --policy-document "file://${policy_file}"

if ! terraform -chdir="${repo_dir}/infra" state show -no-color "${address}" >/dev/null 2>&1; then terraform -chdir="${repo_dir}/infra" import "${address}" "${key_id}"; fi
imported_state="$(terraform -chdir="${repo_dir}/infra" state show -no-color "${address}")"
imported_key_id="$(sed -n 's/^[[:space:]]*id[[:space:]]*=[[:space:]]*//p' <<<"${imported_state}" | tr -d '"' | head -1)"
[[ "${imported_key_id}" == "${key_id}" ]] || { echo "Terraform key import verification failed." >&2; exit 1; }
if [[ "${version}" == v1 && "${key_kind}" == recipient ]]; then
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
jq -e --arg exact "${policy_name}" '.PolicyNames | index($exact) and (index("platform-finance-folio-kms-bootstrap") | not)' <<<"${policies}" >/dev/null || { echo "Exact policy missing or broad bootstrap still attached." >&2; exit 1; }
state="$(jq -c '.phase="complete"' <<<"${state}")"
save_state "${state}"
printf 'Finance folio KMS %s %s ready: %s\nState: %s\n' "${key_kind}" "${version}" "${key_arn}" "${state_file}"
