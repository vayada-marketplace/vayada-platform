#!/usr/bin/env bash
set -euo pipefail

for command_name in aws base64 gzip jq; do
  command -v "${command_name}" >/dev/null || { echo "Required command not found: ${command_name}" >&2; exit 1; }
done

region="eu-west-1"
cluster="vayada-target-database-runtime-preflight"
service_cluster="vayada-backend-cluster"
service="vayada-next-api-service"
container="vayada-next-api"
family="vayada-next-api-db-runtime-preflight"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload="$(gzip -9 -c "${script_dir}/target-database-runtime-preflight.mjs" | base64 | tr -d '\n')"
bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-db-runtime-preflight.mjs';fs.writeFileSync(p,z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_CODE,'base64')));import(p).catch(()=>{console.error(JSON.stringify({status:'FAIL',code:'runtime_preflight_bootstrap_failed'}));process.exit(1)})"
overrides="$(jq -cn --arg bootstrap "${bootstrap}" --arg code "${payload}" --arg name "${container}" \
  '{containerOverrides:[{name:$name,command:["node","--eval",$bootstrap],environment:[{name:"VAYADA_DB_RUNTIME_PREFLIGHT_CODE",value:$code}]}]}')"
[[ "${#overrides}" -le 8192 ]] || { echo "ECS command override exceeds the 8192-byte limit." >&2; exit 1; }

current_task="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" \
  --query 'services[0].taskDefinition' --output text)"
source_definition="$(aws ecs describe-task-definition --task-definition "${current_task}" --region "${region}" \
  --query taskDefinition --output json)"
temporary_definition="$(jq -c --arg family "${family}" --arg container "${container}" '
  del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)
  | del(.taskRoleArn)
  | .family=$family
  | .containerDefinitions=[.containerDefinitions[]|select(.name==$container)
      | .secrets=[{name:"TARGET_DATABASE_URL",valueFrom:"/vayada/prod/target-database-runtime-url"}]
      | .environment=[]
      | .portMappings=[]]
' <<<"${source_definition}")"

registered_task=""
task_arn=""
cleanup() {
  if [[ -n "${task_arn}" ]]; then
    aws ecs stop-task --cluster "${cluster}" --task "${task_arn}" --region "${region}" \
      --reason "VAY-2017 runtime preflight cleanup" >/dev/null 2>&1 || true
  fi
  if [[ -n "${registered_task}" ]]; then
    aws ecs deregister-task-definition --task-definition "${registered_task}" --region "${region}" >/dev/null || true
  fi
}
trap cleanup EXIT
registered_task="$(aws ecs register-task-definition --cli-input-json "${temporary_definition}" --region "${region}" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"

network="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" \
  --query 'services[0].networkConfiguration' --output json)"
task_arn="$(aws ecs run-task --cluster "${cluster}" --task-definition "${registered_task}" --launch-type FARGATE \
  --network-configuration "${network}" --overrides "${overrides}" \
  --tags key=VayadaPurpose,value=target-db-runtime-preflight --region "${region}" \
  --query 'tasks[0].taskArn' --output text)"
[[ "${task_arn}" == arn:aws:ecs:*:task/* ]] || { echo "ECS did not return a runtime preflight task ARN." >&2; exit 1; }

stopped=false
for _ in {1..60}; do
  status="$(aws ecs describe-tasks --cluster "${cluster}" --tasks "${task_arn}" --region "${region}" \
    --query 'tasks[0].lastStatus' --output text)"
  if [[ "${status}" == "STOPPED" ]]; then
    stopped=true
    break
  fi
  sleep 5
done
[[ "${stopped}" == true ]] || { echo "Runtime preflight task exceeded five minutes." >&2; exit 1; }
task_id="${task_arn##*/}"
log_stream="ecs/${container}/${task_id}"
messages="[]"
for _ in {1..10}; do
  messages="$(aws logs get-log-events --log-group-name /ecs/vayada-next-api --log-stream-name "${log_stream}" \
    --start-from-head --region "${region}" --query 'events[].message' --output json 2>/dev/null || echo '[]')"
  jq -e 'any(.[]; fromjson? | .status == "PASS")' <<<"${messages}" >/dev/null && break
  sleep 2
done

task="$(aws ecs describe-tasks --cluster "${cluster}" --tasks "${task_arn}" --region "${region}" \
  --query 'tasks[0].{exitCode:containers[0].exitCode,reason:stoppedReason}' --output json)"
[[ "$(jq -r '.exitCode' <<<"${task}")" == "0" ]] || {
  echo "Runtime preflight task failed: $(jq -r '.reason' <<<"${task}")" >&2
  jq -r '.[] | fromjson? | select(.status == "FAIL") | .code' <<<"${messages}" >&2
  exit 1
}
result="$(jq -c '.[] | fromjson? | select(.status == "PASS")' <<<"${messages}")"
[[ -n "${result}" ]] || { echo "Runtime preflight exited without reporting PASS." >&2; exit 1; }
printf '%s\n' "${result}"
