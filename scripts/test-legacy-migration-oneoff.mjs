import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    const writeRun = (overrides = {}) => {
      writeFileSync(runFile, JSON.stringify({
        runId: RUN, sourceRunId: SOURCE_RUN, sourceSha: SOURCE_SHA, imageDigest: DIGEST, files: { manifest },
        args: { 'target:cutover': ['--source-run-id', SOURCE_RUN, '--manifest', '@manifest'], 'target:cutover:abort': ['--operator', 'op'] },
        ...overrides,
      }));
      return createHash('sha256').update(readFileSync(runFile)).digest('hex');
    };
    const state = (name, value) => writeFileSync(join(root, name), value);
    state('account', '269416271598');
    state('running', '0');
    state('describe-fails', '0');
    state('run-task', '{"tasks":[{"taskArn":"arn:aws:ecs:eu-west-1:269416271598:task/vayada-target-database-runtime-preflight/0123456789abcdef0123456789abcdef"}],"failures":[]}');
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
  "ecs run-task") cat "${root}/run-task" ;;
  "ecs describe-tasks")
    if [[ "$(cat "${root}/describe-fails")" != 0 ]]; then echo 0 > "${root}/describe-fails"; exit 255; fi
    [[ "$*" == *lastStatus* ]] && echo STOPPED || echo '{"containers":[{"exitCode":4}]}' ;;
  "logs get-log-events") [[ "$*" == *next-token* ]] && echo '{"events":[],"nextForwardToken":"f/1"}' || echo '{"events":[{"message":"report"}],"nextForwardToken":"f/1"}' ;;
