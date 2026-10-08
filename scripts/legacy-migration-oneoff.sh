#!/usr/bin/env bash
# VAY-1362: run one allow-listed legacy migration CLI as a one-off production ECS task,
# from the operator's machine with the vayada AWS profile, and only after Flamur's
# explicit go for that exact step and input file. See docs/legacy-migration-oneoff.md.
set -euo pipefail

usage() {
  echo "Usage: legacy-migration-oneoff.sh <command> <run-file.json> <run-file-sha256> <confirmation>" >&2
  echo "       legacy-migration-oneoff.sh watch <task-arn>" >&2
  echo "       legacy-migration-oneoff.sh readonly-counts <counts.sql> READONLY_COUNTS:<counts.sql sha256>" >&2
  exit 2
}
[[ "$#" -ge 2 ]] || usage
command="$1"
evidence="${EVIDENCE_DIR:-}"
[[ -n "$evidence" && -d "$evidence" && "$(stat -f %Lp "$evidence" 2>/dev/null || stat -c %a "$evidence")" == 700 ]] || {
  echo "Set EVIDENCE_DIR to the run's 0700 evidence folder." >&2; exit 2;
}
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
account="269416271598"
region="eu-west-1"
cluster="vayada-target-database-runtime-preflight"
umask 077

aws_() { aws --profile vayada --region "$region" "$@"; }

require_profile() {
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE
  [[ "$(aws_ sts get-caller-identity --query Account --output text)" == "$account" ]] || {
    echo "The vayada profile must resolve to account ${account}." >&2; exit 1;
  }
}

# Follows a started task from its record in the evidence folder: waits, saves the log
# and exits with the task's exit code. Survives transient AWS errors; never stops a task.
follow_task() {
  local record="$1" task_arn log_group log_stream log_file state="" token="" page next stopped exit_code
  task_arn="$(jq -r .taskArn "$record")" log_group="$(jq -r .logGroup "$record")"
  log_stream="$(jq -r .logStream "$record")" log_file="$(jq -r .logFile "$record")"
  local deadline=$((SECONDS + 14400))
  while (( SECONDS < deadline )); do
    state="$(aws_ ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].lastStatus' --output text)" || {
      echo "AWS did not answer; retrying." >&2; sleep 15; continue;
    }
    [[ "$state" == STOPPED ]] && break
    sleep 15
  done
  [[ "$state" == STOPPED ]] || {
    echo "Task still running: ${task_arn}. Do not rerun the step; re-attach with: watch ${task_arn}" >&2; exit 1;
  }
  : > "$log_file"
  while :; do
    page="$(aws_ logs get-log-events --log-group-name "$log_group" --log-stream-name "$log_stream" \
      --start-from-head ${token:+--next-token "$token"} --output json)" || { echo "Task logs are unavailable." >&2; break; }
    jq -r '.events[].message' <<<"$page" | tee -a "$log_file"
    next="$(jq -r '.nextForwardToken' <<<"$page")"
    [[ -n "$next" && "$next" != "$token" ]] || break
    token="$next"
  done
  echo "Saved the task log to ${log_file}"
  stopped="$(aws_ ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0]' --output json)" || {
    echo "AWS did not answer; re-attach with: watch ${task_arn}" >&2; exit 1;
  }
  exit_code="$(jq -r '.containers[0].exitCode // empty' <<<"$stopped")"
  [[ "$exit_code" =~ ^[0-9]+$ ]] || { echo "Task stopped without an exit code: $(jq -r '.stoppedReason // "unknown"' <<<"$stopped")" >&2; exit 1; }
  echo "Task exit code: ${exit_code}"
  exit "$exit_code"
}

