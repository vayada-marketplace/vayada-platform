#!/usr/bin/env bash
set -euo pipefail

for command_name in aws base64 gzip jq; do
  command -v "$command_name" >/dev/null || { echo "Required command not found: $command_name" >&2; exit 1; }
done

region="eu-west-1"
cluster="vayada-backend-cluster"
service="vayada-next-api-service"
container="vayada-next-api-finance-folio-recipient-inventory"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload="$(gzip -9 -c "${script_dir}/finance-folio-recipient-inventory.mjs" | base64 | tr -d '\n')"
bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-folio-recipient-inventory.mjs';fs.writeFileSync(p,z.gunzipSync(Buffer.from(process.env.VAYADA_FOLIO_RECIPIENT_INVENTORY_CODE,'base64')));import(p).catch(()=>{console.error(JSON.stringify({status:'FAIL',code:'folio_recipient_inventory_bootstrap_failed'}));process.exit(1)})"
overrides="$(jq -cn --arg bootstrap "$bootstrap" --arg code "$payload" --arg name "$container" \
  '{containerOverrides:[{name:$name,command:["node","--eval",$bootstrap],environment:[{name:"VAYADA_FOLIO_RECIPIENT_INVENTORY_CODE",value:$code}]}]}')"
if [ "${#overrides}" -gt 8192 ]; then
  echo "ECS command override exceeds the 8192-byte limit." >&2
  exit 1
fi

network="$(aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" \
  --query 'services[0].networkConfiguration' --output json)"
task_arn="$(aws ecs run-task \
  --cluster "$cluster" \
  --task-definition "$container" \
  --launch-type FARGATE \
  --network-configuration "$network" \
  --overrides "$overrides" \
  --region "$region" \
  --query 'tasks[0].taskArn' --output text)"
if [[ "$task_arn" != arn:aws:ecs:*:task/* ]]; then
  echo "ECS did not return an inventory task ARN." >&2
  exit 1
fi

echo "Started ${task_arn}"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn" --region "$region"
task_id="${task_arn##*/}"
log_stream="folio-recipient-inventory/${container}/${task_id}"
messages="[]"
for _ in {1..10}; do
  messages="$(aws logs get-log-events \
    --log-group-name /ecs/vayada-next-api --log-stream-name "$log_stream" \
    --start-from-head --region "$region" --query 'events[].message' --output json 2>/dev/null || echo '[]')"
  jq -e 'any(.[]; fromjson? | .status == "PASS")' <<<"$messages" >/dev/null && break
  sleep 2
done

task="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --region "$region" \
  --query 'tasks[0].{exitCode:containers[0].exitCode,reason:stoppedReason}' --output json)"
if [ "$(jq -r '.exitCode' <<<"$task")" != "0" ]; then
  echo "Inventory task failed: $(jq -r '.reason' <<<"$task")" >&2
  exit 1
fi
result="$(jq -c '.[] | fromjson? | select(.status == "PASS")' <<<"$messages")"
if [ -z "$result" ]; then
  echo "Inventory task exited without reporting PASS." >&2
  exit 1
fi
printf '%s\n' "$result"
