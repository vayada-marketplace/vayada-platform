import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
const CA = readFileSync(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), 'utf8');
const PROD_HOST = 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com';
const RESTORE_HOST = 'vay1362-legacy-restore.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com';
const TLS_PRELOAD = readFileSync(new URL('./legacy-migration-tls.cjs', import.meta.url), 'utf8');
const DB_ENV = {
  VAYADA_DB_RDS_CA_BUNDLE: CA, LEGACY_MIGRATION_TLS_PRELOAD: TLS_PRELOAD,
  TARGET_DATABASE_URL: `postgresql://vayada_target_prod_user:pw@${PROD_HOST}:5432/vayada_target_prod?sslmode=require`,
  LEGACY_MIGRATION_SOURCE_HOST: RESTORE_HOST, LEGACY_MIGRATION_SOURCE_USER: 'vay1362_source_reader',
  ...Object.fromEntries([['AUTH', 'vayada_auth_db'], ['BOOKING', 'vayada_booking_db'], ['MARKETPLACE', 'postgres'], ['PMS', 'vayada_pms_db']]
    .map(([name, db]) => [`${name}_SOURCE_DATABASE_URL`, `postgresql://vay1362_source_reader:p%40ss@${RESTORE_HOST}/${db}`])),
};

test('dispatcher and script share the production allow-list', () => {
  assert.deepEqual(commandKinds, {
    'target:migration-status': 'target', 'target:cutover:abort': 'target', 'target:source:extract': 'source', 'target:cutover': 'source',
    // VAY-2108: reachable only through channex-handover-plan / channex-handover, never with a run file.
    'target:channex:handover:activate': 'target', 'target:channex:handover:revoke': 'target',
    'target:channex:handover:open-sales': 'target', 'target:channex:handover:close-sales': 'target',
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
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '[]', ...DB_ENV, VAYADA_DB_RDS_CA_BUNDLE: `${CA}\n` }, 'rds_ca_invalid'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '[]', ...DB_ENV, TARGET_DATABASE_URL: 'postgresql://vayada_target_prod_user:pw@other.example.com:5432/vayada_target_prod' }, 'database_url_not_pinned'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '[]', ...DB_ENV, TARGET_DATABASE_URL: `postgresql://vayada_admin:pw@${PROD_HOST}:5432/vayada_target_prod` }, 'database_url_not_pinned'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', ...DB_ENV, LEGACY_MIGRATION_SOURCE_HOST: PROD_HOST }, 'source_pin_invalid'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '[]', ...DB_ENV, LEGACY_MIGRATION_TLS_PRELOAD: '' }, 'tls_preload_invalid'],
    ['target', { LEGACY_MIGRATION_COMMAND: 'target:cutover:abort', LEGACY_MIGRATION_ARGS: '[]', ...DB_ENV, LEGACY_MIGRATION_TLS_PRELOAD: `${TLS_PRELOAD}\n` }, 'tls_preload_invalid'],
    ['source', { LEGACY_MIGRATION_COMMAND: 'target:cutover', LEGACY_MIGRATION_ARGS: '[]', ...DB_ENV, PMS_SOURCE_DATABASE_URL: `postgresql://vay1362_source_reader:pw@${RESTORE_HOST}:5432/vayada_booking_db` }, 'database_url_not_pinned'],
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
cp.spawnSync = (file, argv, options) => { console.log(JSON.stringify({ argv, env: Object.fromEntries(Object.entries(options.env).filter(([k]) => k.endsWith('DATABASE_URL') || k.startsWith('LEGACY_MIGRATION_TLS'))), files: argv.filter((a) => a.endsWith('.json') && fs.existsSync(a)).map((a) => JSON.parse(fs.readFileSync(a, 'utf8'))) })); return { status: 7 }; };
require('node:module').syncBuiltinESMExports();`);
    const result = dispatch('source', {
      ...DB_ENV,
      LEGACY_MIGRATION_COMMAND: 'target:cutover',
      LEGACY_MIGRATION_ARGS: JSON.stringify(['--manifest', '@manifest', '--operator', 'operator-name']),
      LEGACY_MIGRATION_FILES: blob({ manifest: { version: 1 } }),
    }, ['--require', join(dir, 'stub.cjs')]);
    assert.equal(result.status, 7, result.stderr);
    const [start, run] = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(start, { status: 'START', command: 'target:cutover', flags: ['--manifest', '--operator'] });
    assert.doesNotMatch(JSON.stringify(start), /operator-name/);
    const [requireFlag, preloadFile, ...cliArgv] = run.argv;
    assert.equal(requireFlag, '--require');
    assert.equal(readFileSync(preloadFile, 'utf8'), TLS_PRELOAD);
    assert.deepEqual(cliArgv.filter((a) => !a.endsWith('.json')), ['/app/packages/backend-migration/dist/cli/cutover.js', 'cutover', '--manifest', '--operator', 'operator-name']);
    assert.deepEqual(run.files, [{ version: 1 }]);
    const tls = JSON.parse(run.env.LEGACY_MIGRATION_TLS);
    assert.deepEqual(tls, { ca: join(preloadFile, '..', 'rds-ca.pem'), cliDir: '/app/packages/backend-migration/dist/cli', hosts: [PROD_HOST, RESTORE_HOST] });
    assert.equal(readFileSync(tls.ca, 'utf8'), CA);
    // The preload replaces these with its explicit TLS object; verify-full only guards an unpatched client.
    const verifyFull = `?sslmode=verify-full&sslrootcert=${encodeURIComponent(tls.ca)}`;
    assert.equal(run.env.TARGET_DATABASE_URL, `postgresql://vayada_target_prod_user:pw@${PROD_HOST}:5432/vayada_target_prod${verifyFull}`);
    assert.equal(run.env.PMS_SOURCE_DATABASE_URL, `postgresql://vay1362_source_reader:p%40ss@${RESTORE_HOST}/vayada_pms_db${verifyFull}`);
    assert.equal(run.env.LEGACY_MIGRATION_TLS_PRELOAD, undefined);
    assert.equal(Object.keys(run.env).length, 6);
    rmSync(join(preloadFile, '..'), { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the script checks every input before AWS and runs exactly one pinned one-off task', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-oneoff-script-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'rehearsal'));
    for (const name of ['legacy-migration-oneoff.sh', 'legacy-migration-oneoff.mjs', 'legacy-migration-tls.cjs', 'next-api-split-compatible-images.txt'])
      copyFileSync(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name));
    copyFileSync(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), join(root, 'rehearsal/rds-ca-rsa2048-g1.pem'));
    const evidence = join(root, 'evidence');
    mkdirSync(evidence, { mode: 0o700 });
    const manifest = { version: 1, environment: 'preprod' };
    const runFile = join(root, 'run.json');
    const writeRun = (overrides = {}) => {
      writeFileSync(runFile, JSON.stringify({
        runId: RUN, sourceRunId: SOURCE_RUN, sourceSha: SOURCE_SHA, imageDigest: DIGEST, files: { manifest },
        sourceHost: RESTORE_HOST, sourceUser: 'vay1362_source_reader',
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
[[ -z "\${AWS_ENDPOINT_URL:-}\${AWS_ENDPOINT_URL_ECS:-}\${AWS_CA_BUNDLE:-}\${AWS_CONFIG_FILE:-}\${AWS_SHARED_CREDENTIALS_FILE:-}" ]] || { echo "AWS overrides leaked" >&2; exit 9; }
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
      return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, AWS_PROFILE: 'other',
        AWS_ENDPOINT_URL: 'http://127.0.0.1:1', AWS_ENDPOINT_URL_ECS: 'http://127.0.0.1:1', AWS_CA_BUNDLE: '/tmp/x.pem', AWS_CONFIG_FILE: '/tmp/x', AWS_SHARED_CREDENTIALS_FILE: '/tmp/y', ...env } });
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
    for (const overrides of [{ sourceHost: PROD_HOST }, { sourceHost: undefined }, { sourceUser: 'Bad-User' }]) {
      const sha = writeRun(overrides);
      assert.match(run([cutover[0], runFile, sha, cutover[3]]).stderr, /sourceHost/);
    }
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
    assert.equal(sourceEnv.VAYADA_DB_RDS_CA_BUNDLE, CA);
    assert.equal(sourceEnv.LEGACY_MIGRATION_SOURCE_HOST, RESTORE_HOST);
    assert.equal(sourceEnv.LEGACY_MIGRATION_SOURCE_USER, 'vay1362_source_reader');
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
    assert.deepEqual(Object.keys(env(target)).sort(), ['AWS_REGION', 'LEGACY_MIGRATION_ARGS', 'LEGACY_MIGRATION_COMMAND', 'LEGACY_MIGRATION_FILES', 'LEGACY_MIGRATION_TLS_PRELOAD', 'VAYADA_DB_RDS_CA_BUNDLE']);
    assert.equal(env(target).LEGACY_MIGRATION_TLS_PRELOAD, TLS_PRELOAD);
    assert.deepEqual(JSON.parse(env(target).LEGACY_MIGRATION_ARGS), ['--operator', 'op', '--run-id', RUN, '--confirmation', `ABORT_CUTOVER:${RUN}`, '--report', 'json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the TLS preload gives every pg Client and Pool the explicit pinned TLS object', () => {
  assert.equal(dispatcher.match(/const TLS_PRELOAD_SHA256 = '([0-9a-f]{64})'/)?.[1], createHash('sha256').update(TLS_PRELOAD).digest('hex'));
  const dir = mkdtempSync(join(tmpdir(), 'legacy-oneoff-tls-'));
  try {
    // A minimal pg stand-in: it only records the config the preload hands to Client and Pool, through
    // default and named ESM imports. Real pg 8.21 (ESM entry, bound Pool, URL merging) is covered by the
    // offline proof in the evidence folder.
    mkdirSync(join(dir, 'node_modules/pg'), { recursive: true });
    mkdirSync(join(dir, 'cli'));
    writeFileSync(join(dir, 'node_modules/pg/index.js'), `class Client { constructor(config) { this.config = config; } }
class Pool { constructor(options) { this.options = options; } }
module.exports = { Client, Pool };`);
    writeFileSync(join(dir, 'cli/consumer.mjs'), `import pg from 'pg';
import { Client, Pool } from 'pg';
const url = process.env.TEST_URL;
const seen = [new pg.Client({ connectionString: url }).config, new Client({ connectionString: url }).config,
  new pg.Pool({ connectionString: url, max: 2 }).options, new Pool({ connectionString: url }).options];
const refused = ['postgresql://u:p@other.example.com:5432/db', url.replace('5432', '5433'), url + '&host=127.0.0.1'].map((bad) => {
  try { new pg.Client({ connectionString: bad }); return 'accepted'; } catch (error) { return error.message; }
});
console.log(JSON.stringify({ seen, refused }));`);
    writeFileSync(join(dir, 'ca.pem'), CA);
    const run = (tls) => spawnSync(process.execPath, ['--require', new URL('./legacy-migration-tls.cjs', import.meta.url).pathname, join(dir, 'cli/consumer.mjs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TEST_URL: `postgresql://u:p%40ss@${PROD_HOST}:5432/vayada_target_prod?sslmode=require&uselibpqcompat=true&application_name=cutover`, ...tls },
    });
    const result = run({ LEGACY_MIGRATION_TLS: JSON.stringify({ ca: join(dir, 'ca.pem'), cliDir: join(dir, 'cli'), hosts: [PROD_HOST] }) });
    assert.equal(result.status, 0, result.stderr);
    const { seen, refused } = JSON.parse(result.stdout);
    for (const config of seen) {
      assert.equal(config.connectionString, `postgresql://u:p%40ss@${PROD_HOST}:5432/vayada_target_prod?application_name=cutover`);
      assert.deepEqual(config.ssl, { ca: CA, rejectUnauthorized: true, servername: PROD_HOST });
    }
    assert.equal(seen[2].max, 2);
    assert.deepEqual(refused, ['database_host_not_pinned', 'database_host_not_pinned', 'database_url_not_pinned']);
    assert.notEqual(run({}).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readonly-counts plans first, then runs one single-secret task per database on the pinned image', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-oneoff-counts-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'rehearsal'));
    for (const name of ['legacy-migration-oneoff.sh', 'legacy-readonly-counts.py'])
      copyFileSync(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name));
    copyFileSync(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), join(root, 'rehearsal/rds-ca-rsa2048-g1.pem'));
    const evidence = join(root, 'evidence');
    mkdirSync(evidence, { mode: 0o700 });
    const counts = join(root, 'counts.sql');
    const target = join(root, 'target.sql');
    writeFileSync(counts, '-- (1) LEGACY PMS database: x\nSELECT count(*) AS n FROM bookings;\n-- (2) LEGACY BOOKING database: y\nSELECT count(*) AS n FROM booking_hotels;\n');
    writeFileSync(target, '-- check\nBEGIN READ ONLY;\nSELECT job.id FROM platform.jobs job;\nROLLBACK;\n');
    const digest = `sha256:${'a'.repeat(64)}`;
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/aws'), `#!/usr/bin/env bash
shift 4
echo "$1 $2" >> "${root}/aws.log"
args=("$@"); for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == --cli-input-json ]] && printf '%s\\n' "\${args[i+1]}" >> "${root}/definitions.jsonl"
  [[ "\${args[i]}" == --services ]] && service="\${args[i+1]}"
  [[ "\${args[i]}" == --log-stream-name ]] && stream="\${args[i+1]}"
done
case "$1 $2" in
  "sts get-caller-identity") echo 269416271598 ;;
  "ecs list-tasks") [[ "$*" == *--service-name* ]] && echo '{"taskArns":["arn:aws:ecs:eu-west-1:269416271598:task/vayada-backend-cluster/1111"]}' || echo 0 ;;
  "ecs describe-services")
    if [[ "$*" == *networkConfiguration* ]]; then echo '{"awsvpcConfiguration":{"subnets":["subnet-2"]}}'
    else cat "${root}/\${service}.json"; fi ;;
  "ecs describe-tasks")
    if [[ "$*" == *imageDigest* ]]; then echo ${digest}
    elif [[ "$*" == *lastStatus* ]]; then echo STOPPED
    else echo '{"containers":[{"exitCode":0}]}'; fi ;;
  "ecs register-task-definition") echo "arn:aws:ecs:eu-west-1:269416271598:task-definition/counts:$(wc -l < "${root}/definitions.jsonl" | tr -d ' ')" ;;
  "ecs run-task") echo '{"tasks":[{"taskArn":"arn:aws:ecs:eu-west-1:269416271598:task/vayada-target-database-runtime-preflight/0123456789abcdef0123456789abcdef"}]}' ;;
  "logs get-log-events")
    kind="$(tail -n 1 "${root}/definitions.jsonl" | jq -r '.containerDefinitions[0].environment[] | select(.name == "COUNTS_KIND") | .value')"
    if [[ "$*" == *next-token* ]]; then echo '{"events":[],"nextForwardToken":"f/1"}'
    else jq -cn --arg kind "$kind" --arg complete "$(cat "${root}/complete")" '{events: ([{message: "## \\($kind) section"}] + (if $complete == "yes" then [{message: "COUNTS_COMPLETE kind=\\($kind) statements=1"}] else [] end)), nextForwardToken: "f/1"}'; fi ;;
