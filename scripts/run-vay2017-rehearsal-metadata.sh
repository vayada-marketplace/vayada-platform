#!/usr/bin/env bash
set -euo pipefail

readonly region="eu-west-1"
readonly account="269416271598"
readonly machine_arn="arn:aws:states:eu-west-1:269416271598:stateMachine:vay2017-metadata-inventory"
readonly snapshot="vay2017-legacy-source-freeze-20260920"
readonly restore="vay2017-legacy-rehearsal-20260921"
readonly restore_event_id="6c80019b-26bd-460c-8750-5a950bf48441"
readonly restore_event_time="2026-09-20T16:19:33Z"
readonly restore_resource_id="db-MHCPB2UKUGKW6FLKDBQC4RQWJQ"
readonly restore_instance_arn="arn:aws:rds:eu-west-1:269416271598:db:vay2017-legacy-rehearsal-20260921"
readonly image_digest="sha256:a6f1001b1713e5f86e52cf757b3e67c794ec936639273dc041cedc7b95ea7b3c"
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly attestation_file="$script_dir/fixtures/vay2017-restore-attestation.json"
readonly attestation_checksum="$(shasum -a 256 "$attestation_file" | awk '{print $1}')"
readonly scanner_source_checksum="$(shasum -a 256 "$(dirname "$0")/vay2017-rehearsal-metadata.mjs" | awk '{print $1}')"
readonly artifact_path="${ARTIFACT_PATH:-migration-inventory.json}"

for tool in aws jq shasum awk; do
  command -v "$tool" >/dev/null || { echo "Required command unavailable: $tool" >&2; exit 1; }
done
aws sts get-caller-identity --query Account --output text | grep -Fxq "$account" || {
  echo "Refusing: AWS account is not the reviewed rehearsal account." >&2
  exit 1
}
execution_name="vay2017-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-local}"
execution_arn="$(aws stepfunctions start-execution --region "$region" --state-machine-arn "$machine_arn" \
  --name "$execution_name" --input '{}' --query executionArn --output text)" || {
  echo "Could not start the fixed metadata inventory." >&2
  exit 1
}

deadline=$((SECONDS + 900))
execution_status="RUNNING"
execution_output=""
while (( SECONDS < deadline )); do
  execution="$(aws stepfunctions describe-execution --region "$region" --execution-arn "$execution_arn" \
    --query '{status:status,output:output}' --output json 2>/dev/null)" || {
    echo "Could not read metadata inventory execution status." >&2
    exit 1
  }
  execution_status="$(jq -r '.status' <<<"$execution")"
  execution_output="$(jq -r '.output // empty' <<<"$execution")"
  case "$execution_status" in
    SUCCEEDED) break ;;
    FAILED|TIMED_OUT|ABORTED) echo "Metadata inventory execution failed with status $execution_status." >&2; exit 1 ;;
    RUNNING) sleep 10 ;;
    *) echo "Metadata inventory returned an unexpected execution state." >&2; exit 1 ;;
  esac
done
[[ "$execution_status" == "SUCCEEDED" ]] || { echo "Metadata inventory exceeded its 15-minute limit." >&2; exit 1; }

task_arn="$(jq -er 'fromjson | .result.taskArn | select(type == "string")' <<<"$execution_output")" || {
  echo "Metadata inventory completed without returning the fixed ECS task identity." >&2
  exit 1
}
[[ "$task_arn" == arn:aws:ecs:eu-west-1:269416271598:task/vay2017-metadata-rehearsal/* ]] || {
  echo "Metadata inventory returned an unexpected ECS task identity." >&2
  exit 1
}
task_id="${task_arn##*/}"
log_stream="vay2017-metadata/metadata-runner/$task_id"

deadline=$((SECONDS + 120))
artifact_line=""
while (( SECONDS < deadline )); do
  events="$(aws logs get-log-events --region "$region" --log-group-name /aws/ecs/vay2017-metadata-runner \
    --log-stream-name "$log_stream" --start-from-head --query 'events[*].message' --output json 2>/dev/null || true)"
  artifact_line="$(jq -r '[.[]? | select(startswith("VAY2017_METADATA_ARTIFACT="))][0] // empty' <<<"${events:-[]}")"
  [[ -n "$artifact_line" ]] && break
  sleep 5
done
[[ "$artifact_line" == VAY2017_METADATA_ARTIFACT=* ]] || {
  echo "The task did not emit a sanitized metadata artifact." >&2
  exit 1
}
artifact_json="${artifact_line#VAY2017_METADATA_ARTIFACT=}"
jq -e --arg snapshot "$snapshot" --arg restore "$restore" --arg digest "$image_digest" --arg source_checksum "$scanner_source_checksum" \
  --arg event_id "$restore_event_id" --arg event_time "$restore_event_time" --arg resource_id "$restore_resource_id" \
  --arg instance_arn "$restore_instance_arn" --arg attestation_checksum "$attestation_checksum" '
  .artifactVersion == 1 and
  .sourceSnapshotId == $snapshot and
  .restoreInstanceId == $restore and
  .restoreEventId == $event_id and
  .restoreEventTime == $event_time and
  .restoreResourceId == $resource_id and
  .restoreInstanceArn == $instance_arn and
  .restoreAttestationChecksum == $attestation_checksum and
  .imageDigest == $digest and
  .scannerSourceChecksum == $source_checksum and
  (.queryChecksum | test("^[a-f0-9]{64}$")) and
  (.schemaFingerprint | test("^[a-f0-9]{64}$")) and
  .databases as $databases |
  ($databases | type == "array") and
  (([$databases[].tables[].rowCount | select(type == "string" and test("^[0-9]+$"))] | length) == ([$databases[].tables[]] | length)) and
  (keys | sort == ["artifactVersion","collectedAt","databases","imageDigest","queryChecksum","queryVersion","restoreAttestationChecksum","restoreEventId","restoreEventTime","restoreInstanceArn","restoreInstanceId","restoreResourceId","rowCountSemantics","scannerSourceChecksum","schemaFingerprint","sourceSnapshotId"])
' <<<"$artifact_json" >/dev/null || {
  echo "The metadata artifact failed identity or content validation." >&2
  exit 1
}
printf '%s\n' "$artifact_json" | jq -c . >"$artifact_path"
chmod 600 "$artifact_path"
echo "Verified sanitized VAY-2017 inventory artifact written to $artifact_path."
