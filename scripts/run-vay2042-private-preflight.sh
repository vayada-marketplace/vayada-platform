#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Private preflight failed; inspect sanitized task status before any retry." >&2' ERR
readonly region=eu-west-1
readonly machine=arn:aws:states:eu-west-1:269416271598:stateMachine:vay2042-private-expiry-preflight
for tool in aws jq; do command -v "$tool" >/dev/null; done
aws sts get-caller-identity --query Account --output text 2>/dev/null | grep -Fxq 269416271598
execution="$(aws stepfunctions start-execution --region "$region" --state-machine-arn "$machine" \
  --name "preflight-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-local}" --input '{}' \
  --query executionArn --output text 2>/dev/null)"
[[ "$execution" == arn:aws:states:eu-west-1:269416271598:execution:vay2042-private-expiry-preflight:* ]]
deadline=$((SECONDS + 1900))
status=RUNNING
while (( SECONDS < deadline )); do
  result="$(aws stepfunctions describe-execution --region "$region" --execution-arn "$execution" \
    --query '{status:status,output:output}' --output json 2>/dev/null)"
  status="$(jq -r '.status' <<<"$result" 2>/dev/null)"
  case "$status" in
    SUCCEEDED) break ;;
    RUNNING) sleep 10 ;;
    *) false ;;
  esac
done
[[ "$status" == SUCCEEDED ]]
output="$(jq -er '.output | fromjson | select(.completion.exitCode == 0)' <<<"$result" 2>/dev/null)"
task="$(jq -er '.result.taskArn' <<<"$output" 2>/dev/null)"
[[ "$task" == arn:aws:ecs:eu-west-1:269416271598:task/vay2017-metadata-rehearsal/* ]]
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  events="$(aws logs get-log-events --region "$region" \
    --log-group-name /aws/ecs/vay2042-private-expiry-preflight \
    --log-stream-name "preflight/private-preflight/${task##*/}" --start-from-head \
    --query 'events[*].message' --output json 2>/dev/null || true)"
  if jq -e 'any(.[]? | fromjson?;
    .status == "OK" and .stage == "complete" and .scope == "isolated-catalog-preflight" and
    .databases == 10 and .tables == 83 and .bound == false and
    (.expiresAt | type == "string"))' <<<"${events:-[]}" >/dev/null 2>&1; then
    echo "Verified isolated catalog preflight and direct logins; target remains unbound."
    exit 0
  fi
  sleep 5
done
false
