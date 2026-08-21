#!/usr/bin/env bash
set -euo pipefail

test_dir="$(mktemp -d /tmp/vayada-kms-bootstrap-test.XXXXXX)"
case "${test_dir}" in /tmp/vayada-kms-bootstrap-test.*) ;; *) exit 1 ;; esac
cleanup() { find "${test_dir}" -type f -delete; rmdir "${test_dir}"; }
trap cleanup EXIT
export MOCK_DIR="${test_dir}" MOCK_LOG="${test_dir}/commands.log" TMPDIR="${test_dir}"
export TF_VAR_db_master_password=x TF_VAR_db_booking_password=x TF_VAR_db_pms_password=x TF_VAR_db_auth_password=x TF_VAR_jwt_secret_key=x
key_id="11111111-2222-3333-4444-555555555555"
key_arn="arn:aws:kms:eu-west-1:269416271598:key/${key_id}"
export MOCK_KEY_ID="${key_id}" MOCK_KEY_ARN="${key_arn}"

aws() {
  printf '%s\n' "$*" >>"${MOCK_LOG}"
  [[ "$*" != *'condition-expression '*' Owner '* ]] || return 1
  case "$1 $2 $3" in
    'configure get region') echo eu-west-1 ;;
    'sts get-caller-identity --region') echo '{"Account":"269416271598","Arn":"arn:aws:iam::269416271598:user/reviewer"}' ;;
    'kms list-keys --region') [[ "${MOCK_DISCOVERY_FAIL:-}" != 1 ]] || return 1; [[ -f "${MOCK_DIR}/created" ]] && echo "${MOCK_KEY_ID}" || echo None ;;
    'kms describe-key --region')
      if [[ -f "${MOCK_BOOTSTRAP_STATE}" ]]; then marker="$(jq -r .bootstrapId "${MOCK_BOOTSTRAP_STATE}")" version="$(jq -r .version "${MOCK_BOOTSTRAP_STATE}")"; else marker=orphan version=v1; fi
      jq -cn --arg id "${MOCK_KEY_ID}" --arg arn "${MOCK_KEY_ARN}" --arg description "Finance folio recipient ${version}; bootstrap=${marker}" '{KeyMetadata:{KeyId:$id,Arn:$arn,AWSAccountId:"269416271598",KeyManager:"CUSTOMER",KeySpec:"SYMMETRIC_DEFAULT",KeyUsage:"ENCRYPT_DECRYPT",Enabled:true,KeyState:"Enabled",Description:$description}}'
      ;;
    'kms list-resource-tags --region')
      version="$(jq -r '.version // "v1"' "${MOCK_BOOTSTRAP_STATE}" 2>/dev/null || echo v1)"
      jq -cn --arg version "${version}" '{Tags:[{TagKey:"Name",TagValue:("vayada-finance-folio-recipient-"+$version)},{TagKey:"Project",TagValue:"vayada"},{TagKey:"Environment",TagValue:"production"},{TagKey:"Purpose",TagValue:"finance-folio-recipient"},{TagKey:"Version",TagValue:$version},{TagKey:"ManagedBy",TagValue:"terraform"}]}'
      ;;
    'kms list-aliases --region') [[ "$(grep -c '^kms list-aliases ' "${MOCK_LOG}")" != "${MOCK_ALIAS_FAIL_ON:-0}" ]] || return 1; [[ -f "${MOCK_DIR}/alias" ]] && cat "${MOCK_DIR}/alias" || echo None ;;
    'kms create-key --region') : >"${MOCK_DIR}/created"; jq -cn --arg id "${MOCK_KEY_ID}" '{KeyMetadata:{KeyId:$id}}' ;;
    'kms enable-key-rotation --region') : ;;
    'kms get-key-rotation-status --region') echo True ;;
    'kms create-alias --region') printf '%s\n' "${MOCK_KEY_ID}" >"${MOCK_DIR}/alias" ;;
    'iam put-role-policy --role-name') : >"${MOCK_DIR}/exact-policy" ;;
    'iam list-role-policies --role-name')
      [[ "${MOCK_IAM_LIST_FAIL:-}" != 1 ]] || return 1
      policies=(); [[ -f "${MOCK_DIR}/exact-policy" ]] && policies+=("platform-finance-folio-kms-$(jq -r .version "${MOCK_BOOTSTRAP_STATE}")"); [[ -f "${MOCK_DIR}/broad-policy" ]] && policies+=(platform-finance-folio-kms-bootstrap)
      printf '%s\n' "$(printf '%s\n' "${policies[@]}" | jq -Rsc 'split("\n")[:-1] | {PolicyNames:.}')"
      ;;
    'iam delete-role-policy --role-name') unlink "${MOCK_DIR}/broad-policy" ;;
    'dynamodb put-item --region')
      while [[ "$1" != --item ]]; do shift; done; owner="$(jq -r .Owner.S <<<"$2")"; created=0
      if mkdir "${MOCK_DIR}/cloud-lock" 2>/dev/null; then printf '%s\n' "${owner}" >"${MOCK_DIR}/cloud-lock/owner"; created=1
      elif [[ "$(cat "${MOCK_DIR}/cloud-lock/owner")" == "${owner}" || "${MOCK_LOCK_EXPIRED:-}" == 1 ]]; then printf '%s\n' "${owner}" >"${MOCK_DIR}/cloud-lock/owner"
      else return 1; fi
      [[ "${MOCK_HOLD_LOCK:-}" != 1 || "${created}" == 0 ]] || sleep 1
      ;;
    'dynamodb delete-item --region') unlink "${MOCK_DIR}/cloud-lock/owner"; rmdir "${MOCK_DIR}/cloud-lock" ;;
    *) echo "Unexpected aws call: $*" >&2; return 1 ;;
  esac
}
terraform() {
  printf 'terraform %s\n' "$*" >>"${MOCK_LOG}"
  case "$*" in
    *' init -reconfigure '*) [[ "${MOCK_BACKEND_FAIL:-}" != 1 ]] ;;
    *' workspace show') echo "${MOCK_WORKSPACE:-default}" ;;
    *' state pull') jq -cn --arg lineage "${MOCK_LINEAGE:-3c8d6f2b-d4c4-f0ac-3be0-2a6280d72fe0}" '{lineage:$lineage}' ;;
    *' console -no-color') read -r expression; [[ "${expression}" == contains* ]] && echo true || printf '"%s"\n' "${MOCK_CURRENT_VERSION:-v1}" ;;
    *' state show -no-color aws_kms_key.'*)
      if [[ "$*" == *"[\"${MOCK_CURRENT_VERSION:-v1}\"]"* && -n "${MOCK_MANAGED_CURRENT_ID:-}" ]]; then printf '  id = %s\n' "${MOCK_MANAGED_CURRENT_ID}"; else [[ -f "${MOCK_DIR}/key-imported" ]] || return 1; printf '  id = %s\n' "${MOCK_KEY_ID}"; fi
      ;;
    *' state show -no-color aws_kms_alias.'*)
      [[ -f "${MOCK_DIR}/alias-imported" || -n "${MOCK_MANAGED_CURRENT_ID:-}" ]] || return 1
      printf '  id = "alias/vayada/prod/finance-folio-recipient-current"\n  target_key_id = "%s"\n' "${MOCK_TERRAFORM_ALIAS_TARGET:-$(cat "${MOCK_DIR}/alias")}"
      ;;
    *' import aws_kms_key.'*) : >"${MOCK_DIR}/key-imported" ;;
    *' import aws_kms_alias.'*) : >"${MOCK_DIR}/alias-imported" ;;
    *) echo "Unexpected terraform call: $*" >&2; return 1 ;;
  esac
}
export -f aws terraform

