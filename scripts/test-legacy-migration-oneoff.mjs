import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

const dispatcherPath = new URL('./legacy-migration-oneoff.mjs', import.meta.url).pathname;
const dispatcher = readFileSync(dispatcherPath, 'utf8');
const script = readFileSync(new URL('./legacy-migration-oneoff.sh', import.meta.url), 'utf8');
const RUN = 'vay1360-0123456789abcdef01234567';
const SOURCE_RUN = 'vay1351-0123456789abcdef01234567';
const [SOURCE_SHA, DIGEST] = readFileSync(new URL('./next-api-split-compatible-images.txt', import.meta.url), 'utf8').trim().split('\n').at(-1).split(' ');
const commandKinds = Object.fromEntries([...dispatcher.matchAll(/'(target:[a-z:-]+)': \['(target|source)'/g)].map((m) => [m[1], m[2]]));
const dispatch = (kind, env, preload = []) => spawnSync(process.execPath, [...preload, dispatcherPath, kind], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const blob = (files) => gzipSync(JSON.stringify(files)).toString('base64');

test('dispatcher and script share the four-command production allow-list', () => {
  assert.deepEqual(commandKinds, {
    'target:migration-status': 'target', 'target:cutover:abort': 'target', 'target:source:extract': 'source', 'target:cutover': 'source',
  });
  assert.ok(script.includes('target:migration-status|target:cutover:abort) kind="target"'));
  assert.ok(script.includes('target:source:extract|target:cutover) kind="source"'));
  assert.doesNotMatch(script, /dry-run/);
});

test('the dispatcher refuses anything outside the allow-list or with malformed inputs', () => {
  for (const [kind, env, code] of [
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:parity', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['target', { LEGACY_MIGRATION_COMMAND: '__proto__', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover:dry-run', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]' }, 'command_not_allowed_for_task'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '["a\\nb"]' }, 'arguments_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', LEGACY_MIGRATION_FILES: blob({ '../x': {} }) }, 'files_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', LEGACY_MIGRATION_FILES: 'e30=' }, 'files_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '["@manifest"]' }, 'file_missing'],
  ]) {
    const result = dispatch(kind, env);
    assert.equal(result.status, 64, JSON.stringify(env));
    assert.deepEqual(JSON.parse(result.stderr), { status: 'REFUSED', code });
  }
});

