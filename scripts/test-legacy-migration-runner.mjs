import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tf = read('infra/legacy_migration_runner.tf');
const dispatcherPath = new URL('../scripts/legacy-migration-runner.mjs', import.meta.url).pathname;
const dispatcher = readFileSync(dispatcherPath, 'utf8');
const workflow = read('.github/workflows/legacy-migration-runner.yml');
const launcher = read('scripts/run-legacy-migration-runner.sh');
const RUN = 'vay1360-0123456789abcdef01234567';
const SOURCE_RUN = 'vay1351-0123456789abcdef01234567';
const CI = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'vayada-marketplace/vayada-platform', GITHUB_RUN_ID: '1' };
const pin = JSON.parse(read('deployment/legacy-migration-runner.json'));

const commandKinds = Object.fromEntries([...dispatcher.matchAll(/'(target:[a-z:-]+)': \['(target|source)'/g)].map((m) => [m[1], m[2]]));

test('the dispatcher allow-list is exactly the four production commands', () => {
  assert.deepEqual(commandKinds, {
    'target:migration-status': 'target', 'target:cutover:abort': 'target',
    'target:source:extract': 'source', 'target:cutover': 'source',
  });
});

test('the workflow, launcher and doc carry the same allow-list', () => {
  const allowed = Object.keys(commandKinds);
  assert.deepEqual([...workflow.matchAll(/^ {10}- (target:\S+)$/gm)].map((m) => m[1]).sort(), [...allowed].sort());
  for (const kind of ['target', 'source']) {
    const line = allowed.filter((command) => commandKinds[command] === kind).join('|');
    assert.ok(launcher.includes(`${line}) kind="${kind}"`), line);
  }
  for (const command of allowed) assert.match(read('docs/legacy-migration-runner.md'), new RegExp(`\\| \`${command}\` \\|`));
  assert.doesNotMatch(workflow + launcher, /dry-run/);
});

test('the workflow is manual, main-only, approval-gated and never interpolates inputs into shell', () => {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|pull_request_target|schedule|repository_dispatch|workflow_run):/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'\n {4}environment: platform-mutations-v2\n/);
  assert.match(workflow, /role-to-assume: arn:aws:iam::269416271598:role\/vayada-github-actions-legacy-migration-runner\n/);
  assert.doesNotMatch(workflow.split('run: ').slice(1).join(''), /\$\{\{/);
});

test('the image pin is a reviewed next-api pair', () => {
  assert.match(pin.image_digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(read('scripts/next-api-split-compatible-images.txt').split('\n').includes(`${pin.source_sha} ${pin.image_digest}`));
});

test('Terraform adds only new runner resources with least privilege', () => {
  assert.deepEqual([...tf.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`), [
    'aws_ecs_cluster.legacy_migration_runner', 'aws_cloudwatch_log_group.legacy_migration_runner',
    'aws_iam_role.legacy_migration_runner_execution', 'aws_iam_role_policy_attachment.legacy_migration_runner_execution',
    'aws_iam_role_policy.legacy_migration_runner_execution', 'aws_iam_role.legacy_migration_runner_task',
    'aws_iam_role_policy.legacy_migration_runner_task', 'aws_ecs_task_definition.legacy_migration_runner',
    'aws_iam_role.legacy_migration_runner_controller', 'aws_iam_role_policy.legacy_migration_runner_controller',
    'aws_iam_policy.legacy_migration_runner_refresh', 'aws_iam_role_policy_attachment.legacy_migration_runner_refresh',
  ]);
  assert.doesNotMatch(tf, /^(import|moved|removed|data) /m);
  assert.match(tf, /target = \{ secrets = \{ TARGET_DATABASE_URL = local\.legacy_migration_target_url \}, environment = \[\] \}/);
  assert.match(tf, /legacy_migration_target_url {2}= "\/vayada\/prod\/target-database-url"/);
  assert.match(tf, /task_role_arn {12}= each\.key == "source" \? aws_iam_role\.legacy_migration_runner_task\.arn : null/);
  assert.match(tf, /"token\.actions\.githubusercontent\.com:sub" = local\.platform_mutation_subject/);
  assert.match(tf, /Action {4}= "ecs:RunTask"\n\s+Resource {2}= "\$\{local\.legacy_migration_runner_family_arn\}:\*"\n\s+Condition = \{ ArnEquals = \{ "ecs:cluster" = aws_ecs_cluster\.legacy_migration_runner\.arn \} \}/);
  assert.match(tf, /command {5}= \["node", "--input-type=module", "--eval", local\.legacy_migration_runner_code, each\.key\]/);
  assert.equal([...tf.matchAll(/Effect {3,4}= "Deny"/g)].length, 6);
  assert.match(tf, /"ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:RunTask"/);
  assert.doesNotMatch(tf, /"s3:\*"|"ecs:\*"|"iam:\*"|ssm:GetParametersByPath|Action\s+= "\*"/);
});

const dispatch = (kind, env, preload = []) => spawnSync(process.execPath, [...preload, dispatcherPath, kind], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const blob = (files) => gzipSync(JSON.stringify(files)).toString('base64');

test('the dispatcher refuses anything outside the allow-list or with malformed inputs', () => {
  for (const [kind, env, code] of [
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:parity', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['target', { LEGACY_MIGRATION_COMMAND: '__proto__', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed_for_task'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed_for_task'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '{}' }, 'arguments_invalid'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '["a\\nb"]' }, 'arguments_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover:dry-run', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', LEGACY_MIGRATION_FILES: blob({ '../x': {} }) }, 'files_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', LEGACY_MIGRATION_FILES: 'e30=' }, 'files_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', LEGACY_MIGRATION_FILES: blob([]) }, 'files_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '["@manifest"]' }, 'file_missing'],
  ]) {
    const result = dispatch(kind, env);
    assert.equal(result.status, 64, JSON.stringify(env));
    assert.deepEqual(JSON.parse(result.stderr), { status: 'REFUSED', code });
  }
});

test('the dispatcher runs the mapped dist CLI with the reviewed files and keeps its exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-migration-dispatch-test-'));
  try {
    // Stub spawnSync in the child only: print what would run and the files it would read.
    writeFileSync(join(dir, 'stub.cjs'), `const cp = require('node:child_process'); const fs = require('node:fs');
cp.spawnSync = (file, argv) => { console.log(JSON.stringify({ argv, files: argv.filter((a) => a.startsWith('/') && fs.existsSync(a) && a.endsWith('.json')).map((a) => JSON.parse(fs.readFileSync(a, 'utf8'))) })); return { status: 7 }; };
require('node:module').syncBuiltinESMExports();`);
    const result = dispatch('source', {
      LEGACY_MIGRATION_COMMAND: 'target:cutover',
      LEGACY_MIGRATION_ARGS: JSON.stringify(['--manifest', '@manifest', '--operator', 'operator-name']),
      LEGACY_MIGRATION_FILES: blob({ manifest: { version: 1 } }),
    }, ['--require', join(dir, 'stub.cjs')]);
    assert.equal(result.status, 7, result.stderr);
    const [start, run] = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(start, { status: 'START', command: 'target:cutover', flags: ['--manifest', '--operator'] });
    assert.doesNotMatch(result.stdout.split('\n')[0], /operator-name/);
    assert.deepEqual(run.argv.filter((a) => !a.endsWith('.json')), ['/app/packages/backend-migration/dist/cli/cutover.js', 'cutover', '--manifest', '--operator', 'operator-name']);
    assert.deepEqual(run.files, [{ version: 1 }]);
    rmSync(join(run.argv[3], '..'), { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the launcher refuses before any AWS call outside the reviewed workflow inputs', () => {
  const run = (args, env = {}) => spawnSync('bash', [new URL('../scripts/run-legacy-migration-runner.sh', import.meta.url).pathname, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ok = ['target:migration-status', pin.image_digest, RUN, `MIGRATION_STATUS:${RUN}`];
  assert.equal(run(ok).status, 2);
  assert.match(run(['target:cutover:dry-run', ...ok.slice(1)], CI).stderr, /allow-list/);
  assert.match(run([ok[0], `sha256:${'0'.repeat(64)}`, ...ok.slice(2)], CI).stderr, /pinned runner image/);
  assert.match(run([ok[0], ok[1], 'vay1360-x', ok[3]], CI).stderr, /vay1360/);
  assert.match(run(ok, CI).stderr, /No reviewed run file/);
});

test('launcher and dispatcher together run exactly the reviewed CLI call', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-migration-runner-test-'));
  try {
    for (const path of ['scripts/run-legacy-migration-runner.sh', 'scripts/legacy-migration-runner.mjs', 'deployment/legacy-migration-runner.json']) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
    }
    mkdirSync(join(root, 'deployment/legacy-migration-runs'));
    const runFile = (files) => writeFileSync(join(root, `deployment/legacy-migration-runs/${RUN}.json`), JSON.stringify({
      runId: RUN, sourceRunId: SOURCE_RUN, files,
      args: { 'target:cutover': ['--source-run-id', SOURCE_RUN, '--manifest', '@manifest'], 'target:cutover:abort': ['--operator', 'op'] },
    }));
    const manifest = { version: 1, environment: 'preprod' };
    const image = `269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@${pin.image_digest}`;
    const definitions = (overrides = {}) => {
      for (const kind of ['target', 'source']) writeFileSync(join(root, `vayada-legacy-migration-runner-${kind}.json`), JSON.stringify({
        status: 'ACTIVE', taskDefinitionArn: `arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-legacy-migration-runner-${kind}:1`,
        containerDefinitions: [{ name: 'vayada-legacy-migration-runner', image, command: ['node', '--input-type=module', '--eval', dispatcher, kind], ...overrides }],
      }));
    };
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/aws'), `#!/usr/bin/env bash
echo "$1 $2" >> "${root}/aws.log"
args=("$@"); for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == --overrides ]] && printf '%s' "\${args[i+1]}" > "${root}/overrides.json"
  [[ "\${args[i]}" == --task-definition && "$2" == describe-task-definition ]] && cat "${root}/\${args[i+1]}.json"
done
case "$1 $2" in
  "ecs list-tasks") cat "${root}/running" ;;
  "ecs describe-services") echo '{"awsvpcConfiguration":{"subnets":["subnet-1"]}}' ;;
  "ecs run-task") echo '{"tasks":[{"taskArn":"arn:aws:ecs:eu-west-1:269416271598:task/vayada-legacy-migration-runner/0123456789abcdef0123456789abcdef"}],"failures":[]}' ;;
  "ecs describe-tasks") [[ "$*" == *lastStatus* ]] && echo STOPPED || echo '{"containers":[{"exitCode":4}]}' ;;
  "logs get-log-events") [[ "$*" == *next-token* ]] && echo '{"events":[],"nextForwardToken":"f/1"}' || echo '{"events":[{"message":"report"}],"nextForwardToken":"f/1"}' ;;