state="${test_dir}/bootstrap.json"
export MOCK_BOOTSTRAP_STATE="${state}"
bash scripts/bootstrap-finance-folio-kms.sh v1 "${state}" >/dev/null
jq -e --arg id "${key_id}" '.phase=="complete" and .keyId==$id' "${state}" >/dev/null || { jq . "${state}"; exit 1; }
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == 1 ]]
for tag in Name Project Environment Purpose Version ManagedBy; do grep -Fq "TagKey=${tag}," "${MOCK_LOG}"; done
grep -Fq "aws_kms_key.finance_folio_recipient[\"v1\"] ${key_id}" "${MOCK_LOG}"
grep -Fq "aws_kms_alias.finance_folio_recipient_current alias/vayada/prod/finance-folio-recipient-current" "${MOCK_LOG}"
bash scripts/bootstrap-finance-folio-kms.sh v1 "${state}" >/dev/null
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == 1 ]]

find "${test_dir}" -type f ! -name commands.log -delete
recovery_state="${test_dir}/recovery.json"
export MOCK_BOOTSTRAP_STATE="${recovery_state}"
printf '%s\n' '{"schema":1,"version":"v1","account":"269416271598","region":"eu-west-1","bootstrapId":"recover-me","aliasTargetBefore":null,"phase":"creating"}' >"${recovery_state}"
: >"${MOCK_DIR}/created"
bash scripts/bootstrap-finance-folio-kms.sh v1 "${recovery_state}" >/dev/null
jq -e --arg id "${key_id}" '.phase=="complete" and .keyId==$id' "${recovery_state}" >/dev/null || { jq . "${recovery_state}"; exit 1; }
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == 1 ]]