test('the dispatcher runs the mapped dist CLI with the reviewed files and keeps its exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-oneoff-dispatch-'));
  try {
    // Stub spawnSync in the child only: print what would run and the files it would read.
    writeFileSync(join(dir, 'stub.cjs'), `const cp = require('node:child_process'); const fs = require('node:fs');
cp.spawnSync = (file, argv) => { console.log(JSON.stringify({ argv, files: argv.filter((a) => a.endsWith('.json') && fs.existsSync(a)).map((a) => JSON.parse(fs.readFileSync(a, 'utf8'))) })); return { status: 7 }; };
require('node:module').syncBuiltinESMExports();`);
    const result = dispatch('source', {
      LEGACY_MIGRATION_COMMAND: 'target:cutover',
      LEGACY_MIGRATION_ARGS: JSON.stringify(['--manifest', '@manifest', '--operator', 'operator-name']),
      LEGACY_MIGRATION_FILES: blob({ manifest: { version: 1 } }),
    }, ['--require', join(dir, 'stub.cjs')]);
    assert.equal(result.status, 7, result.stderr);
    const [start, run] = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(start, { status: 'START', command: 'target:cutover', flags: ['--manifest', '--operator'] });
    assert.doesNotMatch(JSON.stringify(start), /operator-name/);
    assert.deepEqual(run.argv.filter((a) => !a.endsWith('.json')), ['/app/packages/backend-migration/dist/cli/cutover.js', 'cutover', '--manifest', '--operator', 'operator-name']);
    assert.deepEqual(run.files, [{ version: 1 }]);
    rmSync(join(run.argv[3], '..'), { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the script checks every input before AWS and runs exactly one pinned one-off task', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-oneoff-script-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const name of ['legacy-migration-oneoff.sh', 'legacy-migration-oneoff.mjs', 'next-api-split-compatible-images.txt'])
      copyFileSync(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name));
    const evidence = join(root, 'evidence');
    mkdirSync(evidence, { mode: 0o700 });
    const manifest = { version: 1, environment: 'preprod' };
    const runFile = join(root, 'run.json');
    const writeRun = (overrides = {}) => writeFileSync(runFile, JSON.stringify({
      runId: RUN, sourceRunId: SOURCE_RUN, sourceSha: SOURCE_SHA, imageDigest: DIGEST, files: { manifest },
      args: { 'target:cutover': ['--source-run-id', SOURCE_RUN, '--manifest', '@manifest'], 'target:cutover:abort': ['--operator', 'op'] },
      ...overrides,
    }));
    writeFileSync(join(root, 'account'), '269416271598');
    writeFileSync(join(root, 'running'), '0');
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/aws'), `#!/usr/bin/env bash
[[ "$1 $2 $3 $4" == "--profile vayada --region eu-west-1" ]] || { echo "unexpected aws options: $*" >&2; exit 9; }
shift 4
echo "$1 $2" >> "${root}/aws.log"
args=("$@"); for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == --cli-input-json ]] && printf '%s' "\${args[i+1]}" > "${root}/definition.json"
done
case "$1 $2" in
  "sts get-caller-identity") cat "${root}/account" ;;
  "ecs list-tasks") cat "${root}/running" ;;
  "ecs describe-services") echo '{"taskDefinition":"arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:9","networkConfiguration":{"awsvpcConfiguration":{"subnets":["subnet-1"]}}}' ;;
  "ecs describe-task-definition") echo '{"containerDefinitions":[{"name":"vayada-next-api","environment":[{"name":"PLATFORM_MEDIA_BUCKET","value":"vayada-media-production"},{"name":"PLATFORM_MEDIA_CDN_BASE_URL","value":"https://images.vayada.com"},{"name":"PORT","value":"8003"}]}]}' ;;
  "ecs register-task-definition") echo arn:aws:ecs:eu-west-1:269416271598:task-definition/oneoff:1 ;;
  "ecs run-task") echo '{"tasks":[{"taskArn":"arn:aws:ecs:eu-west-1:269416271598:task/vayada-target-database-runtime-preflight/0123456789abcdef0123456789abcdef"}],"failures":[]}' ;;
  "ecs describe-tasks") [[ "$*" == *lastStatus* ]] && echo STOPPED || echo '{"containers":[{"exitCode":4}]}' ;;
  "logs get-log-events") [[ "$*" == *next-token* ]] && echo '{"events":[],"nextForwardToken":"f/1"}' || echo '{"events":[{"message":"report"}],"nextForwardToken":"f/1"}' ;;
