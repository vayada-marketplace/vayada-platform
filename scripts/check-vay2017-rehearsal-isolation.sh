#!/usr/bin/env bash
set -euo pipefail

readonly region="eu-west-1"
readonly account="269416271598"
readonly instance="vay2017-metadata-rehearsal-isolated-20260923"
readonly snapshot="vay2017-legacy-source-freeze-20260920"
readonly vpc_cidr="10.230.0.0/24"
readonly runner_subnet_cidr="10.230.0.0/28"
readonly endpoint_subnet_cidr="10.230.0.16/28"
readonly database_subnet_a_cidr="10.230.0.32/28"
readonly database_subnet_b_cidr="10.230.0.48/28"
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly attestation_file="$script_dir/fixtures/vay2017-isolated-restore-plan.json"
readonly image_digest="sha256:a6f1001b1713e5f86e52cf757b3e67c794ec936639273dc041cedc7b95ea7b3c"

aws sts get-caller-identity --query Account --output text | grep -Fxq "$account" || {
  echo "Refusing: AWS account is not the reviewed rehearsal account." >&2
  exit 1
}

snapshot_json="$(aws rds describe-db-snapshots --region "$region" --db-snapshot-identifier "$snapshot" \
  --query 'DBSnapshots[0].{id:DBSnapshotIdentifier,status:Status,source:DBInstanceIdentifier,encrypted:Encrypted,engine:Engine,version:EngineVersion}' --output json)"
jq -e --arg snapshot "$snapshot" '.id == $snapshot and .status == "available" and .source == "vayada-database" and .encrypted == true and .engine == "postgres" and .version == "17.9"' \
  <<<"$snapshot_json" >/dev/null || { echo "The source snapshot does not match the reviewed immutable PostgreSQL snapshot." >&2; exit 1; }
jq -e --arg account "$account" --arg region "$region" --arg snapshot "$snapshot" --arg instance "$instance" --arg cidr "$vpc_cidr" \
  '.attestationVersion == 1 and .accountId == $account and .region == $region and .sourceDatabaseId == "vayada-database" and .sourceSnapshotId == $snapshot and .restoreInstanceId == $instance and .restoreEngine == "postgres" and .restoreEngineVersion == "17.9" and .restoreStorageEncrypted == true and .restorePubliclyAccessible == false and .restoreAvailabilityZone == "eu-west-1a" and .targetVpcCidr == $cidr' \
  "$attestation_file" >/dev/null || { echo "The checked-in isolated restore plan identity is invalid." >&2; exit 1; }

db_json="$(aws rds describe-db-instances --region "$region" --db-instance-identifier "$instance" \
  --query 'DBInstances[0].{id:DBInstanceIdentifier,resourceId:DbiResourceId,arn:DBInstanceArn,secretArn:MasterUserSecret.SecretArn,secretStatus:MasterUserSecret.SecretStatus,status:DBInstanceStatus,engine:Engine,version:EngineVersion,class:DBInstanceClass,storage:StorageType,allocated:AllocatedStorage,encrypted:StorageEncrypted,public:PubliclyAccessible,multiAz:MultiAZ,deletionProtection:DeletionProtection,backupRetention:BackupRetentionPeriod,az:AvailabilityZone,vpc:DBSubnetGroup.VpcId,subnetGroup:DBSubnetGroup.DBSubnetGroupName,groups:VpcSecurityGroups[*].VpcSecurityGroupId}' --output json)"
jq -e --arg instance "$instance" \
  '.id == $instance and (.resourceId | startswith("db-")) and (.arn | endswith(":db:" + $instance)) and (.secretArn | type == "string" and length > 0) and .secretStatus == "active" and .status == "available" and .engine == "postgres" and .version == "17.9" and .class == "db.t3.micro" and .storage == "gp2" and .allocated == 20 and .encrypted == true and .public == false and .multiAz == false and .deletionProtection == false and .backupRetention == 0 and .az == "eu-west-1a" and .subnetGroup == "vay2017-metadata-isolated-restore"' \
  <<<"$db_json" >/dev/null || { echo "The isolated rehearsal restore metadata does not match the reviewed configuration." >&2; exit 1; }

