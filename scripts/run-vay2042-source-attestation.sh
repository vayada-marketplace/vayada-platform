#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Source binding stopped; inspect all four isolated databases before any retry." >&2' ERR
readonly region=eu-west-1
readonly machine=arn:aws:states:eu-west-1:269416271598:stateMachine:vay2042-source-attestation
readonly proof=acf9fb92b78057919ea92b947533fe458fdc1efc40d54db232e45b19933e0eda
for tool in aws jq shasum; do command -v "$tool" >/dev/null; done
aws sts get-caller-identity --query Account --output text 2>/dev/null | grep -Fxq 269416271598
[[ "$(shasum -a 256 docs/vay2042-source-preservation-proof-20261001.json | cut -d' ' -f1)" == "$proof" ]]
instance="$(aws rds describe-db-instances --region "$region" \
  --db-instance-identifier vay2017-metadata-rehearsal-isolated-20260923 \
  --query 'DBInstances[0]' --output json 2>/dev/null)"
jq -e '.DBInstanceIdentifier == "vay2017-metadata-rehearsal-isolated-20260923" and
  .DbiResourceId == "db-BB7GOFQ3BQTLTBG444I2Q75X6Y" and .DBInstanceStatus == "available" and
  .Engine == "postgres" and .EngineVersion == "17.9" and .PubliclyAccessible == false and
  .StorageEncrypted == true and .MultiAZ == false and
  .DBSubnetGroup.DBSubnetGroupName == "vay2017-metadata-isolated-restore" and
  .DBSubnetGroup.VpcId == "vpc-03f7231a783250e37" and
  [.VpcSecurityGroups[].VpcSecurityGroupId] == ["sg-06ce28a79d9694a4a"]' \
  <<<"$instance" >/dev/null
snapshot="$(aws rds describe-db-snapshots --region "$region" \
  --db-snapshot-identifier vay2017-legacy-source-freeze-20260920 \
  --query 'DBSnapshots[0]' --output json 2>/dev/null)"
jq -e '.DBSnapshotArn == "arn:aws:rds:eu-west-1:269416271598:snapshot:vay2017-legacy-source-freeze-20260920" and
  .DBInstanceIdentifier == "vayada-database" and .Status == "available" and .Encrypted == true' \
  <<<"$snapshot" >/dev/null
previous="$(aws stepfunctions list-executions --region "$region" --state-machine-arn "$machine" \
  --query 'executions[*].executionArn' --output json 2>/dev/null)"
jq -e 'length == 0' <<<"$previous" >/dev/null
execution="$(aws stepfunctions start-execution --region "$region" --state-machine-arn "$machine" \
  --name "bind-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:?}" --input '{}' \
  --query executionArn --output text 2>/dev/null)"
[[ "$execution" == arn:aws:states:eu-west-1:269416271598:execution:vay2042-source-attestation:* ]]
deadline=$((SECONDS + 1800))
status=RUNNING
while (( SECONDS < deadline )); do
  result="$(aws stepfunctions describe-execution --region "$region" --execution-arn "$execution" \
    --query '{status:status,output:output}' --output json 2>/dev/null)"
  status="$(jq -r '.status' <<<"$result")"
  case "$status" in SUCCEEDED) break ;; RUNNING) sleep 10 ;; *) false ;; esac
done
[[ "$status" == SUCCEEDED ]]
task="$(jq -er '.output | fromjson | select(.completion.exitCode == 0) | .result.taskArn' <<<"$result")"
[[ "$task" == arn:aws:ecs:eu-west-1:269416271598:task/vay2017-metadata-rehearsal/* ]]
events="$(aws logs get-log-events --region "$region" \
  --log-group-name /aws/ecs/vay2042-private-expiry-preflight \
  --log-stream-name "attest/source-attestation/${task##*/}" --start-from-head \
  --query 'events[*].message' --output json 2>/dev/null)"
jq -e --arg proof "$proof" 'any(.[] | fromjson?;
  .status == "OK" and .scope == "isolated-source-attestation" and
  .databases == 4 and .tables == 83 and .proofSha256 == $proof)' <<<"$events" >/dev/null
echo "Bound and read back four isolated source attestations; proof SHA-256: $proof"