esac
`);
    chmodSync(join(root, 'bin/aws'), 0o755);
    const script = join(root, 'scripts/legacy-migration-oneoff.sh');
    const run = (args, env = { EVIDENCE_DIR: evidence }) => {
      rmSync(join(root, 'aws.log'), { force: true });
      rmSync(join(root, 'definition.json'), { force: true });
      return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, AWS_PROFILE: 'other', ...env } });
    };
    const awsCalls = () => (existsSync(join(root, 'aws.log')) ? readFileSync(join(root, 'aws.log'), 'utf8') : '');
    const definition = () => JSON.parse(readFileSync(join(root, 'definition.json'), 'utf8'));
    const env = (def) => Object.fromEntries(def.containerDefinitions[0].environment.map((e) => [e.name, e.value]));
    const sha = writeRun();
    const cutover = ['target:cutover', runFile, sha, `PRODUCTION_CUTOVER:${RUN}:${SOURCE_RUN}`];

    const open = join(root, 'open');
    mkdirSync(open, { mode: 0o755 });
    for (const [args, envOverride, message] of [
      [cutover, {}, /EVIDENCE_DIR/],
      [cutover, { EVIDENCE_DIR: open }, /0700/],
      [['target:cutover:dry-run', ...cutover.slice(1)], undefined, /allow-list/],
      [[cutover[0], runFile, '0'.repeat(64), cutover[3]], undefined, /SHA-256 differs/],
      [[...cutover.slice(0, 3), `PRODUCTION_CUTOVER:${RUN}:vay1351-wrong`], undefined, /Confirmation must be exactly PRODUCTION_CUTOVER:/],
    ]) {
      const result = run(args, envOverride);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, message);
      assert.equal(awsCalls(), '');
    }
    const badImage = writeRun({ imageDigest: `sha256:${'0'.repeat(64)}` });
    assert.match(run([cutover[0], runFile, badImage, cutover[3]]).stderr, /reviewed pair/);
    assert.equal(awsCalls(), '');
    writeRun();

    state('account', '111111111111');
    assert.equal(run(cutover).status, 1);
    assert.doesNotMatch(awsCalls(), /register/);
    state('account', '269416271598');
    state('running', '1');
    assert.match(run(cutover).stderr, /still running/);
    assert.doesNotMatch(awsCalls(), /register/);
    state('running', '0');
    state('run-task', '{"tasks":[],"failures":[{"reason":"RESOURCE:MEMORY"}]}');
    const failed = run(cutover);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /RESOURCE:MEMORY/);
    assert.match(awsCalls(), /ecs deregister-task-definition\necs delete-task-definitions\n$/);
    state('run-task', '{"tasks":[{"taskArn":"arn:aws:ecs:eu-west-1:269416271598:task/vayada-target-database-runtime-preflight/0123456789abcdef0123456789abcdef"}],"failures":[]}');

    state('describe-fails', '1');
    const launched = run(cutover);
    assert.equal(launched.status, 4, launched.stderr);
    assert.match(launched.stderr, /AWS did not answer; retrying/);
    assert.match(awsCalls(), /ecs register-task-definition\necs run-task\n[\s\S]*ecs deregister-task-definition\necs delete-task-definitions\n$/);
    const source = definition();
    assert.equal(source.family, 'vayada-legacy-migration-oneoff-source');
    assert.equal(source.executionRoleArn, 'arn:aws:iam::269416271598:role/ecsTaskExecutionRole');
    assert.equal(source.taskRoleArn, 'arn:aws:iam::269416271598:role/vayada-next-api-media-task-role');
    const [container] = source.containerDefinitions;
    assert.equal(container.image, `269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@${DIGEST}`);
    assert.deepEqual([...container.entryPoint, ...container.command], ['node', '--input-type=module', '--eval', dispatcher, 'source']);
    assert.deepEqual(container.secrets.map((s) => `${s.name}=${s.valueFrom.split(':parameter')[1]}`), [
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
    const record = JSON.parse(readFileSync(join(evidence, 'task-0123456789abcdef0123456789abcdef.json'), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['logFile', 'logGroup', 'logStream', 'taskArn']);
    assert.equal(record.logStream, 'legacy-migration-oneoff/vayada-legacy-migration-oneoff/0123456789abcdef0123456789abcdef');
    assert.match(record.logFile, /\/oneoff-target-cutover-vay1360-0123456789abcdef01234567-\d{8}T\d{6}Z\.log$/);
    assert.equal(readFileSync(record.logFile, 'utf8'), 'report\n');
    assert.equal(statSync(record.logFile).mode & 0o777, 0o600);

    rmSync(record.logFile);
    const watched = run(['watch', record.taskArn]);
    assert.equal(watched.status, 4, watched.stderr);
    assert.doesNotMatch(awsCalls(), /register|run-task|deregister/);
    assert.equal(readFileSync(record.logFile, 'utf8'), 'report\n');

    assert.equal(run(['target:cutover:abort', runFile, writeRun(), `ABORT_CUTOVER:${RUN}`]).status, 4);
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

test('readonly-counts copies only the pms-backend image, role and three secrets and saves the result', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-oneoff-counts-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const name of ['legacy-migration-oneoff.sh', 'legacy-readonly-counts.py'])
      copyFileSync(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name));
    const evidence = join(root, 'evidence');
    mkdirSync(evidence, { mode: 0o700 });
    const sql = join(root, 'counts.sql');
    writeFileSync(sql, '-- (1) LEGACY PMS database: x\nSELECT count(*) AS n FROM bookings;\n-- (2) LEGACY BOOKING database: y\nSELECT 1 AS one;\n');
    const pms = {
      executionRoleArn: 'arn:aws:iam::269416271598:role/ecsTaskExecutionRole', taskRoleArn: 'arn:aws:iam::269416271598:role/ecsTaskRole',
      containerDefinitions: [{ name: 'vayada-pms-backend', image: '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-pms-backend:latest',
        secrets: ['DATABASE_URL', 'AUTH_DATABASE_URL', 'BOOKING_ENGINE_DATABASE_URL', 'JWT_SECRET_KEY', 'STRIPE_SECRET_KEY', 'CHANNEX_API_KEY']
          .map((name) => ({ name, valueFrom: `arn:aws:ssm:eu-west-1:269416271598:parameter/vayada/prod/${name.toLowerCase()}` })) }],
    };
    writeFileSync(join(root, 'pms.json'), JSON.stringify(pms));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/aws'), `#!/usr/bin/env bash
