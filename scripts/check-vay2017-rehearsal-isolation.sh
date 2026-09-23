#!/usr/bin/env bash
set -euo pipefail

readonly region="eu-west-1"
readonly account="269416271598"
readonly instance="vay2017-legacy-rehearsal-20260921"
readonly snapshot="vay2017-legacy-source-freeze-20260920"
readonly vpc="vpc-055e8074dc3b2422a"
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly attestation_file="$script_dir/fixtures/vay2017-restore-attestation.json"

aws sts get-caller-identity --query Account --output text | grep -Fxq "$account" || {
  echo "Refusing: AWS account is not the reviewed rehearsal account." >&2
  exit 1
}
snapshot_json="$(aws rds describe-db-snapshots --region "$region" --db-snapshot-identifier "$snapshot" \
  --query 'DBSnapshots[0].{id:DBSnapshotIdentifier,status:Status,source:DBInstanceIdentifier,encrypted:Encrypted,engine:Engine,version:EngineVersion}' --output json)"
jq -e --arg snapshot "$snapshot" '.id == $snapshot and .status == "available" and .source == "vayada-database" and .encrypted == true and .engine == "postgres" and .version == "17.9"' \
  <<<"$snapshot_json" >/dev/null || { echo "Source snapshot safety check failed." >&2; exit 1; }
jq -e --arg account "$account" --arg snapshot "$snapshot" --arg instance "$instance" \
  '.attestationVersion == 1 and .accountId == $account and .region == "eu-west-1" and .eventName == "RestoreDBInstanceFromDBSnapshot" and .eventId == "6c80019b-26bd-460c-8750-5a950bf48441" and .eventTime == "2026-09-20T16:19:33Z" and .sourceDatabaseId == "vayada-database" and .sourceSnapshotId == $snapshot and .restoreInstanceId == $instance and .restoreInstanceResourceId == "db-MHCPB2UKUGKW6FLKDBQC4RQWJQ" and .restoreInstanceArn == "arn:aws:rds:eu-west-1:269416271598:db:vay2017-legacy-rehearsal-20260921" and (.verificationMethod | type == "string")' \
  "$attestation_file" >/dev/null || { echo "Versioned restore attestation does not match the reviewed source and target." >&2; exit 1; }

db_json="$(aws rds describe-db-instances --region "$region" --db-instance-identifier "$instance" \
  --query 'DBInstances[0].{id:DBInstanceIdentifier,resourceId:DbiResourceId,arn:DBInstanceArn,status:DBInstanceStatus,engine:Engine,version:EngineVersion,encrypted:StorageEncrypted,public:PubliclyAccessible,az:AvailabilityZone,vpc:DBSubnetGroup.VpcId,groups:VpcSecurityGroups[*].VpcSecurityGroupId}' --output json)"
jq -e --arg instance "$instance" --arg vpc "$vpc" \
  --arg resource_id "$(jq -r '.restoreInstanceResourceId' "$attestation_file")" --arg arn "$(jq -r '.restoreInstanceArn' "$attestation_file")" \
  '.id == $instance and .resourceId == $resource_id and .arn == $arn and .status == "available" and .engine == "postgres" and .version == "17.9" and .encrypted == true and .public == false and .az == "eu-west-1a" and .vpc == $vpc' \
  <<<"$db_json" >/dev/null || { echo "Restored database safety check failed." >&2; exit 1; }

database_group="$(aws ec2 describe-security-groups --region "$region" \
  --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=vay2017-metadata-database" \
  --query 'SecurityGroups[?Tags[?Key==`Purpose` && Value==`VAY-2043 isolated legacy metadata rehearsal`]].GroupId | [0]' --output text)"
runner_group="$(aws ec2 describe-security-groups --region "$region" \
  --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=vay2017-metadata-runner" \
  --query 'SecurityGroups[?Tags[?Key==`Purpose` && Value==`VAY-2043 isolated legacy metadata rehearsal`]].GroupId | [0]' --output text)"
endpoint_group="$(aws ec2 describe-security-groups --region "$region" \
  --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=vay2017-metadata-endpoints" \
  --query 'SecurityGroups[?Tags[?Key==`Purpose` && Value==`VAY-2043 isolated legacy metadata rehearsal`]].GroupId | [0]' --output text)"
for group_id in "$database_group" "$runner_group" "$endpoint_group"; do
  [[ "$group_id" =~ ^sg-[0-9a-f]+$ ]] || { echo "Dedicated rehearsal network security groups are missing or ambiguous." >&2; exit 1; }
done
jq -e --arg group "$database_group" '.groups == [$group]' <<<"$db_json" >/dev/null || {
  echo "Refusing: the restored rehearsal instance still uses a shared or unexpected security group." >&2
  exit 1
}

database_group_json="$(aws ec2 describe-security-groups --region "$region" --group-ids "$database_group" \
  --query 'SecurityGroups[0].{id:GroupId,vpc:VpcId,name:GroupName,ingress:IpPermissions[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp},egress:IpPermissionsEgress}' --output json)"
runner_group_json="$(aws ec2 describe-security-groups --region "$region" --group-ids "$runner_group" \
  --query 'SecurityGroups[0].{id:GroupId,vpc:VpcId,name:GroupName,ingress:IpPermissions[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp},egress:IpPermissionsEgress[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp,prefixes:PrefixListIds[*].PrefixListId}}' --output json)"
endpoint_group_json="$(aws ec2 describe-security-groups --region "$region" --group-ids "$endpoint_group" \
  --query 'SecurityGroups[0].{id:GroupId,vpc:VpcId,name:GroupName,ingress:IpPermissions[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp},egress:IpPermissionsEgress}' --output json)"