# Registers one disposable definition, runs it once, records the task in the evidence
# folder, follows it, then deregisters and deletes the definition (never affects the
# task). Call it last and never in an || or && list.
run_oneoff() {
  local definition="$1" network="$2" log_file="$3" registered started task_arn record
  [[ "$(printf '%s' "$definition" | wc -c | tr -d ' ')" -le 60000 ]] || { echo "The one-off task definition exceeds 60 KB." >&2; exit 2; }
  registered="$(aws_ ecs register-task-definition --cli-input-json "$definition" --query taskDefinition.taskDefinitionArn --output text)"
  trap "aws --profile vayada --region $region ecs deregister-task-definition --task-definition '$registered' >/dev/null 2>&1 || true
    aws --profile vayada --region $region ecs delete-task-definitions --task-definitions '$registered' >/dev/null 2>&1 || true" EXIT
  started="$(aws_ ecs run-task --cluster "$cluster" --task-definition "$registered" --launch-type FARGATE \
    --network-configuration "$network" --started-by vay1362-oneoff --output json)"
  task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$started")"
  [[ "$task_arn" =~ ^arn:aws:ecs:${region}:${account}:task/${cluster}/[0-9a-f]{32}$ ]] || {
    echo "ECS did not start the task: $(jq -c '.failures' <<<"$started")" >&2; exit 1;
  }
  record="${evidence}/task-${task_arn##*/}.json"
  jq -n --arg task "$task_arn" --arg file "$log_file" --argjson definition "$definition" '
    $definition.containerDefinitions[0] as $c
    | {taskArn: $task, logFile: $file, logGroup: $c.logConfiguration.options["awslogs-group"],
       logStream: "\($c.logConfiguration.options["awslogs-stream-prefix"])/\($c.name)/\($task | split("/") | last)"}' > "$record"
  echo "Started ${task_arn} (record: ${record})"
  follow_task "$record"
}

if [[ "$command" == watch ]]; then
  [[ "$#" -eq 2 && "$2" =~ ^arn:aws:ecs:${region}:${account}:task/${cluster}/([0-9a-f]{32})$ ]] || usage
  [[ -f "${evidence}/task-${BASH_REMATCH[1]}.json" ]] || { echo "No task record in the evidence folder." >&2; exit 2; }
  require_profile
  follow_task "${evidence}/task-${BASH_REMATCH[1]}.json"
fi

# Read-only counts: one copy of the running legacy pms-backend task (same image, execution
# role and only its PMS DB, Booking DB and Stripe secrets) runs scripts/legacy-readonly-counts.py.
if [[ "$command" == readonly-counts ]]; then
  [[ "$#" -eq 3 && -f "$2" ]] || usage
  [[ "$3" == "READONLY_COUNTS:$(shasum -a 256 "$2" | cut -d' ' -f1)" ]] || { echo "Confirmation must be READONLY_COUNTS:<sha256 of the SQL file>." >&2; exit 2; }
  python3 "$root/scripts/legacy-readonly-counts.py" --check "$2" || { echo "The SQL file must hold single read-only SELECT blocks." >&2; exit 2; }
  [[ ! -e "${evidence}/readonly-counts-result.md" ]] || { echo "readonly-counts-result.md already exists; move it first." >&2; exit 2; }
  require_profile
  [[ "$(aws_ ecs list-tasks --cluster "$cluster" --family vayada-legacy-readonly-counts --query 'length(taskArns)' --output text)" == 0 ]] || {
    echo "A counts task is still running." >&2; exit 1;
  }
  service="$(aws_ ecs describe-services --cluster vayada-backend-cluster --services vayada-pms-backend-service --query 'services[0]' --output json)"
  definition="$(aws_ ecs describe-task-definition --task-definition "$(jq -r .taskDefinition <<<"$service")" --query taskDefinition --output json |
    jq -c --rawfile code "$root/scripts/legacy-readonly-counts.py" --rawfile sql "$2" --arg region "$region" '
    . as $pms | [$pms.containerDefinitions[] | select(.name == "vayada-pms-backend")] as $containers
    | if ($containers | length) != 1 then error("pms-backend container missing") else $containers[0] end
    | {family: "vayada-legacy-readonly-counts", networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"],
       cpu: "256", memory: "512", executionRoleArn: $pms.executionRoleArn,
       containerDefinitions: [{name: "vayada-legacy-readonly-counts", image: .image, essential: true,
         entryPoint: ["python", "-c"], command: [$code], environment: [{name: "COUNTS_SQL", value: $sql}],
         secrets: [.secrets[] | select(.name == "DATABASE_URL" or .name == "BOOKING_ENGINE_DATABASE_URL" or .name == "STRIPE_SECRET_KEY")],
         logConfiguration: {logDriver: "awslogs", options: {"awslogs-group": "/ecs/vayada-pms-backend",
           "awslogs-region": $region, "awslogs-stream-prefix": "legacy-readonly-counts"}}}]}')"
  [[ "$(jq '.containerDefinitions[0].secrets | length' <<<"$definition")" == 3 ]] || { echo "pms-backend lacks one of the three secrets." >&2; exit 1; }
  run_oneoff "$definition" "$(jq -c .networkConfiguration <<<"$service")" "${evidence}/readonly-counts-result.md"
