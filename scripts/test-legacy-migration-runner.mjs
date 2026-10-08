import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tf = read('infra/legacy_migration_runner.tf');
const workflow = read('.github/workflows/legacy-migration-runner.yml');
const launcher = read('scripts/run-legacy-migration-runner.sh');
const dispatcherPath = new URL('../scripts/legacy-migration-runner.mjs', import.meta.url).pathname;
const dispatcher = readFileSync(dispatcherPath, 'utf8');
const pin = JSON.parse(read('deployment/legacy-migration-runner.json'));
const RUN = 'vay1360-0123456789abcdef01234567';
const SOURCE_RUN = 'vay1351-0123456789abcdef01234567';

const commandKinds = Object.fromEntries([...dispatcher.matchAll(/'(target:[a-z:-]+)': \['(target|source)'/g)].map((m) => [m[1], m[2]]));

test('the allow-list is the same in the workflow, launcher, dispatcher and doc', () => {
  const allowed = ['target:migration-status', 'target:source:extract', 'target:cutover:dry-run', 'target:cutover', 'target:cutover:abort'];
  assert.deepEqual(Object.keys(commandKinds).sort(), [...allowed].sort());
  assert.deepEqual([...workflow.matchAll(/^ {10}- (target:\S+)$/gm)].map((m) => m[1]), allowed);
  for (const [kind, line] of [['target', 'target:migration-status|target:cutover:abort'], ['source', 'target:source:extract|target:cutover:dry-run|target:cutover']]) {
    assert.ok(launcher.includes(`${line}) kind="${kind}"`));
    for (const command of line.split('|')) assert.equal(commandKinds[command], kind);
  }
  for (const command of allowed) assert.match(read('docs/legacy-migration-runner.md'), new RegExp(`\\| \`${command}\` \\|`));
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
  assert.equal([...tf.matchAll(/Effect {3,4}= "Deny"/g)].length, 4);
  assert.doesNotMatch(tf, /"s3:\*"|"ecs:\*"|"iam:\*"|ssm:GetParametersByPath|Action\s+= "\*"/);
});

const dispatch = (kind, env) => spawnSync(process.execPath, [dispatcherPath, kind], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('the dispatcher refuses anything outside the allow-list or with malformed inputs', () => {
  for (const [kind, env, code] of [
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:parity', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['target', { LEGACY_MIGRATION_COMMAND: '__proto__', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed_for_task'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed_for_task'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '{}' }, 'arguments_invalid'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '["a\\nb"]' }, 'arguments_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', LEGACY_MIGRATION_FILES: '{"../x":"e30="}' }, 'files_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', LEGACY_MIGRATION_FILES: '{"manifest":"e30="}' }, 'files_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '["@manifest"]' }, 'file_missing'],
  ]) {
    const result = dispatch(kind, env);
    assert.equal(result.status, 64, JSON.stringify(env));
    assert.deepEqual(JSON.parse(result.stderr), { status: 'REFUSED', code });
  }
});

