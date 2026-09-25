import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tf = read('infra/vay2017-metadata-runner/target_bootstrap.tf');
const source = read('infra/vay2017-metadata-runner/source_reader.tf');
const workflow = read('.github/workflows/vay2042-target-bootstrap.yml');
const runner = read('scripts/run-vay2042-target-bootstrap.sh');
const block = (text, type, name) => {
  const value = text.match(new RegExp(`resource "${type}" "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(value); return value;
};
test('seven target resources reuse only the data execution/log/network boundary', () => {
  assert.deepEqual([...tf.matchAll(/resource "([^"]+)" "([^"]+)"/g)].map((m) => m.slice(1)), [
    ['aws_secretsmanager_secret','vay2042_target_writer'], ['aws_iam_role','vay2042_target_task'],
    ['aws_iam_role_policy','vay2042_target_task'], ['aws_ecs_task_definition','vay2042_target_bootstrap'],
    ['aws_iam_role','vay2042_target_orchestrator'], ['aws_iam_role_policy','vay2042_target_orchestrator'],
    ['aws_sfn_state_machine','vay2042_target_bootstrap'],
  ]);
  assert.match(tf, /target-writer\/vay2017-metadata-rehearsal-isolated-20260923-20260925/);
  assert.match(block(tf, 'aws_secretsmanager_secret', 'vay2042_target_writer'), /prevent_destroy = true/);
  assert.match(tf, /execution_role_arn\s+= aws_iam_role\.vay2042_source_execution\.arn/);
  assert.match(tf, /aws_cloudwatch_log_group\.vay2042_source_reader\.name/);
  const task = block(tf, 'aws_iam_role_policy', 'vay2042_target_task');
  assert.match(task, /DescribeSecret.*PutSecretValue.*aws_secretsmanager_secret\.vay2042_target_writer\.arn/);
  assert.doesNotMatch(task, /GetSecretValue|source_reader|master_user_secret|vay2017_reader/);
  const orchestrator = block(tf, 'aws_iam_role_policy', 'vay2042_target_orchestrator');
  assert.match(orchestrator, /RunTask.*aws_ecs_task_definition\.vay2042_target_bootstrap\.arn/);
  assert.match(orchestrator, /PassRole.*\[aws_iam_role\.vay2042_source_execution\.arn, aws_iam_role\.vay2042_target_task\.arn\]/);
  assert.match(orchestrator, /StopTask.*aws:ResourceTag\/VayadaOperation.*local\.vay2042_target_name/);
  assert.match(orchestrator, /TagResource.*ecs:CreateAction.*RunTask.*aws:RequestTag\/VayadaOperation.*local\.vay2042_target_name/);
  for (const type of ['aws_iam_role', 'aws_iam_role_policy']) assert.doesNotMatch(block(source, type, 'vay2042_source_orchestrator'), /vay2042_target/);
});
test('fixed target command, secret and network cannot be selected by workflow input', () => {
  assert.match(tf, /generated\/vay2042-target-bootstrap\.mjs/);
  assert.match(tf, /VAY2042_RUN_TARGET_MAIN/);
  assert.match(tf, /VAY2042_WRITER_SECRET_ARN.*aws_secretsmanager_secret\.vay2042_target_writer\.arn/);
  assert.match(tf, /local\.vay2017_rehearsal_ecr_repository_url}@\$\{local\.vay2017_rehearsal_image_digest}/);
  assert.match(tf, /db-BB7GOFQ3BQTLTBG444I2Q75X6Y.*10\.230\.0\.0\/24/);
  assert.match(tf, /ArnEquals.*aws:SourceArn.*local\.vay2042_target_arn/);
  assert.match(tf, /EnableExecuteCommand = false/);
  assert.match(tf, /Subnets = \[aws_subnet\.vay2017_runner_private\.id\].*SecurityGroups = \[aws_security_group\.vay2017_rehearsal_runner\.id\].*AssignPublicIp = "DISABLED"/);
  assert.doesNotMatch(tf, /Overrides|Parameters\.\$|TaskDefinition\.\$|InputPath|VAY2042_READER_SECRET_ARN|VAY2042_RUN_MAIN/);
  const github = block(source, 'aws_iam_role_policy', 'vay2042_source_github');
  assert.match(github, /StartExecution.*aws_sfn_state_machine\.vay2042_target_bootstrap\.arn/);
  assert.match(github, /DescribeExecution.*execution:\$\{local\.vay2042_target_name\}:\*/);
  assert.doesNotMatch(github, /PassRole|ecs:|secretsmanager:|rds:/);
  assert.match(workflow, /environment: vay2042-data-rehearsal/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /group: vay2017-metadata-runner\s+cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /inputs:|workflow_call:|vay2017-metadata-preflight/);
  assert.doesNotMatch(runner, /get-secret-value|terraform|ecs run-task|echo.*\$result/);
  execFileSync('bash', ['-n', 'scripts/run-vay2042-target-bootstrap.sh']);
});
test('runner requires the fixed execution, zero exit and target evidence; failures stay sanitized', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'vay2042-target-runner-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(directory, 'aws'), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2), sample = process.env.CASE;
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (sample === 'sdk-failure') { console.error('private-password raw-error'); process.exit(1); }
if (args[0] === 'sts') console.log(sample === 'wrong-account' ? '111111111111' : '269416271598');
else if (args[1] === 'start-execution') console.log('arn:aws:states:eu-west-1:269416271598:execution:' + (sample === 'wrong-execution' ? 'vay2042-source-reader-bootstrap' : 'vay2042-target-bootstrap') + ':fixture');
else if (args[1] === 'describe-execution') {
  if (sample === 'malformed') console.log('private-password raw-error');
  else console.log(JSON.stringify({status: 'SUCCEEDED', output: JSON.stringify({completion: {exitCode: sample === 'bad-exit' ? 1 : 0}, result: {taskArn: 'arn:aws:ecs:eu-west-1:269416271598:task/' + (sample === 'wrong-cluster' ? 'production' : 'vay2017-metadata-rehearsal') + '/fixture'}})}));
} else if (args[0] === 'logs') console.log(JSON.stringify([JSON.stringify(sample === 'wrong-record' ? {status:'OK',stage:'complete',scope:'isolated-source-reader',databases:4,tables:83} : sample === 'unknown-activation' ? {status:'FAIL',stage:'target-bootstrap',code:'target_writer_activation_outcome_unknown',errorClass:'Error'} : {status:'OK',stage:'complete',scope:'isolated-fresh-target',bound:false})]));
else process.exit(2);
`, { mode: 0o755 });
  for (const sample of ['success','bad-exit','sdk-failure','malformed','wrong-account','wrong-execution','wrong-cluster','wrong-record','unknown-activation']) {
    const calls = join(directory, sample);
    const result = spawnSync('bash', ['scripts/run-vay2042-target-bootstrap.sh'], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CASE: sample, CALLS: calls }, encoding: 'utf8', timeout: 5000,
    });
    assert.ok(Number.isInteger(result.status), sample);
    assert.equal(result.status === 0, sample === 'success', sample);
    assert.doesNotMatch(result.stdout + result.stderr, /private-password|raw-error/);
    const invoked = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    if (sample === 'success') {
      assert.match(result.stdout, /target remains unbound/);
      const start = invoked.find((args) => args[1] === 'start-execution');
      assert.equal(start[start.indexOf('--input') + 1], '{}');
      assert.equal(start[start.indexOf('--state-machine-arn') + 1], 'arn:aws:states:eu-west-1:269416271598:stateMachine:vay2042-target-bootstrap');
      const logs = invoked.find((args) => args[0] === 'logs');
      assert.equal(logs[logs.indexOf('--log-stream-name') + 1], 'target/target-bootstrap/fixture');
    } else assert.match(result.stderr, /inspect its sanitized task status before any retry/);
    if (sample === 'wrong-account') assert.equal(invoked.length, 1);
  }
});
