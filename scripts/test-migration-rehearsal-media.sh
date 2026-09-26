#!/usr/bin/env bash
set -euo pipefail

# A shell-function stub prevents these regression tests from reaching AWS.
aws() {
  if [[ "${MOCK_VAY2042:-false}" == true && "$1" == s3api ]]; then
    [[ "$3" == --bucket && "$4" == vayada-rehearsal-vay2042-20260926-269416271598 ]] || return 1
  fi
  case "$1 $2" in
    'sts get-caller-identity') echo "${MOCK_ACCOUNT:-269416271598}" ;;
    's3api get-public-access-block')
      jq -cn --argjson blocked "${MOCK_BLOCKED:-true}" \
        '{PublicAccessBlockConfiguration:{BlockPublicAcls:$blocked,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true}}' ;;
    's3api get-bucket-versioning') jq -cn --arg status "${MOCK_VERSIONING:-Enabled}" '{Status:$status}' ;;
    's3api get-bucket-encryption')
      jq -cn --arg algorithm "${MOCK_ENCRYPTION:-AES256}" \
        '{ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:$algorithm}}]}}' ;;
    'iam simulate-principal-policy')
      shift 2
      local actions=() resource='' role='' context_entry='' decision
      while (($#)); do
        case "$1" in
          --action-names) shift; while (($#)) && [[ "$1" != --* ]]; do actions+=("$1"); shift; done ;;
          --resource-arns) resource="$2"; shift 2 ;;
          --policy-source-arn) role="$2"; shift 2 ;;
          --context-entries) context_entry="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      local bucket=vayada-migration-rehearsal-media-269416271598
      local expected_role=arn:aws:iam::269416271598:role/vayada-migration-rehearsal-media-task-role
      if [[ "${MOCK_FIXED:-false}" == true ]]; then
        bucket=vayada-rehearsal-2d1ef4ef-269416271598
        expected_role=arn:aws:iam::269416271598:role/vayada-rehearsal-2d1ef4ef-media
      elif [[ "${MOCK_MIDNIGHT:-false}" == true ]]; then
        bucket=vayada-rehearsal-0118fd1f-269416271598
        expected_role=arn:aws:iam::269416271598:role/vayada-rehearsal-0118fd1f-media
      elif [[ "${MOCK_INBOX:-false}" == true ]]; then
        bucket=vayada-rehearsal-7200a43a-269416271598
        expected_role=arn:aws:iam::269416271598:role/vayada-rehearsal-7200a43a-media
      elif [[ "${MOCK_VAY2042:-false}" == true ]]; then
        bucket=vayada-rehearsal-vay2042-20260926-269416271598
        expected_role=arn:aws:iam::269416271598:role/vayada-rehearsal-vay2042-20260926-media
      fi
      [[ "$role" == "$expected_role" ]] || return 1
      decision=explicitDeny
      if [[ "${MOCK_VAY2042_CROSS_WRITE:-false}" == true && "$resource" == arn:aws:s3:::vayada-rehearsal-vay2042-20260926-269416271598/* ]]; then
        decision=allowed
      elif [[ "${MOCK_VAY2042:-false}" == true && "$resource" == "arn:aws:s3:::${bucket}/rehearsal-control/owner.json" && "${actions[0]}" == s3:GetObject ]]; then
        decision=implicitDeny
        [[ "${MOCK_OWNER_READ_ALLOWED:-false}" != true ]] || decision=allowed
      elif [[ "${MOCK_VAY2042:-false}" == true && "${actions[0]}" == s3:ListBucketVersions ]]; then
        decision=implicitDeny
        [[ "${MOCK_VERSION_LIST_ALLOWED:-false}" != true ]] || decision=allowed
      elif [[ "${MOCK_VAY2042:-false}" == true && "${actions[0]}" == s3:GetObjectVersion ]]; then
        decision=implicitDeny
        [[ "${MOCK_VERSION_ACCESS_ALLOWED:-false}" != true ]] || decision=allowed
      elif [[ "${MOCK_VAY2042:-false}" == true && "${actions[0]}" == s3:ListBucket ]]; then
        decision=implicitDeny
        [[ "${MOCK_BUCKET_LIST_ALLOWED:-false}" != true ]] || decision=allowed
      elif [[ "$resource" == "arn:aws:s3:::${bucket}/public/media/"* || "$resource" == "arn:aws:s3:::${bucket}/private/media/"* ]]; then decision=allowed;
      elif [[ "${MOCK_OWNER_READ_DENIED:-false}" == true && "$resource" == "arn:aws:s3:::${bucket}/rehearsal-control/owner.json" ]]; then decision=explicitDeny;
      elif [[ "${MOCK_VERSION_LIST_DENIED:-false}" == true && "${actions[0]}" == s3:ListBucketVersions ]]; then decision=explicitDeny;
      elif [[ "${actions[0]}" == s3:ListBucket ]]; then decision=implicitDeny;
      elif [[ "${actions[0]}" == s3:ListBucketVersions && "${MOCK_INBOX:-false}" == true ]]; then
        if [[ "${MOCK_VERSION_PREFIX_LEAK:-false}" == true || "$context_entry" == *'ContextKeyValues=rehearsal-control/owner.json'* ]]; then
          decision=allowed
        else
          decision=implicitDeny
        fi
      elif [[ "${actions[0]}" == s3:ListBucketVersions ]]; then decision=allowed;
      elif [[ "${actions[0]}" == s3:GetObject ]]; then decision=allowed;
      elif [[ "${MOCK_PRODUCTION_WRITE:-false}" == true ]]; then decision=allowed; fi
      jq -cn --arg decision "$decision" --argjson count "${#actions[@]}" \
        --argjson missing "${MOCK_MISSING:-false}" --argjson context "${MOCK_CONTEXT:-false}" \
        '{EvaluationResults:[range(0; if $missing then 0 else $count end)|{EvalDecision:$decision,MissingContextValues:(if $context then ["unknown"] else [] end)}]}' ;;
    *) echo 'Unexpected AWS command in read-only check' >&2; return 1 ;;
  esac
}
export -f aws
check=scripts/check-migration-rehearsal-media.sh
for mode in retained --fixed-release --midnight-release --inbox-release --vay2042; do
export MOCK_FIXED=false
export MOCK_MIDNIGHT=false
export MOCK_INBOX=false
export MOCK_VAY2042=false
[[ "$mode" != --fixed-release ]] || export MOCK_FIXED=true
[[ "$mode" != --midnight-release ]] || export MOCK_MIDNIGHT=true
[[ "$mode" != --inbox-release ]] || export MOCK_INBOX=true
[[ "$mode" != --vay2042 ]] || export MOCK_VAY2042=true
bash "$check" "$mode"
faults=(MOCK_ACCOUNT=wrong MOCK_BLOCKED=false MOCK_VERSIONING=Suspended \
  MOCK_ENCRYPTION=wrong MOCK_PRODUCTION_WRITE=true MOCK_MISSING=true MOCK_CONTEXT=true)
if [[ "$mode" != retained && "$mode" != --vay2042 ]]; then
  faults+=(MOCK_OWNER_READ_DENIED=true MOCK_VERSION_LIST_DENIED=true)
fi
if [[ "$mode" == --inbox-release ]]; then
  faults+=(MOCK_VERSION_PREFIX_LEAK=true)
fi
if [[ "$mode" == --vay2042 ]]; then
  faults+=(MOCK_OWNER_READ_ALLOWED=true MOCK_VERSION_LIST_ALLOWED=true \
    MOCK_VERSION_ACCESS_ALLOWED=true MOCK_BUCKET_LIST_ALLOWED=true)
else
  faults+=(MOCK_VAY2042_CROSS_WRITE=true)
fi
for fault in "${faults[@]}"; do
  if env "$fault" bash "$check" "$mode" >/dev/null 2>&1; then
    echo "Isolation check accepted $fault" >&2; exit 1
  fi
done
done
if bash "$check" --unknown >/dev/null 2>&1 || bash "$check" retained extra >/dev/null 2>&1; then
  echo 'Isolation check accepted an unknown boundary' >&2; exit 1
fi
echo 'All five rehearsal media boundaries: valid fixtures, fifty unsafe cases, and unknown-boundary refusals passed.'
