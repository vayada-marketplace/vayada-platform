import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tf = read('infra/legacy_migration_runner.tf');
const dispatcherPath = new URL('../scripts/legacy-migration-runner.mjs', import.meta.url).pathname;
const dispatcher = readFileSync(dispatcherPath, 'utf8');
const pin = JSON.parse(read('deployment/legacy-migration-runner.json'));

const commandKinds = Object.fromEntries([...dispatcher.matchAll(/'(target:[a-z:-]+)': \['(target|source)'/g)].map((m) => [m[1], m[2]]));

test('the dispatcher allow-list is exactly the five migration commands', () => {
  assert.deepEqual(commandKinds, {
    'target:migration-status': 'target', 'target:cutover:abort': 'target',
    'target:source:extract': 'source', 'target:cutover:dry-run': 'source', 'target:cutover': 'source',
  });
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