esac
`);
    chmodSync(join(root, 'bin/aws'), 0o755);
    const launch = (command, confirmation) => {
      rmSync(join(root, 'aws.log'), { force: true });
      return spawnSync('bash', [join(root, 'scripts/run-legacy-migration-runner.sh'), command, pin.image_digest, RUN, confirmation],
        { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...CI } });
    };
    const awsCalls = () => readFileSync(join(root, 'aws.log'), 'utf8');
    const cutover = ['target:cutover', `PRODUCTION_CUTOVER:${RUN}:${SOURCE_RUN}`];
    writeFileSync(join(root, 'running'), '0');

    runFile({ manifest });
    assert.match(launch(cutover[0], `PRODUCTION_CUTOVER:${RUN}:vay1351-wrong`).stderr, /Confirmation must be exactly PRODUCTION_CUTOVER:/);
    definitions({ image: `${image.slice(0, -1)}0` });
    assert.equal(launch(...cutover).status, 1);
    assert.doesNotMatch(awsCalls(), /run-task/);
    definitions();
    writeFileSync(join(root, 'running'), '1');
    assert.match(launch(...cutover).stderr, /already running/);
    assert.doesNotMatch(awsCalls(), /run-task/);
    writeFileSync(join(root, 'running'), '0');
    runFile({ manifest, report: { blob: Array.from({ length: 4000 }, (_, i) => i.toString(36)).join('') } });
    assert.match(launch(...cutover).stderr, /8192-byte/);
    runFile({ manifest });

    const launched = launch(...cutover);
    assert.equal(launched.status, 4, launched.stderr);
    assert.match(launched.stdout, /^report$/m);
    assert.match(launched.stdout, /Task exit code: 4/);
    const environment = Object.fromEntries(JSON.parse(readFileSync(join(root, 'overrides.json'), 'utf8')).containerOverrides[0].environment.map((e) => [e.name, e.value]));
    assert.deepEqual(JSON.parse(environment.LEGACY_MIGRATION_ARGS), ['--source-run-id', SOURCE_RUN, '--manifest', '@manifest', '--run-id', RUN,
      '--confirmation', `PRODUCTION_CUTOVER:${RUN}:${SOURCE_RUN}`, '--report', 'json']);
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(environment.LEGACY_MIGRATION_FILES, 'base64'))), { manifest });
    const refused = dispatch('target', environment);
    assert.deepEqual(JSON.parse(refused.stderr), { status: 'REFUSED', code: 'command_not_allowed_for_task' });

    assert.equal(launch('target:cutover:abort', `ABORT_CUTOVER:${RUN}`).status, 4);
    assert.match(awsCalls(), /describe-task-definition/);
    const abort = JSON.parse(readFileSync(join(root, 'overrides.json'), 'utf8')).containerOverrides[0].environment;
    assert.deepEqual(JSON.parse(abort.find((e) => e.name === 'LEGACY_MIGRATION_ARGS').value),
      ['--operator', 'op', '--run-id', RUN, '--confirmation', `ABORT_CUTOVER:${RUN}`, '--report', 'json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