esac
`);
    chmodSync(join(root, 'bin/aws'), 0o755);
    writeFileSync(join(root, 'complete'), 'yes');
    const settled = (service, running) => writeFileSync(join(root, `${service}.json`),
      JSON.stringify({ desiredCount: 1, runningCount: running, deployments: [{ rolloutState: 'COMPLETED' }] }));
    settled('vayada-next-api-service', 1);
    settled('vayada-pms-backend-service', 2);
    const run = (...args) => {
      rmSync(join(root, 'aws.log'), { force: true });
      rmSync(join(root, 'definitions.jsonl'), { force: true });
      writeFileSync(join(root, 'definitions.jsonl'), '');
      return spawnSync('bash', [join(root, 'scripts/legacy-migration-oneoff.sh'), ...args],
        { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, EVIDENCE_DIR: evidence } });
    };
    const awsCalls = () => (existsSync(join(root, 'aws.log')) ? readFileSync(join(root, 'aws.log'), 'utf8') : '');

    writeFileSync(join(root, 'bad.sql'), '-- (1) LEGACY PMS database: x\nSELECT count(*), ts_stat(\'x\') FROM bookings;\n');
    assert.equal(run('readonly-counts-plan', join(root, 'bad.sql'), target).status, 2);
    assert.equal(awsCalls(), '');

    const unsettled = run('readonly-counts-plan', counts, target);
    assert.equal(unsettled.status, 1);
    assert.match(unsettled.stderr, /vayada-pms-backend-service must run exactly one task/);
    settled('vayada-pms-backend-service', 1);
    settled('vayada-next-api-service', 2);
    assert.match(run('readonly-counts-plan', counts, target).stderr, /vayada-next-api-service must run exactly one task.*do not run during deploys/);
    settled('vayada-next-api-service', 1);

    const planned = run('readonly-counts-plan', counts, target);
    assert.equal(planned.status, 0, planned.stderr);
    assert.doesNotMatch(awsCalls(), /register|run-task/);
    const planSha = planned.stdout.match(/^Plan sha256: ([0-9a-f]{64})$/m)[1];
    assert.match(planned.stdout, /Check 1 on vayada_target_prod as vayada_target_prod_user \(TARGET_DATABASE_URL\)/);
    assert.match(planned.stdout, /SELECT count\(\*\) AS rows_found FROM \(\nSELECT job\.id FROM platform\.jobs job\n\) AS check_rows/);
    assert.match(planned.stdout, /^Network: \{"awsvpcConfiguration":\{"subnets":\["subnet-2"\]\}\}$/m);
    for (const [family, secret, parameter] of [['pms', 'DATABASE_URL', 'db-pms-url'], ['booking', 'BOOKING_ENGINE_DATABASE_URL', 'db-booking-url'], ['target', 'TARGET_DATABASE_URL', 'target-database-url']])
      assert.match(planned.stdout, new RegExp(`^Task vayada-legacy-readonly-counts-${family}: image 269416271598\\.dkr\\.ecr\\.eu-west-1\\.amazonaws\\.com/vayada-pms-backend@${digest}, execution role arn:aws:iam::269416271598:role/ecsTaskExecutionRole, no task role, secret ${secret} <- /vayada/prod/${parameter},`, 'm'));
    assert.equal(readFileSync(join(evidence, 'readonly-counts-plan.txt'), 'utf8'), planned.stdout);

    assert.equal(run('readonly-counts', counts, target, 'READONLY_COUNTS').status, 2);
    const stale = run('readonly-counts', counts, target, `READONLY_COUNTS:${'0'.repeat(64)}`);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /plan changed/);
    assert.doesNotMatch(awsCalls(), /register/);

    writeFileSync(join(root, 'complete'), 'no');
    const incomplete = run('readonly-counts', counts, target, `READONLY_COUNTS:${planSha}`);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /PMS counts did not complete; no result files written/);
    assert.equal(awsCalls().match(/run-task/g).length, 1);
    assert.match(awsCalls(), /ecs deregister-task-definition\necs delete-task-definitions\n$/);
    assert.equal(existsSync(join(evidence, 'readonly-counts-result.md')), false);
    writeFileSync(join(root, 'complete'), 'yes');

    const result = run('readonly-counts', counts, target, `READONLY_COUNTS:${planSha}`);
    assert.equal(result.status, 0, result.stderr);
    const definitions = readFileSync(join(root, 'definitions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(definitions.map((d) => d.family), ['vayada-legacy-readonly-counts-pms', 'vayada-legacy-readonly-counts-booking', 'vayada-legacy-readonly-counts-target']);
    for (const definition of definitions) {
      const [container] = definition.containerDefinitions;
      assert.equal(definition.taskRoleArn, undefined);
      assert.equal(container.secrets.length, 1);
      assert.equal(container.image, `269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-pms-backend@${digest}`);
      assert.deepEqual([...container.entryPoint, ...container.command], ['python', '-I', '-c', readFileSync(new URL('./legacy-readonly-counts.py', import.meta.url), 'utf8')]);
      const environment = Object.fromEntries(container.environment.map((e) => [e.name, e.value]));
      assert.equal(environment.VAYADA_DB_RDS_CA_BUNDLE, readFileSync(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), 'utf8'));
      assert.equal(Object.keys(environment).length, 3);
    }
    assert.deepEqual(definitions.map((d) => d.containerDefinitions[0].secrets[0].name), ['DATABASE_URL', 'BOOKING_ENGINE_DATABASE_URL', 'TARGET_DATABASE_URL']);
    assert.equal(definitions[2].containerDefinitions[0].environment.find((e) => e.name === 'TARGET_CHECK_SQL').value, readFileSync(target, 'utf8'));
    assert.equal(readFileSync(join(evidence, 'readonly-counts-result.md'), 'utf8'), '# VAY-1362 read-only counts (legacy PMS and Booking)\n## PMS section\n## BOOKING section\n');
    assert.equal(readFileSync(join(evidence, 'predeploy-readonly-check-result.md'), 'utf8'), '# Target checks: production target, counts only\n## TARGET section\n');
    for (const name of ['readonly-counts-result.md', 'predeploy-readonly-check-result.md'])
      assert.equal(statSync(join(evidence, name)).mode & 0o777, 0o600);
    assert.equal(awsCalls().match(/ecs delete-task-definitions/g).length, 3);
    const again = run('readonly-counts', counts, target, `READONLY_COUNTS:${planSha}`);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists; use a new evidence folder/);
    // A completed run's folder keeps its plan: re-planning there is refused before AWS, even with "none".
    const replan = run('readonly-counts-plan', counts, 'none');
    assert.equal(replan.status, 2);
    assert.match(replan.stderr, /readonly-counts-result\.md already exists; use a new evidence folder/);
    assert.equal(awsCalls(), '');
    assert.equal(readFileSync(join(evidence, 'readonly-counts-plan.txt'), 'utf8'), planned.stdout);

    // "none" instead of the 6c file: only the legacy task runs, and only the counts result is written.
    const evidenceOnly = join(root, 'evidence-only');
    mkdirSync(evidenceOnly, { mode: 0o700 });
    const runOnly = (...args) => {
      writeFileSync(join(root, 'definitions.jsonl'), '');
      return spawnSync('bash', [join(root, 'scripts/legacy-migration-oneoff.sh'), ...args],
        { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, EVIDENCE_DIR: evidenceOnly } });
    };
    const pmsOnly = join(root, 'pms-only.sql');
    writeFileSync(pmsOnly, '-- (1) LEGACY PMS database: per hotel\nSELECT h.name, count(*) AS n FROM hotels h GROUP BY 1;\n');
    const onlyPlan = runOnly('readonly-counts-plan', pmsOnly, 'none');
    assert.equal(onlyPlan.status, 0, onlyPlan.stderr);
    assert.equal(onlyPlan.stdout.match(/^Task /gm).length, 1);
    assert.match(onlyPlan.stdout, /^Target check SQL sha256: none$/m);
    const onlySha = onlyPlan.stdout.match(/^Plan sha256: ([0-9a-f]{64})$/m)[1];
    assert.notEqual(onlySha, planSha);
    const onlyRun = runOnly('readonly-counts', pmsOnly, 'none', `READONLY_COUNTS:${onlySha}`);
    assert.equal(onlyRun.status, 0, onlyRun.stderr);
    assert.deepEqual(readFileSync(join(root, 'definitions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).family), ['vayada-legacy-readonly-counts-pms']);
    assert.equal(readFileSync(join(evidenceOnly, 'readonly-counts-result.md'), 'utf8'), '# VAY-1362 read-only counts (legacy PMS and Booking)\n## PMS section\n');
    assert.equal(existsSync(join(evidenceOnly, 'predeploy-readonly-check-result.md')), false);

    // "none" instead of the counts file: only the target task runs, and only the target result is written.
    const evidenceTarget = join(root, 'evidence-target');
    mkdirSync(evidenceTarget, { mode: 0o700 });
    const runTarget = (...args) => {
      writeFileSync(join(root, 'definitions.jsonl'), '');
      return spawnSync('bash', [join(root, 'scripts/legacy-migration-oneoff.sh'), ...args],
        { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, EVIDENCE_DIR: evidenceTarget } });
    };
    const neither = runTarget('readonly-counts-plan', 'none', 'none');
    assert.equal(neither.status, 2);
    assert.match(neither.stderr, /not both none/);
    const targetPlan = runTarget('readonly-counts-plan', 'none', target);
    assert.equal(targetPlan.status, 0, targetPlan.stderr);
    assert.equal(targetPlan.stdout.match(/^Task /gm).length, 1);
    assert.match(targetPlan.stdout, /^Task vayada-legacy-readonly-counts-target: /m);
    assert.match(targetPlan.stdout, /^Counts SQL sha256: none$/m);
    assert.doesNotMatch(targetPlan.stdout, /^Block /m);
    const targetSha = targetPlan.stdout.match(/^Plan sha256: ([0-9a-f]{64})$/m)[1];
    const targetRun = runTarget('readonly-counts', 'none', target, `READONLY_COUNTS:${targetSha}`);
    assert.equal(targetRun.status, 0, targetRun.stderr);
    const targetDefinitions = readFileSync(join(root, 'definitions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(targetDefinitions.map((d) => d.family), ['vayada-legacy-readonly-counts-target']);
    assert.equal(targetDefinitions[0].containerDefinitions[0].secrets[0].name, 'TARGET_DATABASE_URL');
    assert.equal(readFileSync(join(evidenceTarget, 'predeploy-readonly-check-result.md'), 'utf8'), '# Target checks: production target, counts only\n## TARGET section\n');
    assert.equal(existsSync(join(evidenceTarget, 'readonly-counts-result.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('channex handover plans the CLI dry run, then applies exactly that plan for one hotel', () => {
  const root = mkdtempSync(join(tmpdir(), 'channex-handover-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'rehearsal'));
    for (const name of ['legacy-migration-oneoff.sh', 'legacy-migration-oneoff.mjs', 'legacy-migration-tls.cjs', 'next-api-split-compatible-images.txt'])
      copyFileSync(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name));
    copyFileSync(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), join(root, 'rehearsal/rds-ca-rsa2048-g1.pem'));
    const evidence = join(root, 'evidence');
    mkdirSync(evidence, { mode: 0o700 });
    const readbackFile = join(evidence, 'f7-readback.txt');
    writeFileSync(readbackFile, 'legacy is_active=false readback\n');
    const readbackSha = createHash('sha256').update(readFileSync(readbackFile)).digest('hex');
    writeFileSync(join(root, 'outside.txt'), 'not evidence\n');
    symlinkSync(join(root, 'outside.txt'), join(evidence, 'linked.txt'));
    const PROPERTY = '29f39aae-1111-4222-8333-444455556666';
    const OTHER_PROPERTY = '7d3f6dcc-1111-4222-8333-444455556666';
    const OTHER_DIGEST = readFileSync(new URL('./next-api-split-compatible-images.txt', import.meta.url), 'utf8').trim().split('\n').at(-2).split(' ')[1];
    const CLI_SHA = 'a'.repeat(64);
    const state = (name, value) => writeFileSync(join(root, name), value);
    state('account', '269416271598');
    state('digest', DIGEST);
    state('exit', '0');
    state('network', '{"awsvpcConfiguration":{"subnets":["subnet-1"]}}');
    const cliLines = (lines) => state('events', JSON.stringify({ events: lines.map((message) => ({ message })), nextForwardToken: 'f/1' }));
    const planLine = (overrides = {}) => JSON.stringify({ applied: false, plan: { evidence: { approvalRef: 'x' } }, planSha256: CLI_SHA, ...overrides });
    const applyLine = (overrides = {}) => JSON.stringify({ applied: true, plan: {}, planSha256: CLI_SHA, auditId: 'audit-1', ...overrides });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/aws'), `#!/usr/bin/env bash
