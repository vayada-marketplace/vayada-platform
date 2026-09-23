#!/usr/bin/env bash
set -euo pipefail

readonly region="eu-west-1"
readonly account="269416271598"
readonly instance="vay2017-legacy-rehearsal-20260921"
readonly snapshot="vay2017-legacy-source-freeze-20260920"
readonly vpc="vpc-055e8074dc3b2422a"
readonly expected_old_group="sg-0089fc5e42fa33566"
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly attestation_file="$script_dir/fixtures/vay2017-restore-attestation.json"

if [[ "${1:-}" != "--apply" || "$#" -ne 1 ]]; then
  echo "Usage: $0 --apply (changes only the named restored rehearsal instance's security group)" >&2
  exit 2
fi

aws sts get-caller-identity --query Account --output text | grep -Fxq "$account" || {
  echo "Refusing: AWS account is not the reviewed rehearsal account." >&2
  exit 1
}

snapshot_json="$(aws rds describe-db-snapshots --region "$region" --db-snapshot-identifier "$snapshot" \
  --query 'DBSnapshots[0].{id:DBSnapshotIdentifier,status:Status,source:DBInstanceIdentifier,encrypted:Encrypted,engine:Engine,version:EngineVersion}' --output json)"
jq -e --arg snapshot "$snapshot" '.id == $snapshot and .status == "available" and .source == "vayada-database" and .encrypted == true and .engine == "postgres" and .version == "17.9"' \
  <<<"$snapshot_json" >/dev/null || {
  echo "Refusing: source snapshot does not match the reviewed immutable snapshot." >&2
  exit 1
}
jq -e --arg instance "$instance" --arg snapshot "$snapshot" \
  '.eventId == "6c80019b-26bd-460c-8750-5a950bf48441" and .eventTime == "2026-09-20T16:19:33Z" and .sourceSnapshotId == $snapshot and .restoreInstanceId == $instance and .restoreInstanceResourceId == "db-MHCPB2UKUGKW6FLKDBQC4RQWJQ"' \
  "$attestation_file" >/dev/null || { echo "Refusing: the versioned restore attestation is invalid." >&2; exit 1; }

db_json="$(aws rds describe-db-instances --region "$region" --db-instance-identifier "$instance" \
  --query 'DBInstances[0].{id:DBInstanceIdentifier,resourceId:DbiResourceId,arn:DBInstanceArn,status:DBInstanceStatus,engine:Engine,version:EngineVersion,encrypted:StorageEncrypted,public:PubliclyAccessible,az:AvailabilityZone,vpc:DBSubnetGroup.VpcId,groups:VpcSecurityGroups[*].VpcSecurityGroupId}' --output json)"
jq -e --arg instance "$instance" --arg vpc "$vpc" \
  --arg resource_id "$(jq -r '.restoreInstanceResourceId' "$attestation_file")" --arg arn "$(jq -r '.restoreInstanceArn' "$attestation_file")" \
  '.id == $instance and .resourceId == $resource_id and .arn == $arn and .status == "available" and .engine == "postgres" and .version == "17.9" and .encrypted == true and .public == false and .az == "eu-west-1a" and .vpc == $vpc' \
  <<<"$db_json" >/dev/null || {
  echo "Refusing: database does not match the reviewed private restored PostgreSQL instance." >&2
  exit 1
}

new_group="$(aws ec2 describe-security-groups --region "$region" \
  --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=vay2017-metadata-database" \
  --query 'SecurityGroups[?Tags[?Key==`Purpose` && Value==`VAY-2043 isolated legacy metadata rehearsal`]].GroupId | [0]' --output text)"
[[ "$new_group" =~ ^sg-[0-9a-f]+$ ]] || {
  echo "Refusing: dedicated VAY-2043 database security group is missing or ambiguous." >&2
  exit 1
}
runner_group="$(aws ec2 describe-security-groups --region "$region" \
  --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=vay2017-metadata-runner" \
  --query 'SecurityGroups[?Tags[?Key==`Purpose` && Value==`VAY-2043 isolated legacy metadata rehearsal`]].GroupId | [0]' --output text)"
[[ "$runner_group" =~ ^sg-[0-9a-f]+$ ]] || {
  echo "Refusing: dedicated VAY-2043 runner security group is missing or ambiguous." >&2
  exit 1
}

group_json="$(aws ec2 describe-security-groups --region "$region" --group-ids "$new_group" \
  --query 'SecurityGroups[0].{id:GroupId,vpc:VpcId,name:GroupName,ingress:IpPermissions[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp},egress:IpPermissionsEgress}' --output json)"
jq -e --arg id "$new_group" --arg vpc "$vpc" --arg runner "$runner_group" \
  '.id == $id and .vpc == $vpc and .name == "vay2017-metadata-database" and .egress == [] and (.ingress | length == 1) and .ingress[0].protocol == "tcp" and .ingress[0].from == 5432 and .ingress[0].to == 5432 and .ingress[0].groups == [$runner] and (.ingress[0].cidrs | length == 0)' \
  <<<"$group_json" >/dev/null || {
  echo "Refusing: dedicated database security group is not the reviewed single-runner rule." >&2
  exit 1
}

jq -e --arg group "$new_group" '.groups == [$group]' <<<"$db_json" >/dev/null && {
  echo "The restored rehearsal instance already uses only the dedicated metadata security group."
  exit 0
}
jq -e --arg group "$expected_old_group" '.groups == [$group]' <<<"$db_json" >/dev/null || {
  echo "Refusing: current security groups differ from the reviewed original shared group." >&2
  exit 1
}

aws rds modify-db-instance --region "$region" --db-instance-identifier "$instance" \
  --vpc-security-group-ids "$new_group" --apply-immediately >/dev/null || {
  echo "Failed to apply the dedicated security group to the restored rehearsal instance." >&2
  exit 1
}
aws rds wait db-instance-available --region "$region" --db-instance-identifier "$instance"

after_groups="$(aws rds describe-db-instances --region "$region" --db-instance-identifier "$instance" \
  --query 'DBInstances[0].{id:DBInstanceIdentifier,status:DBInstanceStatus,encrypted:StorageEncrypted,public:PubliclyAccessible,groups:VpcSecurityGroups[*].VpcSecurityGroupId}' --output json)"
jq -e --arg instance "$instance" --arg group "$new_group" \
  '.id == $instance and .status == "available" and .encrypted == true and .public == false and .groups == [$group]' \
  <<<"$after_groups" >/dev/null || {
  echo "Verification failed: restored rehearsal instance is not isolated by the dedicated security group." >&2
  exit 1
}
echo "The restored rehearsal instance now uses only the dedicated VAY-2043 database security group."
