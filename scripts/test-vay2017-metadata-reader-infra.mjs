import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../infra/vay2017-metadata-runner/', import.meta.url);
const readerTf = await readFile(new URL('reader.tf', root), 'utf8');
const runnerTf = await readFile(new URL('runner.tf', root), 'utf8');
const isolationCheck = await readFile(new URL('./check-vay2017-rehearsal-isolation.sh', import.meta.url), 'utf8');
const inventoryPolicyStart = readerTf.indexOf('data "aws_iam_policy_document" "vay2017_inventory_execution"');
const inventoryPolicyEnd = readerTf.indexOf('resource "aws_iam_role_policy" "vay2017_inventory_execution"', inventoryPolicyStart);
const inventoryPolicy = readerTf.slice(inventoryPolicyStart, inventoryPolicyEnd);
const securityGroupRule = (resourceType, name) => {
  const match = runnerTf.match(new RegExp(`resource "${resourceType}" "${name}" \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `missing ${resourceType}.${name}`);
  return match[1];
};

test('reader secret and task roles are isolated by exact secret permissions', () => {
  assert.match(readerTf, /aws_secretsmanager_secret" "vay2017_reader_credentials"[\s\S]*prevent_destroy = true/);
  assert.match(readerTf, /secretsmanager:GetSecretValue[\s\S]*aws_secretsmanager_secret\.vay2017_reader_credentials\.arn/);
  assert.doesNotMatch(inventoryPolicy, /master_user_secret/);
  assert.match(readerTf, /secretsmanager:PutSecretValue[\s\S]*aws_secretsmanager_secret\.vay2017_reader_credentials\.arn/);
});

test('master credential is supplied only to the fixed private bootstrap task', () => {
  assert.match(readerTf, /aws_ecs_task_definition" "vay2017_reader_bootstrap"[\s\S]*master_user_secret\[0\]\.secret_arn/);
  assert.match(readerTf, /AssignPublicIp\s*=\s*"DISABLED"/);
  assert.match(readerTf, /EnableExecuteCommand\s*=\s*false/);
  assert.match(readerTf, /aws_sfn_state_machine" "vay2017_reader_bootstrap"/);
  assert.match(runnerTf, /vay2017_reader_bootstrap\.arn/);
  assert.match(runnerTf, /vay2017_bootstrap_task\.arn/);
  assert.match(readerTf, /VAY2017_RDS_CA_BUNDLE_GZIP[\s\S]*base64gzip\(file\([\s\S]*rds-ca-rsa2048-g1\.pem/);
  assert.match(runnerTf, /VAY2017_RDS_CA_BUNDLE_GZIP[\s\S]*base64gzip\(file\([\s\S]*rds-ca-rsa2048-g1\.pem/);
});

test('VPC security groups use standalone resources for all rules', () => {
  assert.doesNotMatch(runnerTf, /^\s+(?:ingress|egress)\s*(?:\{|=)/m);
  const rules = [
    ['aws_vpc_security_group_egress_rule', 'vay2017_runner_postgres', 'vay2017_rehearsal_runner', /ip_protocol\s*=\s*"tcp"/, /from_port\s*=\s*5432/, /to_port\s*=\s*5432/, /referenced_security_group_id\s*=\s*aws_security_group\.vay2017_rehearsal_database\.id/],
    ['aws_vpc_security_group_egress_rule', 'vay2017_runner_https', 'vay2017_rehearsal_runner', /ip_protocol\s*=\s*"tcp"/, /from_port\s*=\s*443/, /to_port\s*=\s*443/, /referenced_security_group_id\s*=\s*aws_security_group\.vay2017_rehearsal_endpoints\.id/],
    ['aws_vpc_security_group_egress_rule', 'vay2017_runner_ecr_s3', 'vay2017_rehearsal_runner', /ip_protocol\s*=\s*"tcp"/, /from_port\s*=\s*443/, /to_port\s*=\s*443/, /prefix_list_id\s*=\s*local\.vay2017_rehearsal_s3_prefix_list_id/],
    ['aws_vpc_security_group_ingress_rule', 'vay2017_endpoints_https', 'vay2017_rehearsal_endpoints', /ip_protocol\s*=\s*"tcp"/, /from_port\s*=\s*443/, /to_port\s*=\s*443/, /referenced_security_group_id\s*=\s*aws_security_group\.vay2017_rehearsal_runner\.id/],
    ['aws_vpc_security_group_ingress_rule', 'vay2017_database_postgres', 'vay2017_rehearsal_database', /ip_protocol\s*=\s*"tcp"/, /from_port\s*=\s*5432/, /to_port\s*=\s*5432/, /referenced_security_group_id\s*=\s*aws_security_group\.vay2017_rehearsal_runner\.id/],
  ];
  for (const [type, name, owner, ...assertions] of rules) {
    const block = securityGroupRule(type, name);
    assert.match(block, new RegExp(`security_group_id\\s*=\\s*aws_security_group\\.${owner}\\.id`));
    for (const assertion of assertions) assert.match(block, assertion);
  }
  assert.match(isolationCheck, /\.name == "vay2017-metadata-database" and \.egress == \[\]/);
  assert.match(isolationCheck, /\.name == "vay2017-metadata-endpoints" and \.egress == \[\]/);
  assert.match(isolationCheck, /\.name == "vay2017-metadata-runner" and \.ingress == \[\]/);
  assert.match(isolationCheck, /length == 3 and[\s\S]*\.egress == true/);
  assert.match(isolationCheck, /\.from == 5432 and \.to == 5432 and \.group == \$database and \.prefix == null/);
  assert.match(isolationCheck, /\.from == 443 and \.to == 443 and \.group == \$endpoint and \.prefix == null/);
  assert.match(isolationCheck, /\.from == 443 and \.to == 443 and \.group == null and \.prefix == \$prefix/);
});
