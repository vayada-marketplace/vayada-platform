#!/usr/bin/env bash
set -euo pipefail

# Only the reviewed file on protected main may authorize this fixed task.
readonly run_file=rehearsal/vay2042/product-rehearsal-run.json
readonly region=eu-west-1
readonly account=269416271598
readonly machine=arn:aws:states:eu-west-1:269416271598:stateMachine:vay2042-isolated-product-rehearsal
readonly cluster=arn:aws:ecs:eu-west-1:269416271598:cluster/vay2017-metadata-rehearsal
[[ -f "$run_file" ]] || { echo 'Reviewed rehearsal run file is absent; no task launched.' >&2; exit 1; }
for tool in aws jq sha256sum; do command -v "$tool" >/dev/null; done
jq -e --arg snapshot "arn:aws:rds:${region}:${account}:snapshot:vay2017-legacy-source-freeze-20260920" '
  .status == "REVIEWED_STAGING_INITIAL" and
  (.runId | test("^vay1360-[0-9a-f]{24}$")) and
  (.sourceRunId | test("^vay1351-[0-9a-f]{24}$")) and
  (.applicationRelease | test("^[0-9a-f]{40}$")) and
  (.imageDigest | test("^sha256:[0-9a-f]{64}$")) and
  (.sourceProofSha256 | test("^[0-9a-f]{64}$")) and
  (.sourceManifestSha256 | test("^[0-9a-f]{64}$")) and
  (.targetCleanProofSha256 | test("^[0-9a-f]{64}$")) and
  (.targetIdentitySha256 | test("^[0-9a-f]{64}$")) and
  (.mediaReservationEvidenceSha256 | test("^[0-9a-f]{64}$")) and
  (.operator | type == "string" and length > 0) and
  .confirmation == ("STAGING_REHEARSAL:" + .runId + ":" + .sourceRunId) and
  (.sourceReaderSecretVersion | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
  (.targetWriterSecretVersion | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
  .snapshotArn == $snapshot and
  .media.targetBucket == "vayada-rehearsal-vay2042-20260926-269416271598" and
  .media.cdnBaseUrl == "https://dmziipchtzlbk.cloudfront.net"
' "$run_file" >/dev/null
run_id="$(jq -r .runId "$run_file")"
release="$(jq -r .applicationRelease "$run_file")"
digest="$(jq -r .imageDigest "$run_file")"
source_version="$(jq -r .sourceReaderSecretVersion "$run_file")"
target_version="$(jq -r .targetWriterSecretVersion "$run_file")"
run_sha="$(sha256sum "$run_file" | cut -d ' ' -f 1)"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$account" ]]

source_instance="$(aws rds describe-db-instances --region "$region" \
  --db-instance-identifier vay2017-metadata-rehearsal-isolated-20260923 \
  --query 'DBInstances[0]' --output json)"
jq -e '.DbiResourceId == "db-BB7GOFQ3BQTLTBG444I2Q75X6Y" and
  .DBInstanceStatus == "available" and .PubliclyAccessible == false and
  .StorageEncrypted == true and .MultiAZ == false and
  .DBSubnetGroup.VpcId == "vpc-03f7231a783250e37" and
  [.VpcSecurityGroups[].VpcSecurityGroupId] == ["sg-06ce28a79d9694a4a"]' \
  <<<"$source_instance" >/dev/null

definition="$(aws stepfunctions describe-state-machine --region "$region" \
  --state-machine-arn "$machine" --query definition --output text)"
jq -e --arg cluster "$cluster" '
  .StartAt == "Rehearse" and
  .States.Rehearse.Parameters.Cluster == $cluster and
  .States.Rehearse.Parameters.LaunchType == "FARGATE" and
  .States.Rehearse.Parameters.EnableExecuteCommand == false and
  .States.Rehearse.Parameters.NetworkConfiguration.AwsvpcConfiguration == {
    "Subnets":["subnet-08e41c3b551c351ec"],
    "SecurityGroups":["sg-0415fa26a480a30a4"],
    "AssignPublicIp":"DISABLED"
  } and
  (.States.Rehearse.Parameters.TaskDefinition | startswith("arn:aws:ecs:eu-west-1:269416271598:task-definition/vay2042-isolated-product-rehearsal:"))
' <<<"$definition" >/dev/null
task_arn="$(jq -r .States.Rehearse.Parameters.TaskDefinition <<<"$definition")"
task="$(aws ecs describe-task-definition --region "$region" --task-definition "$task_arn" \
  --query taskDefinition --output json)"
jq -e --arg release "$release" --arg digest "$digest" --arg run_sha "$run_sha" \
  --arg source_version "$source_version" --arg target_version "$target_version" '
  .status == "ACTIVE" and .revision > 1 and
  .taskRoleArn == "arn:aws:iam::269416271598:role/vayada-rehearsal-vay2042-20260926-media" and
  .executionRoleArn == "arn:aws:iam::269416271598:role/vayada-vay2042-product-rehearsal-execution" and
  .networkMode == "awsvpc" and (.containerDefinitions | length) == 1 and
  (.containerDefinitions[0] | .name == "product-rehearsal" and
    .image == ("269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@" + $digest) and
    .entryPoint == ["node"] and
    .command[0:2] == ["/app/packages/backend-migration/dist/cli/cutover.js","rehearse-staging"] and
    .readonlyRootFilesystem == true and .privileged == false and
    ([.environment[] | select(.name == "APPLICATION_RELEASE") | .value] == [$release]) and
    ([.environment[] | select(.name == "VAY2042_RUN_FILE_SHA256") | .value] == [$run_sha]) and
    ([.secrets[] | {name, valueFrom}] | sort_by(.name)) == ([
      {name:"VAY2042_SOURCE_PASSWORD", valueFrom:("arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925-4kTuiw:password::" + $source_version)},
      {name:"VAY2042_SOURCE_USER", valueFrom:("arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925-4kTuiw:username::" + $source_version)},
      {name:"VAY2042_TARGET_PASSWORD", valueFrom:("arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925-mfr57v:password::" + $target_version)},
      {name:"VAY2042_TARGET_USER", valueFrom:("arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925-mfr57v:username::" + $target_version)}
    ] | sort_by(.name)))
' <<<"$task" >/dev/null

for state in RUNNING PENDING; do
  [[ "$(aws ecs list-tasks --region "$region" --cluster "$cluster" \
    --desired-status "$state" --query 'length(taskArns)' --output text)" == 0 ]]
done
[[ "$(aws stepfunctions list-executions --region "$region" --state-machine-arn "$machine" \
  --status-filter RUNNING --query 'length(executions)' --output text)" == 0 ]]
execution="$(aws stepfunctions start-execution --region "$region" --state-machine-arn "$machine" \
  --name "$run_id" --input '{}' --query executionArn --output text)"
[[ "$execution" == "arn:aws:states:${region}:${account}:execution:vay2042-isolated-product-rehearsal:${run_id}" ]]

deadline=$((SECONDS + 14700))
while (( SECONDS < deadline )); do
  result="$(aws stepfunctions describe-execution --region "$region" --execution-arn "$execution" \
    --query '{status:status,output:output}' --output json)"
  case "$(jq -r .status <<<"$result")" in
    SUCCEEDED) break ;;
    RUNNING) sleep 20 ;;
    *) echo 'Isolated rehearsal task failed; inspect sanitized evidence before any retry.' >&2; exit 1 ;;
  esac
done
[[ "$(jq -r .status <<<"$result")" == SUCCEEDED ]]
jq -e --arg task "$task_arn" --arg digest "$digest" '
  (.output | fromjson | .completion) |
  .exitCode == 4 and .taskDefinitionArn == $task and .imageDigest == $digest
' <<<"$result" >/dev/null
echo "Isolated rehearsal ${run_id} reached exit 4; inspect parity and AWAITING_SMOKE evidence before same-run resume."