vpc_json="$(aws ec2 describe-vpcs --region "$region" --filters "Name=tag:Name,Values=vay2017-metadata-runner" \
  --query 'Vpcs[?CidrBlock==`10.230.0.0/24` && Tags[?Key==`Purpose` && Value==`Dedicated VAY-2043 runner and isolated snapshot restore; no production VPC peering`]].{id:VpcId,cidr:CidrBlock}' --output json)"
jq -e --arg cidr "$vpc_cidr" 'length == 1 and .[0].cidr == $cidr' <<<"$vpc_json" >/dev/null || {
  echo "The dedicated VAY-2043 VPC is missing, duplicated, or outside the reviewed address plan." >&2
  exit 1
}
vpc="$(jq -r '.[0].id' <<<"$vpc_json")"
[[ "$(jq -r '.vpc' <<<"$db_json")" == "$vpc" ]] || { echo "The restored DB is outside the dedicated VAY-2043 VPC." >&2; exit 1; }
[[ "$(aws ec2 describe-vpc-attribute --region "$region" --vpc-id "$vpc" --attribute enableDnsSupport --query 'EnableDnsSupport.Value' --output text)" == "True" &&
   "$(aws ec2 describe-vpc-attribute --region "$region" --vpc-id "$vpc" --attribute enableDnsHostnames --query 'EnableDnsHostnames.Value' --output text)" == "True" ]] || {
  echo "The dedicated VAY-2043 VPC must have DNS support and DNS hostnames enabled." >&2
  exit 1
}

[[ "$(aws ec2 describe-internet-gateways --region "$region" --filters "Name=attachment.vpc-id,Values=$vpc" --query 'length(InternetGateways)' --output text)" == "0" &&
   "$(aws ec2 describe-nat-gateways --region "$region" --filter "Name=vpc-id,Values=$vpc" --query 'length(NatGateways)' --output text)" == "0" ]] || {
  echo "The dedicated VAY-2043 VPC must not have an internet gateway or NAT gateway." >&2
  exit 1
}
[[ "$(aws ec2 describe-vpc-peering-connections --region "$region" \
   --filters "Name=requester-vpc-info.vpc-id,Values=$vpc" --query 'length(VpcPeeringConnections)' --output text)" == "0" &&
   "$(aws ec2 describe-vpc-peering-connections --region "$region" \
   --filters "Name=accepter-vpc-info.vpc-id,Values=$vpc" --query 'length(VpcPeeringConnections)' --output text)" == "0" ]] || {
  echo "The dedicated VAY-2043 VPC must not be peered to any other VPC." >&2
  exit 1
}

ecr_digest="$(aws ecr describe-images --region "$region" --repository-name vayada-next-api \
  --image-ids imageDigest="$image_digest" --query 'imageDetails[0].imageDigest' --output text)"
[[ "$ecr_digest" == "$image_digest" ]] || { echo "The pinned scanner image digest is unavailable." >&2; exit 1; }

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
  [[ "$group_id" =~ ^sg-[0-9a-f]+$ ]] || { echo "Dedicated VAY-2043 security groups are missing or ambiguous." >&2; exit 1; }
done
jq -e --arg group "$database_group" '.groups == [$group]' <<<"$db_json" >/dev/null || {
  echo "The isolated restore still uses a shared or unexpected security group." >&2
  exit 1
}

database_group_json="$(aws ec2 describe-security-groups --region "$region" --group-ids "$database_group" \
  --query 'SecurityGroups[0].{id:GroupId,vpc:VpcId,name:GroupName,ingress:IpPermissions[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp},egress:IpPermissionsEgress}' --output json)"