esac
`);
    chmodSync(join(root, 'bin/aws'), 0o755);
    const run = (command, confirmation, env = { EVIDENCE_DIR: evidence }) => {
      rmSync(join(root, 'aws.log'), { force: true });
      rmSync(join(root, 'definition.json'), { force: true });
      return spawnSync('bash', [join(root, 'scripts/legacy-migration-oneoff.sh'), command, runFile, confirmation],
        { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, AWS_PROFILE: 'other', ...env } });
    };
    const cutover = ['target:cutover', `PRODUCTION_CUTOVER:${RUN}:${SOURCE_RUN}`];
    const definition = () => JSON.parse(readFileSync(join(root, 'definition.json'), 'utf8'));
    const env = (def) => Object.fromEntries(def.containerDefinitions[0].environment.map((e) => [e.name, e.value]));

    writeRun();
    for (const [args, envOverride, message] of [
      [cutover, {}, /EVIDENCE_DIR/],
      [['target:cutover:dry-run', cutover[1]], undefined, /allow-list/],
      [[cutover[0], `PRODUCTION_CUTOVER:${RUN}:vay1351-wrong`], undefined, /Confirmation must be exactly PRODUCTION_CUTOVER:/],
    ]) {
      const result = run(...args, envOverride);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, message);
      assert.equal(existsSync(join(root, 'aws.log')), false);
    }
    writeRun({ imageDigest: `sha256:${'0'.repeat(64)}` });
    assert.match(run(...cutover).stderr, /reviewed pair/);
    assert.equal(existsSync(join(root, 'aws.log')), false);
    writeRun();

    writeFileSync(join(root, 'account'), '111111111111');
    assert.equal(run(...cutover).status, 1);
    assert.doesNotMatch(readFileSync(join(root, 'aws.log'), 'utf8'), /register/);
    writeFileSync(join(root, 'account'), '269416271598');
    writeFileSync(join(root, 'running'), '1');
    assert.match(run(...cutover).stderr, /still running/);
    assert.doesNotMatch(readFileSync(join(root, 'aws.log'), 'utf8'), /register/);
    writeFileSync(join(root, 'running'), '0');

    const launched = run(...cutover);
    assert.equal(launched.status, 4, launched.stderr);
    assert.match(readFileSync(join(root, 'aws.log'), 'utf8'), /ecs register-task-definition\necs run-task\n[\s\S]*ecs deregister-task-definition\n$/);
    const source = definition();
    assert.equal(source.family, 'vayada-legacy-migration-oneoff-source');
    assert.equal(source.executionRoleArn, 'arn:aws:iam::269416271598:role/ecsTaskExecutionRole');
    assert.equal(source.taskRoleArn, 'arn:aws:iam::269416271598:role/vayada-next-api-media-task-role');
    assert.equal(source.containerDefinitions[0].image, `269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@${DIGEST}`);
    assert.deepEqual(source.containerDefinitions[0].command, ['node', '--input-type=module', '--eval', dispatcher, 'source']);
    assert.deepEqual(source.containerDefinitions[0].secrets.map((s) => `${s.name}=${s.valueFrom.split(':parameter')[1]}`), [
      'TARGET_DATABASE_URL=/vayada/prod/target-database-url',
      'AUTH_SOURCE_DATABASE_URL=/vayada/prod/legacy-migration-source-auth-url',
      'BOOKING_SOURCE_DATABASE_URL=/vayada/prod/legacy-migration-source-booking-url',
      'MARKETPLACE_SOURCE_DATABASE_URL=/vayada/prod/legacy-migration-source-marketplace-url',
      'PMS_SOURCE_DATABASE_URL=/vayada/prod/legacy-migration-source-pms-url',
    ]);
    const sourceEnv = env(source);
    assert.deepEqual(JSON.parse(sourceEnv.LEGACY_MIGRATION_ARGS), ['--source-run-id', SOURCE_RUN, '--manifest', '@manifest', '--run-id', RUN,
      '--confirmation', `PRODUCTION_CUTOVER:${RUN}:${SOURCE_RUN}`, '--report', 'json']);
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(sourceEnv.LEGACY_MIGRATION_FILES, 'base64'))), { manifest });
    assert.equal(sourceEnv.PLATFORM_MEDIA_BUCKET, 'vayada-media-production');
    assert.equal(sourceEnv.LEGACY_MEDIA_BUCKET_ALLOWLIST, 'vayada-uploads-prod,vayada-creator-marketplace-images');
    assert.equal(sourceEnv.PORT, undefined);
    const [log] = readdirSync(evidence);
    assert.match(log, /^oneoff-target-cutover-vay1360-0123456789abcdef01234567-\d{8}T\d{6}Z\.log$/);
    assert.equal(readFileSync(join(evidence, log), 'utf8'), 'report\n');
    assert.equal(statSync(join(evidence, log)).mode & 0o777, 0o600);

    assert.equal(run('target:cutover:abort', `ABORT_CUTOVER:${RUN}`).status, 4);
    const target = definition();
    assert.equal(target.family, 'vayada-legacy-migration-oneoff-target');
    assert.equal(target.taskRoleArn, undefined);
    assert.deepEqual(target.containerDefinitions[0].secrets.map((s) => s.name), ['TARGET_DATABASE_URL']);
    assert.deepEqual(Object.keys(env(target)).sort(), ['AWS_REGION', 'LEGACY_MIGRATION_ARGS', 'LEGACY_MIGRATION_COMMAND', 'LEGACY_MIGRATION_FILES']);
    assert.deepEqual(JSON.parse(env(target).LEGACY_MIGRATION_ARGS), ['--operator', 'op', '--run-id', RUN, '--confirmation', `ABORT_CUTOVER:${RUN}`, '--report', 'json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
