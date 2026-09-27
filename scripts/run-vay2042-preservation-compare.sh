#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Preservation comparison failed; inspect sanitized task status before any retry." >&2' ERR
readonly region=eu-west-1
readonly machine=arn:aws:states:eu-west-1:269416271598:stateMachine:vay2042-source-preservation-compare
for tool in aws jq; do command -v "$tool" >/dev/null; done
aws sts get-caller-identity --query Account --output text 2>/dev/null | grep -Fxq 269416271598
check_instance() {
  local name="$1" resource="$2" state
  state="$(aws rds describe-db-instances --region "$region" --db-instance-identifier "$name" \
    --query 'DBInstances[0]' --output json 2>/dev/null)"
  jq -e --arg name "$name" --arg resource "$resource" '
    .DBInstanceIdentifier == $name and .DbiResourceId == $resource and
    .DBInstanceStatus == "available" and .Engine == "postgres" and .EngineVersion == "17.9" and
    .PubliclyAccessible == false and .StorageEncrypted == true and .MultiAZ == false and
    .DBSubnetGroup.DBSubnetGroupName == "vay2017-metadata-isolated-restore" and
    .DBSubnetGroup.VpcId == "vpc-03f7231a783250e37" and
    [.VpcSecurityGroups[].VpcSecurityGroupId] == ["sg-06ce28a79d9694a4a"]' \
    <<<"$state" >/dev/null
}
check_instance vay2017-metadata-rehearsal-isolated-20260923 db-BB7GOFQ3BQTLTBG444I2Q75X6Y
check_instance vay2042-preservation-control-20260927 db-KWO2HSCRBXNV75OK7LNIBZN7TQ
snapshot="$(aws rds describe-db-snapshots --region "$region" \
  --db-snapshot-identifier vay2017-legacy-source-freeze-20260920 \
  --query 'DBSnapshots[0]' --output json 2>/dev/null)"
jq -e '.DBSnapshotArn == "arn:aws:rds:eu-west-1:269416271598:snapshot:vay2017-legacy-source-freeze-20260920" and
  .DBInstanceIdentifier == "vayada-database" and .Status == "available" and .Encrypted == true' \
  <<<"$snapshot" >/dev/null
restore_events="$(aws cloudtrail lookup-events --region "$region" \
  --lookup-attributes AttributeKey=EventName,AttributeValue=RestoreDBInstanceFromDBSnapshot \
  --start-time 2026-09-27T03:20:00Z --end-time 2026-09-27T03:30:00Z \
  --query 'Events[*].CloudTrailEvent' --output json 2>/dev/null)"
jq -e 'any(.[] | fromjson;
  .eventID == "7781e4d4-0024-4baa-85ea-0ec293175d8b" and .errorCode == null and
  .awsRegion == "eu-west-1" and .recipientAccountId == "269416271598" and
  .requestParameters.dBInstanceIdentifier == "vay2042-preservation-control-20260927" and
  .requestParameters.dBSnapshotIdentifier == "arn:aws:rds:eu-west-1:269416271598:snapshot:vay2017-legacy-source-freeze-20260920" and
  .requestParameters.dBSubnetGroupName == "vay2017-metadata-isolated-restore" and
  .requestParameters.publiclyAccessible == false and
  .requestParameters.vpcSecurityGroupIds == ["sg-06ce28a79d9694a4a"] and
  .responseElements.dbiResourceId == "db-KWO2HSCRBXNV75OK7LNIBZN7TQ")' \
  <<<"$restore_events" >/dev/null
execution="$(aws stepfunctions start-execution --region "$region" --state-machine-arn "$machine" \
  --name "compare-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-local}" --input '{}' \
  --query executionArn --output text 2>/dev/null)"
[[ "$execution" == arn:aws:states:eu-west-1:269416271598:execution:vay2042-source-preservation-compare:* ]]
deadline=$((SECONDS + 7500))
status=RUNNING
while (( SECONDS < deadline )); do
  result="$(aws stepfunctions describe-execution --region "$region" --execution-arn "$execution" \
    --query '{status:status,output:output}' --output json 2>/dev/null)"
  status="$(jq -r '.status' <<<"$result" 2>/dev/null)"
  case "$status" in
    SUCCEEDED) break ;;
    RUNNING) sleep 15 ;;
    *) false ;;
  esac
done
[[ "$status" == SUCCEEDED ]]
output="$(jq -er '.output | fromjson | select(.completion.exitCode == 0)' <<<"$result" 2>/dev/null)"
task="$(jq -er '.result.taskArn' <<<"$output" 2>/dev/null)"
[[ "$task" == arn:aws:ecs:eu-west-1:269416271598:task/vay2017-metadata-rehearsal/* ]]
check_instance vay2017-metadata-rehearsal-isolated-20260923 db-BB7GOFQ3BQTLTBG444I2Q75X6Y
check_instance vay2042-preservation-control-20260927 db-KWO2HSCRBXNV75OK7LNIBZN7TQ
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  events="$(aws logs get-log-events --region "$region" \
    --log-group-name /aws/ecs/vay2042-source-preservation-compare \
    --log-stream-name "compare/source-preservation/${task##*/}" --start-from-head \
    --query 'events[*].message' --output json 2>/dev/null || true)"
  if jq -e 'any(.[]? | fromjson?;
    .status == "OK" and .scope == "isolated-source-preservation" and
    .databases == 4 and .tables == 83 and (.evidence.tables | length) == 83)' \
      <<<"${events:-[]}" >/dev/null 2>&1; then
    if [[ -n "${VAY2042_EVIDENCE_PATH:-}" ]]; then
      umask 077
      jq -er '.[] | fromjson? | select(.status == "OK" and .scope == "isolated-source-preservation")' \
        <<<"$events" > "$VAY2042_EVIDENCE_PATH"
    fi
    jq -r '.[] | fromjson? | select(.status == "OK") |
      "Verified 83-table read-only comparison; evidence SHA-256: \(.evidenceSha256)"' \
      <<<"$events"
    exit 0
  fi
  sleep 5
done
false