runner_group_json="$(aws ec2 describe-security-groups --region "$region" --group-ids "$runner_group" \
  --query 'SecurityGroups[0].{id:GroupId,vpc:VpcId,name:GroupName,ingress:IpPermissions[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp},egress:IpPermissionsEgress[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp,prefixes:PrefixListIds[*].PrefixListId}}' --output json)"
runner_group_rules_json="$(aws ec2 describe-security-group-rules --region "$region" --filters "Name=group-id,Values=$runner_group" \
  --query 'SecurityGroupRules[].{egress:IsEgress,protocol:IpProtocol,from:FromPort,to:ToPort,group:ReferencedGroupInfo.GroupId,cidr:CidrIpv4,ipv6:CidrIpv6,prefix:PrefixListId}' --output json)"
endpoint_group_json="$(aws ec2 describe-security-groups --region "$region" --group-ids "$endpoint_group" \
  --query 'SecurityGroups[0].{id:GroupId,vpc:VpcId,name:GroupName,ingress:IpPermissions[*].{protocol:IpProtocol,from:FromPort,to:ToPort,groups:UserIdGroupPairs[*].GroupId,cidrs:IpRanges[*].CidrIp},egress:IpPermissionsEgress}' --output json)"
prefix_list="$(aws ec2 describe-prefix-lists --region "$region" --filters Name=prefix-list-name,Values=com.amazonaws.eu-west-1.s3 --query 'PrefixLists[0].PrefixListId' --output text)"

jq -e --arg group "$database_group" --arg vpc "$vpc" --arg runner "$runner_group" \
  '.id == $group and .vpc == $vpc and .name == "vay2017-metadata-database" and .egress == [] and (.ingress | length == 1) and .ingress[0].protocol == "tcp" and .ingress[0].from == 5432 and .ingress[0].to == 5432 and .ingress[0].cidrs == [] and .ingress[0].groups == [$runner]' \
  <<<"$database_group_json" >/dev/null || { echo "The isolated DB group is not restricted to PostgreSQL from the runner group." >&2; exit 1; }
jq -e --arg group "$runner_group" --arg endpoint "$endpoint_group" --arg database "$database_group" --arg prefix "$prefix_list" --arg vpc "$vpc" \
  '.id == $group and .vpc == $vpc and .name == "vay2017-metadata-runner" and .ingress == []' \
  <<<"$runner_group_json" >/dev/null || { echo "The runner security group identity or ingress rules differ from the reviewed configuration." >&2; exit 1; }
jq -e --arg endpoint "$endpoint_group" --arg database "$database_group" --arg prefix "$prefix_list" '
  length == 3 and
  (all(.[]; .egress == true and .protocol == "tcp" and .cidr == null and .ipv6 == null)) and
  ([.[] | select(.from == 5432 and .to == 5432 and .group == $database and .prefix == null)] | length == 1) and
  ([.[] | select(.from == 443 and .to == 443 and .group == $endpoint and .prefix == null)] | length == 1) and
  ([.[] | select(.from == 443 and .to == 443 and .group == null and .prefix == $prefix)] | length == 1)
' <<<"$runner_group_rules_json" >/dev/null || { echo "Runner security-group rules are broader or different from the reviewed three egress paths." >&2; exit 1; }
jq -e --arg group "$endpoint_group" --arg runner "$runner_group" --arg vpc "$vpc" \
  '.id == $group and .vpc == $vpc and .name == "vay2017-metadata-endpoints" and .egress == [] and (.ingress | length == 1) and .ingress[0].protocol == "tcp" and .ingress[0].from == 443 and .ingress[0].to == 443 and .ingress[0].groups == [$runner] and .ingress[0].cidrs == []' \
  <<<"$endpoint_group_json" >/dev/null || { echo "Endpoint security-group rules differ from the reviewed runner-only rule." >&2; exit 1; }