[[ "$1 $2 $3 $4" == "--profile vayada --region eu-west-1" ]] || { echo "unexpected aws options: $*" >&2; exit 9; }
shift 4
echo "$1 $2" >> "${root}/aws.log"
args=("$@"); for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == --cli-input-json ]] && printf '%s\\n' "\${args[i+1]}" >> "${root}/definitions.jsonl"
done
case "$1 $2" in
  "sts get-caller-identity") cat "${root}/account" ;;
  "ecs describe-services")
    [[ "$*" == *networkConfiguration* ]] && cat "${root}/network" ||
      echo '{"desiredCount":1,"runningCount":1,"deployments":[{"rolloutState":"COMPLETED"}]}' ;;
  "ecs list-tasks") [[ "$*" == *--family* ]] && echo 0 || echo '{"taskArns":["arn:aws:ecs:eu-west-1:269416271598:task/vayada-backend-cluster/feed"]}' ;;
  "ecs register-task-definition") echo arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-channex-handover-oneoff:1 ;;
  "ecs run-task") echo '{"tasks":[{"taskArn":"arn:aws:ecs:eu-west-1:269416271598:task/vayada-target-database-runtime-preflight/0123456789abcdef0123456789abcdef"}],"failures":[]}' ;;
  "ecs describe-tasks")
    if [[ "$*" == *imageDigest* ]]; then cat "${root}/digest"
    elif [[ "$*" == *lastStatus* ]]; then echo STOPPED
    else echo "{\\"containers\\":[{\\"exitCode\\":$(cat "${root}/exit")}]}"; fi ;;
  "logs get-log-events") [[ "$*" == *next-token* ]] && echo '{"events":[],"nextForwardToken":"f/1"}' || cat "${root}/events" ;;
