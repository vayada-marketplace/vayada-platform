#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Source-reader bootstrap failed; inspect its sanitized task status before any retry." >&2' ERR
readonly region=eu-west-1
readonly machine=arn:aws:states:eu-west-1:269416271598:stateMachine:vay2042-source-reader-bootstrap
for tool in aws jq; do command -v "$tool" >/dev/null; done
aws sts get-caller-identity --query Account --output text 2>/dev/null | grep -Fxq 269416271598
execution="$(aws stepfunctions start-execution --region "$region" --state-machine-arn "$machine" \
  --name "source-reader-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-local}" --input '{}' \
  --query executionArn --output text 2>/dev/null)"
[[ "$execution" == arn:aws:states:eu-west-1:269416271598:execution:vay2042-source-reader-bootstrap:* ]]
deadline=$((SECONDS + 1900))
status=RUNNING
while (( SECONDS < deadline )); do
  result="$(aws stepfunctions describe-execution --region "$region" --execution-arn "$execution" \
    --query '{status:status,output:output}' --output json 2>/dev/null)"
  status="$(jq -r '.status' <<<"$result")"
  case "$status" in
    SUCCEEDED) break ;;
    RUNNING) sleep 10 ;;
    *) false ;;
  esac
done
[[ "$status" == SUCCEEDED ]]
output="$(jq -er '.output | fromjson | select(.completion.exitCode == 0)' <<<"$result")"
task="$(jq -er '.result.taskArn' <<<"$output")"
[[ "$task" == arn:aws:ecs:eu-west-1:269416271598:task/vay2017-metadata-rehearsal/* ]]
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  events="$(aws logs get-log-events --region "$region" --log-group-name /aws/ecs/vay2042-source-reader-bootstrap \
    --log-stream-name "source-reader/source-reader-bootstrap/${task##*/}" --start-from-head \
    --query 'events[*].message' --output json 2>/dev/null || true)"
  if jq -e 'any(.[]? | fromjson?; . == {status:"OK",stage:"complete",scope:"isolated-source-reader",databases:4,tables:83})' <<<"${events:-[]}" >/dev/null 2>&1; then
    echo "Verified isolated source-reader bootstrap completed; extraction and run binding remain separate."
    exit 0
  fi
  sleep 5
done
false
