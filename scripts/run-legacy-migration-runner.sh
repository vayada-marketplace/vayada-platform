#!/usr/bin/env bash
# VAY-1362: launch one allow-listed legacy migration CLI as a one-off ECS task.
# Every check below runs before the first AWS call. See docs/legacy-migration-runner.md.
set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch &&
   "${GITHUB_REPOSITORY:-}" == vayada-marketplace/vayada-platform ]] || { echo "Runs only from the reviewed workflow on main." >&2; exit 2; }
[[ "$#" -eq 4 ]] || { echo "Usage: run-legacy-migration-runner.sh <command> <image-digest> <run-id> <confirmation>" >&2; exit 2; }
command="$1" digest="$2" run_id="$3" confirmation="$4"
region="eu-west-1"
cluster="vayada-legacy-migration-runner"
container="vayada-legacy-migration-runner"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$command" in
  target:migration-status|target:cutover:abort) kind="target" ;;
  target:source:extract|target:cutover:dry-run|target:cutover) kind="source" ;;
  *) echo "Command is not on the allow-list." >&2; exit 2 ;;
esac
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ && "$digest" == "$(jq -r .image_digest "$root/deployment/legacy-migration-runner.json")" ]] || {
  echo "Image digest must equal the pinned runner image in deployment/legacy-migration-runner.json." >&2; exit 2;
}
[[ "$run_id" =~ ^vay1360-[0-9a-f]{24}$ ]] || { echo "Run ID must be a vay1360 cutover run ID." >&2; exit 2; }
run_file="$root/deployment/legacy-migration-runs/${run_id}.json"
[[ -f "$run_file" ]] || { echo "No reviewed run file deployment/legacy-migration-runs/${run_id}.json on main." >&2; exit 2; }
source_run_id="$(jq -er --arg run "$run_id" 'select(.runId == $run) | .sourceRunId | select(test("^vay1351-[0-9a-f]{24}$"))' "$run_file")" || {
  echo "Run file must carry this runId and a vay1351 sourceRunId." >&2; exit 2;
}
case "$command" in
  target:migration-status) expected="MIGRATION_STATUS:${run_id}" ;;
  target:source:extract) expected="SOURCE_EXTRACT:${run_id}:${source_run_id}" ;;
  target:cutover:dry-run) expected="CUTOVER_DRY_RUN:${run_id}:${source_run_id}" ;;
  target:cutover) expected="PRODUCTION_CUTOVER:${run_id}:${source_run_id}" ;;
  target:cutover:abort) expected="ABORT_CUTOVER:${run_id}" ;;
esac
[[ "$confirmation" == "$expected" ]] || { echo "Confirmation must be exactly ${expected}." >&2; exit 2; }

# CLI arguments come only from the reviewed run file. This script adds the run ID,
# the confirmation (checked again by the CLI) and the JSON report format.
args="$(jq -ce --arg command "$command" --arg run "$run_id" --arg confirmation "$confirmation" '
  .args[$command] | select(type == "array" and all(.[]; type == "string"))
  | if $command == "target:source:extract" then .
    elif $command == "target:migration-status" then . + ["--run-id", $run, "--report", "json"]
    else . + ["--run-id", $run, "--confirmation", $confirmation, "--report", "json"] end' "$run_file")" || {
  echo "Run file has no reviewed string arguments for ${command}." >&2; exit 2;
}
files='{}'
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "Invalid run file input name." >&2; exit 2; }
  encoded="$(jq -c --arg name "$name" '.files[$name]' "$run_file" | gzip -n -9 | base64 | tr -d '\n')"
  files="$(jq -c --arg name "$name" --arg value "$encoded" '. + {($name): $value}' <<<"$files")"
done < <(jq -r '.files // {} | keys[]' "$run_file")
overrides="$(jq -cn --arg name "$container" --arg command "$command" --arg args "$args" --arg files "$files" '
  {containerOverrides: [{name: $name, environment: [
    {name: "LEGACY_MIGRATION_COMMAND", value: $command},
    {name: "LEGACY_MIGRATION_ARGS", value: $args},
    {name: "LEGACY_MIGRATION_FILES", value: $files}]}]}')"
[[ "${#overrides}" -le 8192 ]] || { echo "Run inputs exceed the 8192-byte ECS override limit." >&2; exit 2; }

# Run only the Terraform-registered revision with the pinned image and the reviewed dispatcher.
definition="$(aws ecs describe-task-definition --task-definition "${container}-${kind}" --region "$region" --query taskDefinition --output json)"
image="269416271598.dkr.ecr.${region}.amazonaws.com/vayada-next-api@${digest}"
jq -e --arg image "$image" --arg kind "$kind" --arg name "$container" --rawfile code "$root/scripts/legacy-migration-runner.mjs" '
  .status == "ACTIVE" and (.containerDefinitions | length) == 1 and .containerDefinitions[0].name == $name and
  .containerDefinitions[0].image == $image and .containerDefinitions[0].command == ["node", "--input-type=module", "--eval", $code, $kind]
' <<<"$definition" >/dev/null || { echo "Registered ${container}-${kind} does not match the pinned image and dispatcher." >&2; exit 1; }
network="$(aws ecs describe-services --cluster vayada-backend-cluster --services vayada-next-api-service --region "$region" \
  --query 'services[0].networkConfiguration' --output json)"
task_arn="$(aws ecs run-task --cluster "$cluster" --task-definition "$(jq -r .taskDefinitionArn <<<"$definition")" --launch-type FARGATE \
  --network-configuration "$network" --overrides "$overrides" --started-by "github-${GITHUB_RUN_ID:-manual}" --region "$region" \
  --query 'tasks[0].taskArn' --output text)"
[[ "$task_arn" =~ ^arn:aws:ecs:${region}:269416271598:task/${cluster}/[0-9a-f]{32}$ ]] || { echo "ECS did not start the task." >&2; exit 1; }
echo "Started ${task_arn}"

# A cutover can take about an hour. Never stop or rerun it from here: on timeout,
# inspect the task and the run ledger (target:migration-status) first.
for ((poll = 0; poll < 900; poll++)); do
  state="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --region "$region" --query 'tasks[0].lastStatus' --output text)"
  [[ "$state" == STOPPED ]] && break
  sleep 10
done
[[ "$state" == STOPPED ]] || { echo "Task is still running after 150 minutes: ${task_arn}. Do not rerun; inspect it first." >&2; exit 1; }
aws logs get-log-events --log-group-name "/ecs/${container}" --log-stream-name "ecs/${container}/${task_arn##*/}" \
  --start-from-head --region "$region" --query 'events[].message' --output json | jq -r '.[]' || echo "Task logs are unavailable." >&2
exit_code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --region "$region" --query 'tasks[0].containers[0].exitCode' --output text)"
[[ "$exit_code" =~ ^[0-9]+$ ]] || { echo "Task stopped without an exit code." >&2; exit 1; }
echo "Task exit code: ${exit_code}"
exit "$exit_code"
