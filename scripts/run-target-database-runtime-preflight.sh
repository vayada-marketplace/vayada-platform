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
ca_required=false
extra_secret_name=""
extra_secret_parameter=""
provision_scope=""
finance_property=""
case "${mode}" in
  preflight)
    [[ "$#" -le 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    code_file="target-database-runtime-preflight.mjs"
    secret_name="TARGET_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-runtime-url"
    family="vayada-next-api-db-runtime-preflight"
    ;;
  --grant-product-audit-insert|--grant-affiliate-read|--grant-domain-events-append|--grant-jobs-insert|--grant-expense-category-insert)
    ca_required=true
    if [[ "${mode}" == "--grant-affiliate-read" ]]; then
      grant_scope="affiliate_read"
    elif [[ "${mode}" == "--grant-domain-events-append" ]]; then
      grant_scope="domain_events_append"
    elif [[ "${mode}" == "--grant-jobs-insert" ]]; then
      grant_scope="jobs_insert"
    elif [[ "${mode}" == "--grant-expense-category-insert" ]]; then
      grant_scope="expense_category_insert"
    else
      grant_scope="audit_insert"
    fi
    [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    code_file="grant-target-database-product-audit-insert.mjs"
    secret_name="TARGET_DATABASE_MIGRATION_URL"
    secret_parameter="/vayada/prod/target-database-url"
    family="vayada-next-api-db-runtime-preflight"
    ;;
  --provision-finance-expense-worker|--grant-finance-expense-worker|--preflight-finance-expense-worker)
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="finance-expense-worker-database.mjs"
    secret_name="FINANCE_EXPENSE_WORKER_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-finance-expense-worker-url"
    if [[ "${mode}" == "--provision-finance-expense-worker" ]]; then
      [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
      code_file="provision-target-database-identity-runtime.mjs"
      provision_scope="finance_expense"
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
      extra_secret_name="FINANCE_EXPENSE_WORKER_DATABASE_URL"
      extra_secret_parameter="/vayada/prod/target-database-finance-expense-worker-url"
    else
      [[ "$#" -eq 2 && "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
        echo "Finance grant/preflight requires the reviewed property UUID." >&2; exit 2;
      }
      finance_property="$2"
      if [[ "${mode}" == "--grant-finance-expense-worker" ]]; then
        grant_scope="finance_expense"
        secret_name="TARGET_DATABASE_MIGRATION_URL"
        secret_parameter="/vayada/prod/target-database-url"
      fi
    fi
    ;;
  --provision-identity-role|--grant-identity-runtime|--inspect-identity-role|--inspect-cluster-database-acl|--harden-cluster-database-acl)
    [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    ca_required=true
    secret_name="TARGET_DATABASE_MIGRATION_URL"
    secret_parameter="/vayada/prod/target-database-url"
    family="vayada-next-api-db-runtime-preflight"
    if [[ "${mode}" == "--provision-identity-role" ]]; then
      code_file="provision-target-database-identity-runtime.mjs"
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
      extra_secret_name="IDENTITY_DATABASE_URL"
      extra_secret_parameter="/vayada/prod/target-database-identity-runtime-url"
    elif [[ "${mode}" == "--inspect-cluster-database-acl" || "${mode}" == "--harden-cluster-database-acl" ]]; then
      if [[ "${mode}" == "--inspect-cluster-database-acl" ]]; then
        code_file="inspect-target-database-cluster-acl.mjs"
      else
        code_file="harden-target-database-cluster-acl.mjs"
      fi
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
    elif [[ "${mode}" == "--inspect-identity-role" ]]; then
      code_file="inspect-target-database-identity-role.mjs"
    else
      code_file="grant-target-database-identity-runtime.mjs"
    fi
    ;;
  *) echo "Unknown mode: ${mode}" >&2; exit 2 ;;
esac
if [[ "${ca_required}" == true ]]; then
  for command_name in curl shasum; do
    command -v "${command_name}" >/dev/null || { echo "Required command not found: ${command_name}" >&2; exit 1; }
  done
  ca_bundle="$(curl -fsSL --connect-timeout 5 --max-time 15 \
    https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem)"
  ca_hash="$(printf '%s' "${ca_bundle}" | shasum -a 256 | cut -d ' ' -f 1)"
  [[ "${ca_hash}" == 0fdc44d91c5a69ef4efc3f9ede636ccc22b11a890c5a656a134275da26afa812 ]] || {
    echo "Amazon RDS CA bundle checksum mismatch." >&2; exit 1;
  }
  if [[ "${mode}" == "--grant-identity-runtime" || "${mode}" == "--grant-expense-category-insert" || "${mode}" == "--grant-affiliate-read" || "${mode}" == "--harden-cluster-database-acl" || "${mode}" == *finance-expense-worker ]]; then
    command -v node >/dev/null || { echo "Required command not found: node" >&2; exit 1; }
    # This one-time grant targets the RDS instance's pinned RSA2048 G1 CA.
    # Pass only that root: the complete regional bundle exceeds ECS's 8192-byte override limit.
    ca_bundle="${ca_bundle%%-----END CERTIFICATE-----*}-----END CERTIFICATE-----"
    ca_fingerprint="$(printf '%s' "${ca_bundle}" | node -e '
      const { X509Certificate } = require("node:crypto");
      let input = "";
      process.stdin.on("data", (part) => input += part);
      process.stdin.on("end", () => console.log(new X509Certificate(input).fingerprint256));
    ')"
    [[ "${ca_fingerprint}" == "6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86" ]] || {
      echo "Pinned grant CA fingerprint mismatch." >&2; exit 1;
    }
  fi
  ca_payload="$(printf '%s' "${ca_bundle}" | gzip -9 -c | base64 | tr -d '\n')"
  if [[ ( "${mode}" == "--grant-identity-runtime" || "${mode}" == "--grant-expense-category-insert" || "${mode}" == "--grant-affiliate-read" || "${mode}" == "--harden-cluster-database-acl" ) && "${#ca_payload}" -gt 2100 ]]; then
    echo "Pinned grant CA payload exceeds the reviewed ECS override budget." >&2; exit 1
  fi
fi
cluster="vayada-target-database-runtime-preflight"
service_cluster="vayada-backend-cluster"
service="vayada-next-api-service"
container="vayada-next-api"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload="$(gzip -9 -c "${script_dir}/${code_file}" | base64 | tr -d '\n')"
bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-db-runtime-preflight.mjs';if(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP)process.env.VAYADA_DB_RDS_CA_BUNDLE=z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP,'base64')).toString();fs.writeFileSync(p,z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_CODE,'base64')));import(p).catch(()=>{console.error(JSON.stringify({status:'FAIL',code:'runtime_preflight_bootstrap_failed'}));process.exit(1)})"
overrides="$(jq -cn --arg bootstrap "${bootstrap}" --arg code "${payload}" --arg name "${container}" \
  --arg ca "${ca_payload}" --arg scope "${grant_scope}" --arg provision_scope "${provision_scope}" --arg finance_property "${finance_property}" \
  '{containerOverrides:[{name:$name,command:["node","--eval",$bootstrap],
    environment:([{name:"VAYADA_DB_RUNTIME_PREFLIGHT_CODE",value:$code}] +
      (if $ca == "" then [] else [{name:"VAYADA_DB_RDS_CA_BUNDLE_GZIP",value:$ca}] end) +
      (if $scope == "" then [] else [{name:"VAYADA_DB_GRANT_SCOPE",value:$scope}] end) +
      (if $provision_scope == "" then [] else [{name:"VAYADA_DB_PROVISION_SCOPE",value:$provision_scope}] end) +
      (if $finance_property == "" then [] else [{name:"FINANCE_EXPENSE_WORKER_PROPERTY_ID",value:$finance_property}] end))}]}')"
[[ "${#overrides}" -le 8192 ]] || { echo "ECS command override exceeds the 8192-byte limit." >&2; exit 1; }

current_task="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" \
  --query 'services[0].taskDefinition' --output text)"
source_definition="$(aws ecs describe-task-definition --task-definition "${current_task}" --region "${region}" \
  --query taskDefinition --output json)"
temporary_definition="$(jq -c --arg family "${family}" --arg container "${container}" \
  --arg secret_name "${secret_name}" --arg secret_parameter "${secret_parameter}" \
  --arg extra_secret_name "${extra_secret_name}" --arg extra_secret_parameter "${extra_secret_parameter}" '
  del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)
  | del(.taskRoleArn)
  | .family=$family
  | .containerDefinitions=[.containerDefinitions[]|select(.name==$container)
      | .secrets=[{name:$secret_name,valueFrom:$secret_parameter}]
      | if $extra_secret_name == "" then . else .secrets += [{name:$extra_secret_name,valueFrom:$extra_secret_parameter}] end
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
