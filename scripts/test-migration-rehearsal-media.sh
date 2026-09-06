#!/usr/bin/env bash
set -euo pipefail

# A shell-function stub prevents these regression tests from reaching AWS.
aws() {
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
      local actions=() resource='' role='' decision
      while (($#)); do
        case "$1" in
          --action-names) shift; while (($#)) && [[ "$1" != --* ]]; do actions+=("$1"); shift; done ;;
          --resource-arns) resource="$2"; shift 2 ;;
          --policy-source-arn) role="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      local bucket=vayada-migration-rehearsal-media-269416271598
      local expected_role=arn:aws:iam::269416271598:role/vayada-migration-rehearsal-media-task-role
      if [[ "${MOCK_FIXED:-false}" == true ]]; then
        bucket=vayada-rehearsal-2d1ef4ef-269416271598
        expected_role=arn:aws:iam::269416271598:role/vayada-rehearsal-2d1ef4ef-media
      fi
      [[ "$role" == "$expected_role" ]] || return 1
      decision=explicitDeny
      if [[ "$resource" == "arn:aws:s3:::${bucket}/public/media/"* || "$resource" == "arn:aws:s3:::${bucket}/private/media/"* ]]; then decision=allowed;
      elif [[ "${actions[0]}" == s3:ListBucket ]]; then decision=implicitDeny;
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
for mode in retained --fixed-release; do
export MOCK_FIXED=false
[[ "$mode" != --fixed-release ]] || export MOCK_FIXED=true
bash "$check" "$mode"
for fault in MOCK_ACCOUNT=wrong MOCK_BLOCKED=false MOCK_VERSIONING=Suspended \
  MOCK_ENCRYPTION=wrong MOCK_PRODUCTION_WRITE=true MOCK_MISSING=true MOCK_CONTEXT=true; do
  if env "$fault" bash "$check" "$mode" >/dev/null 2>&1; then
    echo "Isolation check accepted $fault" >&2; exit 1
  fi
done
done
if bash "$check" --unknown >/dev/null 2>&1 || bash "$check" retained extra >/dev/null 2>&1; then
  echo 'Isolation check accepted an unknown boundary' >&2; exit 1
fi
echo 'Both rehearsal media boundaries: valid fixtures, fourteen unsafe cases, and unknown-boundary refusals passed.'
