#!/usr/bin/env bash
set -euo pipefail

readonly account="269416271598"
readonly region="eu-west-1"
readonly state_machine_arn="arn:aws:states:eu-west-1:269416271598:stateMachine:vay2017-metadata-reader-bootstrap"
readonly log_group="/aws/ecs/vay2017-metadata-runner"

for tool in aws jq grep; do
  command -v "$tool" >/dev/null || { echo "Required command unavailable: $tool" >&2; exit 1; }
done
aws sts get-caller-identity --query Account --output text | grep -Fxq "$account" || {
  echo "Refusing: AWS account is not the reviewed rehearsal account." >&2
  exit 1
}

execution_name="vay2017-reader-bootstrap-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-local}"
execution_arn="$(aws stepfunctions start-execution --region "$region" --state-machine-arn "$state_machine_arn" \
  --name "$execution_name" --input '{}' --query executionArn --output text)" || {
  echo "Could not start the fixed metadata-reader bootstrap." >&2
  exit 1
}

deadline=$((SECONDS + 1800))
execution_status="RUNNING"
execution_output=""
while (( SECONDS < deadline )); do
  execution="$(aws stepfunctions describe-execution --region "$region" --execution-arn "$execution_arn" \
    --query '{status:status,output:output}' --output json 2>/dev/null)" || {
    echo "Could not read metadata-reader bootstrap status." >&2
    exit 1
  }
  execution_status="$(jq -r '.status' <<<"$execution")"
  execution_output="$(jq -r '.output // empty' <<<"$execution")"
  case "$execution_status" in
    SUCCEEDED) break ;;
    FAILED|TIMED_OUT|ABORTED) echo "Metadata-reader bootstrap orchestration ended with status $execution_status." >&2; exit 1 ;;
    RUNNING) sleep 10 ;;
    *) echo "Metadata-reader bootstrap returned an unexpected execution state." >&2; exit 1 ;;
  esac
done
[[ "$execution_status" == "SUCCEEDED" ]] || { echo "Metadata-reader bootstrap exceeded its 30-minute limit." >&2; exit 1; }

task_arn="$(jq -er '.result.taskArn | select(type == "string")' <<<"$execution_output")" || {
  echo "Bootstrap completed without returning the fixed ECS task identity." >&2
  exit 1
}
[[ "$task_arn" == arn:aws:ecs:eu-west-1:269416271598:task/vay2017-metadata-rehearsal/* ]] || {
  echo "Bootstrap returned an unexpected ECS task identity." >&2
  exit 1
}
task_id="${task_arn##*/}"
container_exit_code="$(jq -r '.completion.containerExitCode // empty' <<<"$execution_output")"
log_stream="vay2017-metadata-bootstrap/metadata-reader-bootstrap/$task_id"

deadline=$((SECONDS + 120))
status_line=""
while (( SECONDS < deadline )); do
  events="$(aws logs get-log-events --region "$region" --log-group-name "$log_group" \
    --log-stream-name "$log_stream" --start-from-head --query 'events[*].message' --output json 2>/dev/null || true)"
  status_line="$(jq -r '[.[]? | fromjson? | select((.status == "OK" and .stage == "complete") or .status == "FAIL") | {status,stage,code,errorClass}][0] // empty' <<<"${events:-[]}")"
  [[ -n "$status_line" ]] && break
  sleep 5
done
[[ -n "$status_line" ]] || { echo "Bootstrap emitted no sanitized status." >&2; exit 1; }
if jq -e '.status == "OK" and .stage == "complete"' <<<"$status_line" >/dev/null; then
  [[ "$container_exit_code" == "0" ]] || { echo "Bootstrap status was successful but the task exit code was not zero." >&2; exit 1; }
  echo "Verified isolated metadata-reader provisioning succeeded."
else
  safe_error="$(jq -r '[.stage,.code,.errorClass] | @tsv' <<<"$status_line")"
  echo "Metadata-reader provisioning failed (stage/code/class: $safe_error)." >&2
  exit 1
fi