fi

[[ "$#" -eq 4 ]] || usage
input="$2" input_sha256="$3" confirmation="$4"
case "$command" in
  target:migration-status|target:cutover:abort) kind="target" ;;
  target:source:extract|target:cutover) kind="source" ;;
  *) echo "Command is not on the allow-list." >&2; exit 2 ;;
esac

# Migration commands: every input check runs before the first AWS call.
[[ -f "$input" ]] || { echo "Run file not found." >&2; exit 2; }
[[ "$(shasum -a 256 "$input" | cut -d' ' -f1)" == "$input_sha256" ]] || { echo "Run file SHA-256 differs from the approved one." >&2; exit 2; }
run_id="$(jq -er '.runId | select(type == "string" and test("^vay1360-[0-9a-f]{24}$"))' "$input")" || { echo "Run file needs a vay1360 runId." >&2; exit 2; }
source_run_id="$(jq -er '.sourceRunId | select(type == "string" and test("^vay1351-[0-9a-f]{24}$"))' "$input")" || {
  echo "Run file needs a vay1351 sourceRunId." >&2; exit 2;
}
pair="$(jq -er '"\(.sourceSha) \(.imageDigest)" | select(test("^[0-9a-f]{40} sha256:[0-9a-f]{64}$"))' "$input")" || {
  echo "Run file needs sourceSha and imageDigest." >&2; exit 2;
}
grep -Fxq -- "$pair" "$root/scripts/next-api-split-compatible-images.txt" || {
  echo "The image must be a reviewed pair in scripts/next-api-split-compatible-images.txt." >&2; exit 2;
}
case "$command" in
  target:migration-status) expected="MIGRATION_STATUS:${run_id}" ;;
  target:source:extract) expected="SOURCE_EXTRACT:${run_id}:${source_run_id}" ;;
  target:cutover) expected="PRODUCTION_CUTOVER:${run_id}:${source_run_id}" ;;
  target:cutover:abort) expected="ABORT_CUTOVER:${run_id}" ;;
esac
[[ "$confirmation" == "$expected" ]] || { echo "Confirmation must be exactly ${expected}." >&2; exit 2; }
# CLI arguments come only from the run file; this script adds the run ID, the
# confirmation (checked again by the CLI) and the JSON report format.
args="$(jq -ce --arg command "$command" --arg run "$run_id" --arg confirmation "$confirmation" '
  .args[$command] | select(type == "array" and all(.[]; type == "string"))
  | if $command == "target:source:extract" then .
    elif $command == "target:migration-status" then . + ["--run-id", $run, "--report", "json"]
    else . + ["--run-id", $run, "--confirmation", $confirmation, "--report", "json"] end' "$input")" || {
  echo "Run file has no string arguments for ${command}." >&2; exit 2;
}
jq -e '(.files // {}) | type == "object" and all(keys[]; test("^[a-z][a-z0-9-]{0,31}$"))' "$input" >/dev/null || {
  echo "Run file inputs must be an object of named JSON documents." >&2; exit 2;
}
files="$(jq -c '.files // {}' "$input" | gzip -n -9 | base64 | tr -d '\n')"