find "${test_dir}" -type f ! -name commands.log -delete
: >"${MOCK_DIR}/created"
export MOCK_BOOTSTRAP_STATE="${test_dir}/missing.json"
if bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "Unowned matching key was accepted." >&2; exit 1; fi
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == 1 ]]
echo "bootstrap creation, resume, and ambiguity checks passed"

alias_creates_before="$(grep -c '^kms create-alias ' "${MOCK_LOG}")"
find "${test_dir}" -type f ! -name commands.log -delete
printf '%s\n' 00000000-0000-0000-0000-000000000000 >"${MOCK_DIR}/alias"
export MOCK_CURRENT_VERSION=v1 MOCK_MANAGED_CURRENT_ID=00000000-0000-0000-0000-000000000000
rotation_state="${test_dir}/rotation.json"
export MOCK_BOOTSTRAP_STATE="${rotation_state}"
bash scripts/bootstrap-finance-folio-kms.sh v2 "${rotation_state}" >/dev/null
jq -e '.phase=="complete" and .aliasTargetBefore=="00000000-0000-0000-0000-000000000000"' "${rotation_state}" >/dev/null
[[ "$(cat "${MOCK_DIR}/alias")" == 00000000-0000-0000-0000-000000000000 ]]
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == 2 && "$(grep -c '^kms create-alias ' "${MOCK_LOG}")" == "${alias_creates_before}" ]]
echo "rotation bootstrap preserved the current alias"
unset MOCK_CURRENT_VERSION MOCK_MANAGED_CURRENT_ID
creates_before="$(grep -c '^kms create-key ' "${MOCK_LOG}")"
for failure in backend workspace lineage; do
  find "${test_dir}" -type f ! -name commands.log -delete
  export MOCK_BOOTSTRAP_STATE="${test_dir}/${failure}.json"
  case "${failure}" in backend) export MOCK_BACKEND_FAIL=1 ;; workspace) export MOCK_WORKSPACE=preview ;; lineage) export MOCK_LINEAGE=wrong ;; esac
  if bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "Wrong Terraform ${failure} was accepted." >&2; exit 1; fi
  unset MOCK_BACKEND_FAIL MOCK_WORKSPACE MOCK_LINEAGE
