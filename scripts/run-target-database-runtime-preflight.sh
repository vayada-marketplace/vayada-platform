#!/usr/bin/env bash
set -euo pipefail

for command_name in aws base64 gzip jq; do
  command -v "${command_name}" >/dev/null || { echo "Required command not found: ${command_name}" >&2; exit 1; }
done

region="eu-west-1"
mode="${1:-preflight}"
ca_bundle=""
ca_payload=""
grant_scope=""
case "${mode}" in
  preflight)
    [[ "$#" -le 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    code_file="target-database-runtime-preflight.mjs"
    secret_name="TARGET_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-runtime-url"
    family="vayada-next-api-db-runtime-preflight"
    ;;
  --grant-product-audit-insert|--grant-affiliate-read|--grant-domain-events-append|--grant-jobs-insert)
    if [[ "${mode}" == "--grant-affiliate-read" ]]; then
      grant_scope="affiliate_read"
    elif [[ "${mode}" == "--grant-domain-events-append" ]]; then
      grant_scope="domain_events_append"
    elif [[ "${mode}" == "--grant-jobs-insert" ]]; then
      grant_scope="jobs_insert"
    else
      grant_scope="audit_insert"
    fi
    [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    for command_name in curl shasum; do
      command -v "${command_name}" >/dev/null || { echo "Required command not found: ${command_name}" >&2; exit 1; }
    done
    ca_bundle="$(curl -fsSL --connect-timeout 5 --max-time 15 \
      https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem)"
    ca_hash="$(printf '%s' "${ca_bundle}" | shasum -a 256 | cut -d ' ' -f 1)"
    [[ "${ca_hash}" == 0fdc44d91c5a69ef4efc3f9ede636ccc22b11a890c5a656a134275da26afa812 ]] || {
      echo "Amazon RDS CA bundle checksum mismatch." >&2; exit 1;
    }
    ca_payload="$(printf '%s' "${ca_bundle}" | gzip -9 -c | base64 | tr -d '\n')"
    code_file="grant-target-database-product-audit-insert.mjs"
    secret_name="TARGET_DATABASE_MIGRATION_URL"
    secret_parameter="/vayada/prod/target-database-url"
    family="vayada-next-api-db-runtime-preflight"
    ;;
  *) echo "Unknown mode: ${mode}" >&2; exit 2 ;;
esac
cluster="vayada-target-database-runtime-preflight"
service_cluster="vayada-backend-cluster"
service="vayada-next-api-service"
container="vayada-next-api"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload="$(gzip -9 -c "${script_dir}/${code_file}" | base64 | tr -d '\n')"
bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-db-runtime-preflight.mjs';if(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP)process.env.VAYADA_DB_RDS_CA_BUNDLE=z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP,'base64')).toString();fs.writeFileSync(p,z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_CODE,'base64')));import(p).catch(()=>{console.error(JSON.stringify({status:'FAIL',code:'runtime_preflight_bootstrap_failed'}));process.exit(1)})"
overrides="$(jq -cn --arg bootstrap "${bootstrap}" --arg code "${payload}" --arg name "${container}" \
  --arg ca "${ca_payload}" --arg scope "${grant_scope}" \
  '{containerOverrides:[{name:$name,command:["node","--eval",$bootstrap],
    environment:([{name:"VAYADA_DB_RUNTIME_PREFLIGHT_CODE",value:$code}] +
      (if $ca == "" then [] else [{name:"VAYADA_DB_RDS_CA_BUNDLE_GZIP",value:$ca}] end) +
      (if $scope == "" then [] else [{name:"VAYADA_DB_GRANT_SCOPE",value:$scope}] end))}]}')"
[[ "${#overrides}" -le 8192 ]] || { echo "ECS command override exceeds the 8192-byte limit." >&2; exit 1; }

current_task="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" \
  --query 'services[0].taskDefinition' --output text)"
source_definition="$(aws ecs describe-task-definition --task-definition "${current_task}" --region "${region}" \
  --query taskDefinition --output json)"
temporary_definition="$(jq -c --arg family "${family}" --arg container "${container}" \
  --arg secret_name "${secret_name}" --arg secret_parameter "${secret_parameter}" '
  del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)
  | del(.taskRoleArn)
  | .family=$family
  | .containerDefinitions=[.containerDefinitions[]|select(.name==$container)
      | .secrets=[{name:$secret_name,valueFrom:$secret_parameter}]
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