prefix_list="$(aws ec2 describe-prefix-lists --region "$region" \
  --filters Name=prefix-list-name,Values=com.amazonaws.eu-west-1.s3 --query 'PrefixLists[0].PrefixListId' --output text)"

jq -e --arg group "$database_group" --arg vpc "$vpc" --arg runner "$runner_group" \
  '.id == $group and .vpc == $vpc and .name == "vay2017-metadata-database" and .egress == [] and (.ingress | length == 1) and .ingress[0].protocol == "tcp" and .ingress[0].from == 5432 and .ingress[0].to == 5432 and (.ingress[0].cidrs | length == 0) and .ingress[0].groups == [$runner]' \
  <<<"$database_group_json" >/dev/null || {
  echo "Dedicated rehearsal database security-group rules are not the reviewed single-runner rule." >&2
  exit 1
}
jq -e --arg group "$runner_group" --arg endpoint "$endpoint_group" --arg database "$database_group" --arg prefix "$prefix_list" --arg vpc "$vpc" \
  '.id == $group and .vpc == $vpc and .name == "vay2017-metadata-runner" and .ingress == [] and (.egress | length == 3) and ([.egress[] | select(.protocol == "tcp" and .from == 5432 and .to == 5432 and .groups == [$database] and .cidrs == [] and .prefixes == [])] | length == 1) and ([.egress[] | select(.protocol == "tcp" and .from == 443 and .to == 443 and .groups == [$endpoint] and .cidrs == [] and .prefixes == [])] | length == 1) and ([.egress[] | select(.protocol == "tcp" and .from == 443 and .to == 443 and .groups == [] and .cidrs == [] and .prefixes == [$prefix])] | length == 1)' \
  <<<"$runner_group_json" >/dev/null || {
  echo "Runner security-group rules are broader or different from the reviewed three egress paths." >&2
  exit 1
}
jq -e --arg group "$endpoint_group" --arg runner "$runner_group" --arg vpc "$vpc" \
  '.id == $group and .vpc == $vpc and .name == "vay2017-metadata-endpoints" and .egress == [] and (.ingress | length == 1) and .ingress[0].protocol == "tcp" and .ingress[0].from == 443 and .ingress[0].to == 443 and .ingress[0].groups == [$runner] and (.ingress[0].cidrs | length == 0)' \
  <<<"$endpoint_group_json" >/dev/null || {
  echo "VPC endpoint security-group rules are broader or different from the reviewed runner-only rule." >&2
  exit 1
}

subnet_json="$(aws ec2 describe-subnets --region "$region" --filters Name=vpc-id,Values="$vpc" Name=cidr-block,Values=172.31.48.0/24 \
  --query 'Subnets[0].{id:SubnetId,vpc:VpcId,cidr:CidrBlock,az:AvailabilityZone,publicIp:MapPublicIpOnLaunch}' --output json)"
jq -e --arg vpc "$vpc" '.vpc == $vpc and .cidr == "172.31.48.0/24" and .az == "eu-west-1a" and .publicIp == false' \
  <<<"$subnet_json" >/dev/null || { echo "The dedicated runner subnet is missing or public." >&2; exit 1; }
subnet_id="$(jq -r '.id' <<<"$subnet_json")"
route_table_json="$(aws ec2 describe-route-tables --region "$region" \
  --filters "Name=association.subnet-id,Values=$subnet_id" \
  --query 'RouteTables[0].{id:RouteTableId,routes:Routes[*].{cidr:DestinationCidrBlock,prefix:DestinationPrefixListId,gateway:GatewayId,nat:NatGatewayId}}' --output json)"
route_table_id="$(jq -r '.id' <<<"$route_table_json")"
jq -e --arg prefix "$prefix_list" '
  (.routes | length == 2) and
  ([.routes[] | select(.gateway == "local")] | length == 1) and
  ([.routes[] | select(.prefix == $prefix and (.gateway | startswith("vpce-")))] | length == 1) and
  ([.routes[] | select(.cidr == "0.0.0.0/0" or (.nat // "") != "" or ((.gateway // "") | startswith("igw-")))] | length == 0)
' <<<"$route_table_json" >/dev/null || { echo "The runner route table has an internet, NAT, or unexpected route." >&2; exit 1; }

endpoints_json="$(aws ec2 describe-vpc-endpoints --region "$region" \
  --filters "Name=vpc-id,Values=$vpc" "Name=tag:Purpose,Values=VAY-2043 isolated legacy metadata rehearsal" \
  --query 'VpcEndpoints[*].{id:VpcEndpointId,state:State,type:VpcEndpointType,service:ServiceName,privateDns:PrivateDnsEnabled,subnets:SubnetIds,groups:Groups[*].GroupId,routeTables:RouteTableIds}' --output json)"
jq -e --arg subnet "$subnet_id" --arg group "$endpoint_group" --arg rt "$route_table_id" '
  length == 5 and
  ([.[] | select(.type == "Interface" and .state == "available" and .privateDns == true and .subnets == [$subnet] and .groups == [$group] and (.service | IN("com.amazonaws.eu-west-1.ecr.api","com.amazonaws.eu-west-1.ecr.dkr","com.amazonaws.eu-west-1.logs","com.amazonaws.eu-west-1.secretsmanager")))] | length == 4) and
  ([.[] | select(.type == "Gateway" and .state == "available" and .service == "com.amazonaws.eu-west-1.s3" and .routeTables == [$rt])] | length == 1)
' <<<"$endpoints_json" >/dev/null || { echo "Required private AWS endpoints are missing or attached outside the dedicated route table/subnet." >&2; exit 1; }

echo "Verified: the exact restored VAY-2017 database, runner security groups, private subnet, route table, and endpoints match the reviewed isolation boundary."