subnets_json="$(aws ec2 describe-subnets --region "$region" --filters "Name=vpc-id,Values=$vpc" \
  --query 'Subnets[].{id:SubnetId,cidr:CidrBlock,az:AvailabilityZone,publicIp:MapPublicIpOnLaunch}' --output json)"
jq -e --arg runner "$runner_subnet_cidr" --arg endpoints "$endpoint_subnet_cidr" --arg db_a "$database_subnet_a_cidr" --arg db_b "$database_subnet_b_cidr" '
  length == 4 and ([.[] | select(.publicIp == true)] | length == 0) and
  ([.[] | select(.cidr == $runner and .az == "eu-west-1a")] | length == 1) and
  ([.[] | select(.cidr == $endpoints and .az == "eu-west-1a")] | length == 1) and
  ([.[] | select(.cidr == $db_a and .az == "eu-west-1a")] | length == 1) and
  ([.[] | select(.cidr == $db_b and .az == "eu-west-1b")] | length == 1)
' <<<"$subnets_json" >/dev/null || { echo "The dedicated VPC subnet inventory does not match the reviewed private CIDR layout." >&2; exit 1; }
runner_subnet="$(jq -r --arg cidr "$runner_subnet_cidr" '.[] | select(.cidr == $cidr) | .id' <<<"$subnets_json")"
endpoint_subnet="$(jq -r --arg cidr "$endpoint_subnet_cidr" '.[] | select(.cidr == $cidr) | .id' <<<"$subnets_json")"
runner_route_table_json="$(aws ec2 describe-route-tables --region "$region" --filters "Name=association.subnet-id,Values=$runner_subnet" \
  --query 'RouteTables[0].{id:RouteTableId,routes:Routes[*].{cidr:DestinationCidrBlock,prefix:DestinationPrefixListId,gateway:GatewayId,nat:NatGatewayId,state:State}}' --output json)"
runner_route_table_id="$(jq -r '.id' <<<"$runner_route_table_json")"
jq -e --arg prefix "$prefix_list" '
  (.routes | length == 2) and ([.routes[] | select(.gateway == "local")] | length == 1) and
  ([.routes[] | select(.prefix == $prefix and (.gateway | startswith("vpce-")) and .state == "active")] | length == 1) and
  ([.routes[] | select(.cidr == "0.0.0.0/0" or (.nat // "") != "" or ((.gateway // "") | startswith("igw-")))] | length == 0)
' <<<"$runner_route_table_json" >/dev/null || { echo "The runner subnet route table has an internet, NAT, or unexpected route." >&2; exit 1; }

endpoints_json="$(aws ec2 describe-vpc-endpoints --region "$region" \
  --filters "Name=vpc-id,Values=$vpc" \
  --query 'VpcEndpoints[*].{id:VpcEndpointId,state:State,type:VpcEndpointType,service:ServiceName,privateDns:PrivateDnsEnabled,subnets:SubnetIds,groups:Groups[*].GroupId,routeTables:RouteTableIds}' --output json)"
jq -e --arg subnet "$endpoint_subnet" --arg group "$endpoint_group" --arg rt "$runner_route_table_id" '
  length == 5 and
  ([.[] | select(.type == "Interface" and .state == "available" and .privateDns == true and .subnets == [$subnet] and .groups == [$group] and (.service | IN("com.amazonaws.eu-west-1.ecr.api","com.amazonaws.eu-west-1.ecr.dkr","com.amazonaws.eu-west-1.logs","com.amazonaws.eu-west-1.secretsmanager")))] | length == 4) and
  ([.[] | select(.type == "Gateway" and .state == "available" and .service == "com.amazonaws.eu-west-1.s3" and .routeTables == [$rt])] | length == 1)
' <<<"$endpoints_json" >/dev/null || { echo "Private AWS endpoints are missing or attached outside the isolated VPC." >&2; exit 1; }

echo "Verified: the exact encrypted snapshot restore, isolated VPC, database, runner, private endpoints, and no-internet boundary match the reviewed VAY-2043 plan."