shift 4
echo "$1 $2" >> "${root}/aws.log"
args=("$@"); for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == --cli-input-json ]] && printf '%s' "\${args[i+1]}" > "${root}/definition.json"
done
case "$1 $2" in
  "sts get-caller-identity") echo 269416271598 ;;
  "ecs list-tasks") echo 0 ;;
  "ecs describe-services") echo '{"taskDefinition":"arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-pms-backend:7","networkConfiguration":{"awsvpcConfiguration":{"subnets":["subnet-2"]}}}' ;;
  "ecs describe-task-definition") cat "${root}/pms.json" ;;
  "ecs register-task-definition") echo arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-legacy-readonly-counts:1 ;;
  "ecs run-task") echo '{"tasks":[{"taskArn":"arn:aws:ecs:eu-west-1:269416271598:task/vayada-target-database-runtime-preflight/0123456789abcdef0123456789abcdef"}]}' ;;
  "ecs describe-tasks") [[ "$*" == *lastStatus* ]] && echo STOPPED || echo '{"containers":[{"exitCode":0}]}' ;;
  "logs get-log-events") [[ "$*" == *next-token* ]] && echo '{"events":[],"nextForwardToken":"f/1"}' || echo '{"events":[{"message":"# VAY-1362 read-only counts"},{"message":"| active | 2 |"}],"nextForwardToken":"f/1"}' ;;
esac
`);
    chmodSync(join(root, 'bin/aws'), 0o755);
    const run = (confirmation) => spawnSync('bash', [join(root, 'scripts/legacy-migration-oneoff.sh'), 'readonly-counts', sql, confirmation],
      { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, EVIDENCE_DIR: evidence } });

    const sqlSha = createHash('sha256').update(readFileSync(sql)).digest('hex');
    assert.equal(run('READONLY_COUNTS').status, 2);
    assert.equal(run(`READONLY_COUNTS:${'0'.repeat(64)}`).status, 2);
    assert.equal(existsSync(join(root, 'aws.log')), false);
    const result = run(`READONLY_COUNTS:${sqlSha}`);
    assert.equal(result.status, 0, result.stderr);
    const definition = JSON.parse(readFileSync(join(root, 'definition.json'), 'utf8'));
    assert.equal(definition.family, 'vayada-legacy-readonly-counts');
    assert.equal(definition.executionRoleArn, pms.executionRoleArn);
    assert.equal(definition.taskRoleArn, undefined);
    const [container] = definition.containerDefinitions;
    assert.equal(container.image, pms.containerDefinitions[0].image);
    assert.deepEqual([...container.entryPoint, ...container.command], ['python', '-c', readFileSync(new URL('./legacy-readonly-counts.py', import.meta.url), 'utf8')]);
    assert.deepEqual(container.environment, [{ name: 'COUNTS_SQL', value: readFileSync(sql, 'utf8') }]);
    assert.deepEqual(container.secrets.map((s) => s.name), ['DATABASE_URL', 'BOOKING_ENGINE_DATABASE_URL', 'STRIPE_SECRET_KEY']);
    assert.equal(container.logConfiguration.options['awslogs-group'], '/ecs/vayada-pms-backend');
    assert.equal(readFileSync(join(evidence, 'readonly-counts-result.md'), 'utf8'), '# VAY-1362 read-only counts\n| active | 2 |\n');
    assert.equal(statSync(join(evidence, 'readonly-counts-result.md')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(root, 'aws.log'), 'utf8'), /ecs deregister-task-definition\necs delete-task-definitions\n$/);
    const again = run(`READONLY_COUNTS:${sqlSha}`);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
