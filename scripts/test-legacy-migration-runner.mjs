import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tf = read('infra/legacy_migration_runner.tf');
const dispatcherPath = new URL('../scripts/legacy-migration-runner.mjs', import.meta.url).pathname;
const dispatcher = readFileSync(dispatcherPath, 'utf8');
const pin = JSON.parse(read('deployment/legacy-migration-runner.json'));

const commandKinds = Object.fromEntries([...dispatcher.matchAll(/'(target:[a-z:-]+)': \['(target|source)'/g)].map((m) => [m[1], m[2]]));

test('the dispatcher allow-list is exactly the four production commands', () => {
  assert.deepEqual(commandKinds, {
    'target:migration-status': 'target', 'target:cutover:abort': 'target',
    'target:source:extract': 'source', 'target:cutover': 'source',
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