esac
`);
    chmodSync(join(root, 'bin/aws'), 0o755);
    const script = join(root, 'scripts/legacy-migration-oneoff.sh');
    // /bin/bash: macOS operators run bash 3.2.
    const run = (args) => {
      rmSync(join(root, 'aws.log'), { force: true });
      rmSync(join(root, 'definitions.jsonl'), { force: true });
      return spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, EVIDENCE_DIR: evidence } });
    };
    const awsCalls = () => (existsSync(join(root, 'aws.log')) ? readFileSync(join(root, 'aws.log'), 'utf8') : '');
    const definitions = () => readFileSync(join(root, 'definitions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const recordFile = join(evidence, `channex-handover-activate-${PROPERTY}-plan.json`);
    const resultFile = join(evidence, `channex-handover-activate-${PROPERTY}-result.json`);
    const planSha = () => JSON.parse(readFileSync(recordFile, 'utf8')).planSha256;
    const requestFile = join(root, 'activate.json');
    const activate = { action: 'activate', property: PROPERTY, approvalRef: 'flamur-go-aether-b', legacyDisabledAt: '2026-10-12T09:00:00Z', legacyReadbackFile: 'f7-readback.txt' };
    const writeRequest = (request, file = requestFile) => writeFileSync(file, JSON.stringify(request));
    const go = (sha, action = 'activate', property = PROPERTY) => `CHANNEX_HANDOVER:${action}:${property}:${sha}`;
    const plan = () => {
      cliLines(['{"status":"START","command":"target:channex:handover:activate","flags":["--property"]}', planLine()]);
      const result = run(['channex-handover-plan', requestFile]);
      assert.equal(result.status, 0, result.stderr);
      return result;
    };

    // Every input check runs before any AWS call.
    for (const [request, message] of [
      [{ ...activate, action: 'disable' }, /must be activate, revoke, open-sales or close-sales/],
      [{ ...activate, action: 'activate\n' }, /must be activate, revoke, open-sales or close-sales/],
      [{ ...activate, property: PROPERTY.toUpperCase() }, /lowercase UUID/],
      [{ ...activate, property: `${PROPERTY}\n` }, /lowercase UUID/],
      [{ ...activate, extra: 'x' }, /exactly the activate fields/],
      [{ ...activate, approvalRef: 'ok' }, /exactly the activate fields/],
      [{ ...activate, approvalRef: '@flamur go' }, /exactly the activate fields/],
      [{ ...activate, approvalRef: '--apply' }, /exactly the activate fields/],
      [{ ...activate, approvalRef: 'flamur go\n' }, /exactly the activate fields/],
      [{ ...activate, legacyDisabledAt: '2026-10-12 09:00' }, /exactly the activate fields/],
      [{ ...activate, legacyReadbackFile: '../f7-readback.txt' }, /exactly the activate fields/],
      [{ ...activate, legacyReadbackFile: 'missing.txt' }, /non-empty regular file in the evidence folder/],
      [{ ...activate, legacyReadbackFile: 'linked.txt' }, /non-empty regular file in the evidence folder/],
      [{ action: 'revoke', property: PROPERTY, approvalRef: 'flamur-go', legacyDisabledAt: activate.legacyDisabledAt }, /exactly the revoke fields/],
      [{ action: 'revoke', property: PROPERTY, approvalRef: 'flamur-go', reason: '-x legacy' }, /exactly the revoke fields/],
    ]) {
      writeRequest(request);
      const result = run(['channex-handover-plan', requestFile]);
      assert.equal(result.status, 2, `${JSON.stringify(request)} ${result.stderr}`);
      assert.match(result.stderr, message);
      assert.equal(awsCalls(), '');
    }
    writeRequest(activate);
    for (const [confirmation, message] of [
      [go(CLI_SHA), /run channex-handover-plan first/],
      [go(CLI_SHA, 'revoke'), /Confirmation must be CHANNEX_HANDOVER:activate:/],
      [go(CLI_SHA, 'activate', OTHER_PROPERTY), /Confirmation must be CHANNEX_HANDOVER:activate:/],
      [`CHANNEX_HANDOVER:activate:${PROPERTY}:${'A'.repeat(64)}`, /Confirmation must be/],
    ]) {
      const result = run(['channex-handover', requestFile, confirmation]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, message);
      assert.equal(awsCalls(), '');
    }
    // The generic migration path never reaches the handover CLI.
    assert.match(run(['target:channex:handover:activate', requestFile, '0'.repeat(64), 'x']).stderr, /allow-list/);

    // No plan is recorded for an unreviewed image, a failed dry run, an apply-shaped or a repeated plan line.
    state('digest', `sha256:${'0'.repeat(64)}`);
    assert.match(run(['channex-handover-plan', requestFile]).stderr, /not a reviewed pair/);
    assert.doesNotMatch(awsCalls(), /register/);
    state('digest', DIGEST);
    for (const [lines, exit] of [
      [['{"status":"START"}', 'Error: refused: claim_not_historical'], '1'],
      [['{"status":"START"}', planLine()], '1'],
      [['{"status":"START"}', planLine({ applied: true })], '0'],
      [['{"status":"START"}', planLine(), planLine()], '0'],
    ]) {
      cliLines(lines);
      state('exit', exit);
      assert.match(run(['channex-handover-plan', requestFile]).stderr, /no plan recorded/);
      assert.equal(existsSync(recordFile), false);
    }
    state('exit', '0');

    // The plan: the CLI's own read-only dry run on the running reviewed image, target secret only.
    const planned = plan();
    const firstGo = planSha();
    assert.notEqual(firstGo, CLI_SHA);
    assert.match(planned.stdout, new RegExp(`Run after the go: channex-handover ${requestFile} CHANNEX_HANDOVER:activate:${PROPERTY}:${firstGo}`));
    const [planDefinition] = definitions();
    assert.equal(planDefinition.family, 'vayada-channex-handover-oneoff');
    assert.equal(planDefinition.taskRoleArn, undefined);
    const [planContainer] = planDefinition.containerDefinitions;
    assert.equal(planContainer.image, `269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@${DIGEST}`);
    assert.deepEqual([...planContainer.entryPoint, ...planContainer.command], ['node', '--input-type=module', '--eval', dispatcher, 'target']);
    assert.deepEqual(planContainer.secrets.map((x) => `${x.name}=${x.valueFrom.split(':parameter')[1]}`), ['TARGET_DATABASE_URL=/vayada/prod/target-database-url']);
    const planEnv = Object.fromEntries(planContainer.environment.map((e) => [e.name, e.value]));
    assert.equal(planEnv.LEGACY_MIGRATION_COMMAND, 'target:channex:handover:activate');
    assert.deepEqual(JSON.parse(planEnv.LEGACY_MIGRATION_ARGS), ['--property', PROPERTY, '--approval-ref', activate.approvalRef,
      '--legacy-disabled-at', activate.legacyDisabledAt, '--legacy-readback-sha256', readbackSha]);
    assert.equal(planEnv.LEGACY_MIGRATION_FILES, undefined);
    assert.equal(JSON.parse(readFileSync(recordFile, 'utf8')).cliPlanSha256, CLI_SHA);
    assert.equal(statSync(recordFile).mode & 0o777, 0o600);

    // The go must name that plan for an unchanged request; anything the plan bound needs a new go.
    assert.match(run(['channex-handover', requestFile, go(CLI_SHA)]).stderr, /names another plan/);
    writeRequest({ ...activate, approvalRef: 'another-go' });
    assert.match(run(['channex-handover', requestFile, go(firstGo)]).stderr, /names another plan/);
    writeRequest(activate);
    assert.equal(awsCalls(), '');
    const drift = (change, undo) => {
      change();
      const result = run(['channex-handover', requestFile, go(firstGo)]);
      undo();
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /plan changed since the go/);
      assert.doesNotMatch(awsCalls(), /register/);
    };
    drift(() => state('digest', OTHER_DIGEST), () => state('digest', DIGEST));
    drift(() => state('network', '{"awsvpcConfiguration":{"subnets":["subnet-2"]}}'), () => state('network', '{"awsvpcConfiguration":{"subnets":["subnet-1"]}}'));
    drift(() => writeFileSync(readbackFile, 'edited readback\n'), () => writeFileSync(readbackFile, 'legacy is_active=false readback\n'));
    const runnerText = readFileSync(script, 'utf8');
    drift(() => writeFileSync(script, `${runnerText}\n# edited\n`), () => writeFileSync(script, runnerText));
    // A re-plan on another image gives a new go; the old go stays refused.
    state('digest', OTHER_DIGEST);
    plan();
    const secondGo = planSha();
    assert.notEqual(secondGo, firstGo);
    assert.match(run(['channex-handover', requestFile, go(firstGo)]).stderr, /names another plan/);
    state('digest', DIGEST);
    plan();
    assert.equal(planSha(), firstGo);

    // A CLI refusal, a non-zero exit, an unapplied report or a marker for another plan writes no result.
    for (const [lines, exit, status] of [
      [['{"status":"START"}', 'Error: refused: plan_changed'], '1', 1],
      [['{"status":"START"}', applyLine()], '3', 3],
      [['{"status":"START"}', applyLine({ applied: false })], '0', 1],
      [['{"status":"START"}', applyLine(), `CHANNEX_HANDOVER_COMPLETE action=activate property=${PROPERTY} planSha256=${'c'.repeat(64)} replayed=false`], '0', 1],
    ]) {
      cliLines(lines);
      state('exit', exit);
      const result = run(['channex-handover', requestFile, go(firstGo)]);
      assert.equal(result.status, status, result.stderr);
      assert.match(result.stderr, /did not complete; no result written/);
      assert.equal(existsSync(resultFile), false);
    }
    state('exit', '0');

    // The apply passes --apply <CLI plan sha> and keeps the result; the folder then refuses this action again.
    cliLines(['{"status":"START"}', applyLine(), `CHANNEX_HANDOVER_COMPLETE action=activate property=${PROPERTY} planSha256=${CLI_SHA} replayed=false`]);
    const applied = run(['channex-handover', requestFile, go(firstGo)]);
    assert.equal(applied.status, 0, applied.stderr);
    const applyEnv = Object.fromEntries(definitions()[0].containerDefinitions[0].environment.map((e) => [e.name, e.value]));
    assert.deepEqual(JSON.parse(applyEnv.LEGACY_MIGRATION_ARGS).slice(-2), ['--apply', CLI_SHA]);
    assert.match(awsCalls(), /ecs register-task-definition\necs run-task\n[\s\S]*ecs deregister-task-definition\necs delete-task-definitions\n$/);
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.deepEqual([result.auditId, result.goPlanSha256], ['audit-1', firstGo]);
    const again = run(['channex-handover', requestFile, go(firstGo)]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists; use a new evidence folder/);
    assert.equal(awsCalls(), '');

    // Revoke and the sales actions carry only their own flags.
    for (const [request, flags] of [
      [{ action: 'revoke', property: PROPERTY, approvalRef: 'flamur-go-revoke', reason: 'legacy kept polling' }, ['--reason', 'legacy kept polling']],
      [{ action: 'open-sales', property: PROPERTY, approvalRef: 'flamur-go-open' }, []],
      [{ action: 'close-sales', property: PROPERTY, approvalRef: 'flamur-go-close' }, []],
    ]) {
      const file = join(root, `${request.action}.json`);
      writeRequest(request, file);
      cliLines(['{"status":"START"}', planLine()]);
      const result = run(['channex-handover-plan', file]);
      assert.equal(result.status, 0, result.stderr);
      const env = Object.fromEntries(definitions()[0].containerDefinitions[0].environment.map((e) => [e.name, e.value]));
      assert.equal(env.LEGACY_MIGRATION_COMMAND, `target:channex:handover:${request.action}`);
      assert.deepEqual(JSON.parse(env.LEGACY_MIGRATION_ARGS), ['--property', PROPERTY, '--approval-ref', request.approvalRef, ...flags]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dispatcher maps each handover action to the handover CLI with the target secret only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'channex-handover-dispatch-'));
  try {
    writeFileSync(join(dir, 'stub.cjs'), `const cp = require('node:child_process');
cp.spawnSync = (file, argv, options) => { console.log(JSON.stringify({ argv: argv.slice(2), urls: Object.keys(options.env).filter((k) => k.endsWith('DATABASE_URL')).sort() })); return { status: 0 }; };
require('node:module').syncBuiltinESMExports();`);
    for (const action of ['activate', 'revoke', 'open-sales', 'close-sales']) {
      const result = dispatch('target', { ...DB_ENV, LEGACY_MIGRATION_COMMAND: `target:channex:handover:${action}`,
        LEGACY_MIGRATION_ARGS: JSON.stringify(['--property', '29f39aae-1111-4222-8333-444455556666', '--approval-ref', 'go']) }, ['--require', join(dir, 'stub.cjs')]);
      assert.equal(result.status, 0, result.stderr);
      const [start, run] = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(start.flags, ['--property', '--approval-ref']);
      assert.deepEqual(run.argv, ['/app/packages/backend-migration/dist/cli/channexHandover.js', action, '--property', '29f39aae-1111-4222-8333-444455556666', '--approval-ref', 'go']);
      assert.equal(dispatch('source', { ...DB_ENV, LEGACY_MIGRATION_COMMAND: `target:channex:handover:${action}`, LEGACY_MIGRATION_ARGS: '[]' }).status, 64);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