test('the launcher refuses before any AWS call outside the reviewed workflow inputs', () => {
  const run = (args, env = {}) => spawnSync('bash', [new URL('../scripts/run-legacy-migration-runner.sh', import.meta.url).pathname, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ci = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'vayada-marketplace/vayada-platform' };
  const ok = ['target:migration-status', pin.image_digest, RUN, `MIGRATION_STATUS:${RUN}`];
  assert.equal(run(ok).status, 2);
  assert.match(run(['target:parity', ...ok.slice(1)], ci).stderr, /allow-list/);
  assert.match(run([ok[0], `sha256:${'0'.repeat(64)}`, ...ok.slice(2)], ci).stderr, /pinned runner image/);
  assert.match(run([ok[0], ok[1], 'vay1360-x', ok[3]], ci).stderr, /vay1360/);
  assert.match(run(ok, ci).stderr, /No reviewed run file/);
});

test('launcher and dispatcher together run exactly the reviewed CLI call', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-migration-runner-test-'));
  try {
    for (const path of ['scripts/run-legacy-migration-runner.sh', 'scripts/legacy-migration-runner.mjs', 'deployment/legacy-migration-runner.json']) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
    }
    mkdirSync(join(root, 'deployment/legacy-migration-runs'));
    const manifest = { version: 1, environment: 'preprod' };
    writeFileSync(join(root, `deployment/legacy-migration-runs/${RUN}.json`), JSON.stringify({
      runId: RUN, sourceRunId: SOURCE_RUN,
      args: { 'target:cutover:dry-run': ['--source-run-id', SOURCE_RUN, '--manifest', '@manifest'] },
      files: { manifest },
    }));
    const image = `269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@${pin.image_digest}`;
    const definition = (overrides) => JSON.stringify({ status: 'ACTIVE', taskDefinitionArn: 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-legacy-migration-runner-source:1',
      containerDefinitions: [{ name: 'vayada-legacy-migration-runner', image, command: ['node', '--input-type=module', '--eval', dispatcher, 'source'], ...overrides }] });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/aws'), `#!/usr/bin/env bash
echo "$1 $2" >> "${root}/aws.log"
args=("$@"); for ((i = 0; i < \${#args[@]}; i++)); do [[ "\${args[i]}" == --overrides ]] && printf '%s' "\${args[i+1]}" > "${root}/overrides.json"; done
case "$1 $2" in
  "ecs describe-task-definition") cat "${root}/definition.json" ;;
  "ecs describe-services") echo '{"awsvpcConfiguration":{"subnets":["subnet-1"]}}' ;;
  "ecs run-task") echo arn:aws:ecs:eu-west-1:269416271598:task/vayada-legacy-migration-runner/0123456789abcdef0123456789abcdef ;;
  "ecs describe-tasks") [[ "$*" == *exitCode* ]] && echo 4 || echo STOPPED ;;
  "logs get-log-events") echo '["report"]' ;;
esac
`);
    chmodSync(join(root, 'bin/aws'), 0o755);
    const launch = () => spawnSync('bash', [join(root, 'scripts/run-legacy-migration-runner.sh'), 'target:cutover:dry-run', pin.image_digest, RUN, `CUTOVER_DRY_RUN:${RUN}:${SOURCE_RUN}`], {
      encoding: 'utf8',
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'vayada-marketplace/vayada-platform', GITHUB_RUN_ID: '1' },
    });

    assert.match(spawnSync('bash', [join(root, 'scripts/run-legacy-migration-runner.sh'), 'target:cutover:dry-run', pin.image_digest, RUN, `CUTOVER_DRY_RUN:${RUN}:vay1351-wrong`],
      { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'vayada-marketplace/vayada-platform' } }).stderr,
    /Confirmation must be exactly CUTOVER_DRY_RUN:/);

    writeFileSync(join(root, 'definition.json'), definition({ image: `${image.slice(0, -1)}0` }));
    assert.equal(launch().status, 1);
    assert.doesNotMatch(readFileSync(join(root, 'aws.log'), 'utf8'), /run-task/);

    writeFileSync(join(root, 'definition.json'), definition({}));
    const launched = launch();
    assert.equal(launched.status, 4, launched.stderr);
    assert.match(launched.stdout, /Task exit code: 4/);
    const environment = Object.fromEntries(JSON.parse(readFileSync(join(root, 'overrides.json'), 'utf8')).containerOverrides[0].environment.map((e) => [e.name, e.value]));
    assert.deepEqual(JSON.parse(environment.LEGACY_MIGRATION_ARGS), ['--source-run-id', SOURCE_RUN, '--manifest', '@manifest', '--run-id', RUN,
      '--confirmation', `CUTOVER_DRY_RUN:${RUN}:${SOURCE_RUN}`, '--report', 'json']);

    const result = dispatch('source', environment);
    const start = JSON.parse(result.stdout.split('\n')[0]);
    assert.equal(start.command, 'target:cutover:dry-run');
    assert.deepEqual(JSON.parse(readFileSync(start.argv[3], 'utf8')), manifest);
    rmSync(join(start.argv[3], '..'), { recursive: true, force: true });
    assert.match(result.stderr, /\/app\/packages\/backend-migration\/dist\/cli\/cutover\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
