import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tf = read('infra/vay2017-metadata-runner/source_reader.tf');
const workflow = read('.github/workflows/vay2042-source-reader-bootstrap.yml');
const runner = read('scripts/run-vay2042-source-reader-bootstrap.sh');
const block = (type, name) => {
  const value = tf.match(new RegExp(`resource "${type}" "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(value); return value;
};
test('only twelve additive source-reader resources; no existing metadata identities or network changes', () => {
  const resources = [...tf.matchAll(/resource "([^"]+)" "([^"]+)"/g)];
  assert.equal(resources.length, 12);
  for (const [, type, name] of resources) {
    assert.match(name, /^vay2042_source_/);
    assert.ok(['aws_secretsmanager_secret','aws_cloudwatch_log_group','aws_iam_role','aws_iam_role_policy','aws_ecs_task_definition','aws_sfn_state_machine'].includes(type));
  }
  assert.match(block('aws_secretsmanager_secret', 'vay2042_source_reader'), /prevent_destroy = true/);
  assert.match(tf, /db-BB7GOFQ3BQTLTBG444I2Q75X6Y/);
});

test('fixed runner accepts only successful orchestration plus sanitized task evidence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'vay2042-runner-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fakeAws = `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (process.env.CASE === 'sdk-failure') { console.error('private-password raw-error'); process.exit(1); }
const arn = 'arn:aws:states:eu-west-1:269416271598:execution:vay2042-source-reader-bootstrap:fixture';
if (args[0] === 'sts') console.log('269416271598');
else if (args[1] === 'start-execution') console.log(arn);
else if (args[1] === 'describe-execution') console.log(JSON.stringify({status: 'SUCCEEDED', output: JSON.stringify({completion: {exitCode: process.env.CASE === 'bad-exit' ? 1 : 0}, result: {taskArn: 'arn:aws:ecs:eu-west-1:269416271598:task/vay2017-metadata-rehearsal/fixture'}})}));
else if (args[0] === 'logs') console.log(JSON.stringify([JSON.stringify({status:'OK',stage:'complete',scope:'isolated-source-reader',databases:4,tables:83})]));
else process.exit(2);
`;
  writeFileSync(join(directory, 'aws'), fakeAws, { mode: 0o755 });
  for (const sample of ['success', 'bad-exit', 'sdk-failure']) {
    const calls = join(directory, sample);
    const result = spawnSync('bash', ['scripts/run-vay2042-source-reader-bootstrap.sh'], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CASE: sample, CALLS: calls }, encoding: 'utf8', timeout: 5000,
    });
    if (sample === 'success') assert.equal(result.status, 0);
    else assert.ok(Number.isInteger(result.status) && result.status !== 0);
    assert.doesNotMatch(result.stdout + result.stderr, /private-password|raw-error/);
    if (sample === 'success') {
      assert.match(result.stdout, /Verified isolated source-reader bootstrap completed/);
      const invoked = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
      const start = invoked.find((args) => args[1] === 'start-execution');
      assert.equal(start[start.indexOf('--input') + 1], '{}');
      assert.equal(start[start.indexOf('--state-machine-arn') + 1], 'arn:aws:states:eu-west-1:269416271598:stateMachine:vay2042-source-reader-bootstrap');
    }
  }
});
test('master retrieval and source credential persistence are separated and exact', () => {
  const task = block('aws_iam_role_policy', 'vay2042_source_task');
  assert.match(task, /DescribeSecret.*PutSecretValue.*aws_secretsmanager_secret\.vay2042_source_reader\.arn/);
  assert.doesNotMatch(task, /GetSecretValue|master_user_secret/);
  assert.match(block('aws_iam_role_policy', 'vay2042_source_execution'), /GetSecretValue.*vay2017_isolated_restore\.master_user_secret/);
  const github = block('aws_iam_role_policy', 'vay2042_source_github');
  assert.doesNotMatch(github, /PassRole|ecs:|secretsmanager:|rds:/);
  assert.match(github, /StartExecution.*aws_sfn_state_machine\.vay2042_source_reader\.arn/);
});
test('fixed task and state machine reject caller command/network/role overrides', () => {
  assert.match(tf, /generated\/vay2042-source-reader-bootstrap\.mjs/);
  assert.match(tf, /local\.vay2017_rehearsal_ecr_repository_url}@\$\{local\.vay2017_rehearsal_image_digest}/);
  const sfn = block('aws_sfn_state_machine', 'vay2042_source_reader');
  assert.match(sfn, /EnableExecuteCommand = false/);
  assert.match(sfn, /AssignPublicIp = "DISABLED"/);
  assert.match(sfn, /aws_subnet\.vay2017_runner_private\.id/);
  assert.doesNotMatch(sfn, /Overrides|Parameters\.\$|TaskDefinition\.\$|InputPath/);
  assert.match(tf, /ecs:StopTask.*aws:ResourceTag\/VayadaOperation/);
  assert.match(tf, /ecs:TagResource.*ecs:CreateAction.*RunTask/);
});
test('data-purpose approval is distinct, main-only, serialized, and contains no arbitrary dispatch inputs', () => {
  assert.match(tf, /environment:vay2042-data-rehearsal/);
  assert.match(workflow, /environment: vay2042-data-rehearsal/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /group: vay2017-metadata-runner\s+cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /inputs:|workflow_call:|vay2017-metadata-preflight/);
  assert.match(runner, /--input '\{\}'/);
  assert.match(runner, /completion\.exitCode == 0/);
  assert.doesNotMatch(runner, /get-secret-value|terraform|ecs run-task|echo.*\$result/);
  execFileSync('bash', ['-n', 'scripts/run-vay2042-source-reader-bootstrap.sh']);
});
