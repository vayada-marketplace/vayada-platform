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
});

test('VPC security groups use standalone resources for all rules', () => {
  assert.doesNotMatch(runnerTf, /^\s+(?:ingress|egress)\s*(?:\{|=)/m);
  assert.match(runnerTf, /aws_vpc_security_group_egress_rule" "vay2017_runner_postgres"/);
  assert.match(runnerTf, /aws_vpc_security_group_egress_rule" "vay2017_runner_https"/);
  assert.match(runnerTf, /aws_vpc_security_group_egress_rule" "vay2017_runner_ecr_s3"/);
  assert.match(runnerTf, /aws_vpc_security_group_ingress_rule" "vay2017_endpoints_https"/);
  assert.match(runnerTf, /aws_vpc_security_group_ingress_rule" "vay2017_database_postgres"/);
  assert.match(isolationCheck, /\.egress == \[\]/);
  assert.match(isolationCheck, /length == 3 and/);
});
