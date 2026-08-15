#!/usr/bin/env bash

set -euo pipefail

usage="Usage: $0 [--cleanup <pi_test_payment_intent_id>]"
cleanup_payment_intent_id=""
if [ "$#" -eq 2 ] && [ "$1" = "--cleanup" ]; then
  cleanup_payment_intent_id="$2"
elif [ "$#" -ne 0 ]; then
  echo "$usage" >&2
  exit 2
fi
if [ -n "$cleanup_payment_intent_id" ] && [[ ! "$cleanup_payment_intent_id" =~ ^pi_[A-Za-z0-9]+$ ]]; then
  echo "Cleanup requires a PaymentIntent ID beginning with pi_." >&2
  exit 2
fi

for command_name in aws base64 gzip jq; do
  command -v "$command_name" >/dev/null || {
    echo "Required command not found: $command_name" >&2
    exit 1
  }
done

region="eu-west-1"
cluster="vayada-backend-cluster"
task_definition="vayada-next-api-stripe-test-smoke"
container="vayada-next-api-stripe-test-smoke"
service="vayada-next-api-service"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
smoke_payload="$(gzip -9 -c "${script_dir}/stripe-connect-smoke.mjs" | base64 | tr -d '\n')"
bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-stripe-smoke.mjs';fs.writeFileSync(p,z.gunzipSync(Buffer.from(process.env.VAYADA_STRIPE_SMOKE_CODE,'base64')));import(p).catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exit(1)})"
overrides="$(
  jq -cn \
    --arg bootstrap "$bootstrap" \
    --arg code "$smoke_payload" \
    --arg cleanup "$cleanup_payment_intent_id" \
    --arg name "$container" \
    '{containerOverrides:[{name:$name,command:["node","--eval",$bootstrap],environment:[{name:"VAYADA_STRIPE_SMOKE_CODE",value:$code},{name:"VAYADA_STRIPE_SMOKE_CLEANUP_PAYMENT_INTENT_ID",value:$cleanup}]}]}'
)"

if [ "${#overrides}" -gt 8192 ]; then
  echo "ECS command override exceeds the 8192-byte limit." >&2
  exit 1
fi

network_configuration="$(
  aws ecs describe-services \
    --cluster "$cluster" \
    --services "$service" \
    --region "$region" \
    --query 'services[0].networkConfiguration' \
    --output json
)"
task_arn="$(
  aws ecs run-task \
    --cluster "$cluster" \
    --task-definition "$task_definition" \
    --launch-type FARGATE \
    --network-configuration "$network_configuration" \
    --overrides "$overrides" \
    --region "$region" \
    --query 'tasks[0].taskArn' \
    --output text
)"
if [[ "$task_arn" != arn:aws:ecs:*:task/* ]]; then
  echo "ECS did not return a smoke task ARN." >&2
  exit 1
fi

echo "Started ${task_arn}"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn" --region "$region"

task_id="${task_arn##*/}"
log_stream="stripe-test-smoke/${container}/${task_id}"
messages=""
expected_status="PASS"
if [ -n "$cleanup_payment_intent_id" ]; then
  expected_status="CLEAN"
fi
terminal_status_found=false
for _ in {1..10}; do
  messages="$(
    aws logs get-log-events \
      --log-group-name /ecs/vayada-next-api \
      --log-stream-name "$log_stream" \
      --start-from-head \
      --region "$region" \
      --query 'events[].message' \
      --output json 2>/dev/null || true
  )"
  if jq -e --arg status "$expected_status" \
    'any(.[]; fromjson? | .status == $status)' <<<"${messages:-[]}" >/dev/null; then
    terminal_status_found=true
    break
  fi
  sleep 2
done
if [ "$(jq 'length' <<<"${messages:-[]}")" -eq 0 ]; then
  echo "Smoke task produced no CloudWatch output." >&2
  exit 1
fi
jq -r '.[]' <<<"$messages"

read -r exit_code stopped_reason < <(
  aws ecs describe-tasks \
    --cluster "$cluster" \
    --tasks "$task_arn" \
    --region "$region" \
    --query 'tasks[0].[containers[0].exitCode,stoppedReason]' \
    --output text
)
if [ "$exit_code" != "0" ]; then
  echo "Smoke task failed with exit code ${exit_code}: ${stopped_reason}" >&2
  exit 1
fi
if [ "$terminal_status_found" != true ]; then
  echo "Smoke task exited without reporting terminal status ${expected_status}." >&2
  exit 1
fi