require_profile
for family in vayada-legacy-migration-oneoff-target vayada-legacy-migration-oneoff-source; do
  [[ "$(aws_ ecs list-tasks --cluster "$cluster" --family "$family" --query 'length(taskArns)' --output text)" == 0 ]] || {
    echo "A one-off migration task is still running. Inspect it before starting another." >&2; exit 1;
  }
done
service="$(aws_ ecs describe-services --cluster vayada-backend-cluster --services vayada-next-api-service --query 'services[0]' --output json)"
next_api="$(aws_ ecs describe-task-definition --task-definition "$(jq -r .taskDefinition <<<"$service")" --query taskDefinition --output json)"
media="$(jq -c '[.containerDefinitions[] | select(.name == "vayada-next-api") | .environment[]
  | select(.name == "PLATFORM_MEDIA_BUCKET" or .name == "PLATFORM_MEDIA_CDN_BASE_URL")]
  + [{name: "LEGACY_PMS_MEDIA_BUCKET", value: "vayada-uploads-prod"},
     {name: "LEGACY_MEDIA_BUCKET_ALLOWLIST", value: "vayada-uploads-prod,vayada-creator-marketplace-images"}]' <<<"$next_api")"
[[ "$(jq length <<<"$media")" == 4 ]] || { echo "next-api does not expose the platform media settings." >&2; exit 1; }
definition="$(jq -cn --arg kind "$kind" --arg command "$command" --arg args "$args" --arg files "$files" --argjson media "$media" \
  --arg image "${account}.dkr.ecr.${region}.amazonaws.com/vayada-next-api@${pair#* }" --arg account "$account" --arg region "$region" \
  --rawfile code "$root/scripts/legacy-migration-oneoff.mjs" '
  def ssm($name): "arn:aws:ssm:\($region):\($account):parameter/vayada/prod/\($name)";
  {family: "vayada-legacy-migration-oneoff-\($kind)", networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"],
   cpu: "1024", memory: "4096", executionRoleArn: "arn:aws:iam::\($account):role/ecsTaskExecutionRole",
   containerDefinitions: [{name: "vayada-legacy-migration-oneoff", image: $image, essential: true,
     entryPoint: ["node", "--input-type=module", "--eval"], command: [$code, $kind],
     environment: ([{name: "AWS_REGION", value: $region}, {name: "LEGACY_MIGRATION_COMMAND", value: $command},
       {name: "LEGACY_MIGRATION_ARGS", value: $args}, {name: "LEGACY_MIGRATION_FILES", value: $files}]
       + (if $kind == "source" then $media else [] end)),
     secrets: ([{name: "TARGET_DATABASE_URL", valueFrom: ssm("target-database-url")}]
       + (if $kind == "source" then [("auth", "booking", "marketplace", "pms")
           | {name: "\(ascii_upcase)_SOURCE_DATABASE_URL", valueFrom: ssm("legacy-migration-source-\(.)-url")}] else [] end)),
     logConfiguration: {logDriver: "awslogs", options: {"awslogs-group": "/ecs/vayada-next-api",
       "awslogs-region": $region, "awslogs-stream-prefix": "legacy-migration-oneoff"}}}]}
  + (if $kind == "source" then {taskRoleArn: "arn:aws:iam::\($account):role/vayada-next-api-media-task-role"} else {} end)')"
run_oneoff "$definition" "$(jq -c .networkConfiguration <<<"$service")" \
  "${evidence}/oneoff-${command//:/-}-${run_id}-$(date -u +%Y%m%dT%H%M%SZ).log"