done
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == "${creates_before}" ]]
find "${test_dir}" -type f ! -name commands.log -delete
export MOCK_DISCOVERY_FAIL=1 MOCK_BOOTSTRAP_STATE="${test_dir}/discovery.json"
if bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "Failed discovery reached CreateKey." >&2; exit 1; fi
unset MOCK_DISCOVERY_FAIL
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == "${creates_before}" ]]
find "${test_dir}" -type f ! -name commands.log -delete
printf '%s\n' '{"schema":1,"version":"v1","account":"269416271598","region":"eu-west-1","bootstrapId":"shared","phase":"unlocked"}' >"${test_dir}/concurrent-a.json"
cp "${test_dir}/concurrent-a.json" "${test_dir}/concurrent-b.json"
MOCK_HOLD_LOCK=1 MOCK_BOOTSTRAP_STATE="${test_dir}/concurrent-a.json" bash scripts/bootstrap-finance-folio-kms.sh v1 "${test_dir}/concurrent-a.json" >/dev/null & lock_pid=$!
for _ in {1..100}; do [[ -d "${MOCK_DIR}/cloud-lock" ]] && break; sleep .01; done
export MOCK_BOOTSTRAP_STATE="${test_dir}/concurrent-b.json"
if bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "Concurrent bootstrap lease was ignored." >&2; exit 1; fi
wait "${lock_pid}"
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == "$((creates_before + 1))" ]]
creates_before="$((creates_before + 1))"
find "${test_dir}" -type f ! -name commands.log -delete
mkdir "${MOCK_DIR}/cloud-lock"; printf '%s\n' crashed-session >"${MOCK_DIR}/cloud-lock/owner"
export MOCK_LOCK_EXPIRED=1 MOCK_BOOTSTRAP_STATE="${test_dir}/expired-lock.json"
bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null
unset MOCK_LOCK_EXPIRED
creates_before="$((creates_before + 1))"
find "${test_dir}" -type f ! -name commands.log -delete
export MOCK_ALIAS_FAIL_ON="$(( $(grep -c '^kms list-aliases ' "${MOCK_LOG}") + 2 ))" MOCK_BOOTSTRAP_STATE="${test_dir}/alias-read.json"
if bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "Failed second alias lookup reached CreateKey." >&2; exit 1; fi
unset MOCK_ALIAS_FAIL_ON
[[ "$(grep -c '^kms create-key ' "${MOCK_LOG}")" == "${creates_before}" ]]
find "${test_dir}" -type f ! -name commands.log -delete
: >"${MOCK_DIR}/broad-policy"
export MOCK_IAM_LIST_FAIL=1 MOCK_BOOTSTRAP_STATE="${test_dir}/iam-cleanup.json"
if bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "IAM verification failure marked complete." >&2; exit 1; fi
unset MOCK_IAM_LIST_FAIL
[[ "$(jq -r .phase "${MOCK_BOOTSTRAP_STATE}")" != complete && -f "${MOCK_DIR}/broad-policy" ]]
bash scripts/bootstrap-finance-folio-kms.sh v1 "${MOCK_BOOTSTRAP_STATE}" >/dev/null
[[ "$(jq -r .phase "${MOCK_BOOTSTRAP_STATE}")" == complete && ! -f "${MOCK_DIR}/broad-policy" ]]
find "${test_dir}" -type f ! -name commands.log -delete
export MOCK_CURRENT_VERSION=v2 MOCK_BOOTSTRAP_STATE="${test_dir}/premature-current.json"
if bash scripts/bootstrap-finance-folio-kms.sh v2 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "Premature current rotation was accepted." >&2; exit 1; fi
export MOCK_CURRENT_VERSION=v1 MOCK_MANAGED_CURRENT_ID=00000000-0000-0000-0000-000000000000 MOCK_TERRAFORM_ALIAS_TARGET=00000000-0000-0000-0000-000000000000 MOCK_BOOTSTRAP_STATE="${test_dir}/wrong-alias.json"
printf '%s\n' aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee >"${MOCK_DIR}/alias"
if bash scripts/bootstrap-finance-folio-kms.sh v2 "${MOCK_BOOTSTRAP_STATE}" >/dev/null 2>&1; then echo "Unmanaged rotation alias was accepted." >&2; exit 1; fi
if aws dynamodb put-item --condition-expression 'Owner = :owner' >/dev/null 2>&1; then echo "Mock accepted a reserved expression name." >&2; exit 1; fi
grep -Fq 'LeaseUntil < :now' "${MOCK_LOG}" && grep -Fq 'condition-expression #owner = :owner' "${MOCK_LOG}"
echo "backend, state, discovery, lock, cleanup, and rotation failures closed"
