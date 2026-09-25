import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { bootstrap, configuration, safeFailure, secretName } from './launch-vay2042-target.mjs';
import { target, writer } from './provision-vay2042-target.mjs';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };

const ca = readFileSync(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), 'utf8');
const env = {
  AWS_REGION: 'eu-west-1', VAY2042_RESTORE_INSTANCE_ID: manifest.restoreInstanceId,
  VAY2042_RESTORE_RESOURCE_ID: manifest.restoreResourceId, VAY2042_SOURCE_SNAPSHOT_ID: manifest.sourceSnapshotId,
  VAY2042_RESTORE_INSTANCE_ARN: `arn:aws:rds:eu-west-1:269416271598:db:${manifest.restoreInstanceId}`,
  VAY2042_RESTORE_ATTESTATION_CHECKSUM: createHash('sha256').update(readFileSync(new URL('./fixtures/vay2017-isolated-restore-plan.json', import.meta.url))).digest('hex'),
  VAY2042_DB_HOST: `${manifest.restoreInstanceId}.fixture.eu-west-1.rds.amazonaws.com`,
  VAY2042_DB_PORT: '5432', VAY2042_DB_USER: 'fixture-admin', VAY2042_DB_PASSWORD: 'private-admin-password',
  VAY2042_RDS_CA_BUNDLE_GZIP: gzipSync(ca).toString('base64'),
  VAY2042_WRITER_SECRET_ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${secretName}-Abc123`,
};
const credential = { username: writer, password: 'p'.repeat(48), database: target };
function dependencies(overrides = {}) {
  const calls = [];
  class DescribeSecretCommand { constructor(input) { this.input = input; } }
  class PutSecretValueCommand { constructor(input) { this.input = input; } }
  class SecretsManagerClient {
    constructor(config) { calls.push(['secrets-config', config]); }
    async send(command) {
      calls.push(command);
      if (command instanceof DescribeSecretCommand) return overrides.destination ?? { ARN: env.VAY2042_WRITER_SECRET_ARN, Name: secretName };
      if (overrides.storeError) throw overrides.storeError;
    }
    destroy() { calls.push('destroy'); }
  }
  class Client {
    constructor(config) { this.database = config.database; calls.push(['client', config]); }
    on(event, handler) { assert.equal(event, 'error'); handler(new Error('private-async-driver-error')); }
    async connect() { if (overrides.connectError) throw overrides.connectError; }
    async query(sql) {
      calls.push(sql);
      const addresses = {
        'SELECT inet_server_addr()::text AS address, current_database() AS database': '10.230.0.35/32',
        'SELECT host(inet_server_addr()) AS address, current_database() AS database': '10.230.0.35',
      };
      assert.ok(Object.hasOwn(addresses, sql), `Unexpected query: ${sql}`);
      return { rows: [{ address: overrides.address ?? addresses[sql], database: overrides.database ?? this.database }] };
    }
    async end() { calls.push('end'); }
  }
  return { calls, Client, SecretsManagerClient, DescribeSecretCommand, PutSecretValueCommand,
    provision: async ({ connect, persistCredential }) => {
      for (const database of overrides.databases ?? [...manifest.databases, target]) {
        const client = await connect(database);
        await client.end();
      }
      await persistCredential(overrides.credential ?? credential);
      if (overrides.activationError) throw overrides.activationError;
    } };
}

test('pins restore, target-secret identity, endpoint, port and one trusted CA', () => {
  assert.equal(configuration(env).ca, ca);
  for (const key of Object.keys(env)) assert.throws(() => configuration({ ...env, [key]: '' }), key);
  for (const [key, value] of [
    ['AWS_REGION', 'us-east-1'], ['VAY2042_RESTORE_RESOURCE_ID', 'db-OTHER'],
    ['VAY2042_RESTORE_INSTANCE_ID', 'vayada-database'], ['VAY2042_SOURCE_SNAPSHOT_ID', 'other-snapshot'],
    ['VAY2042_RESTORE_INSTANCE_ARN', env.VAY2042_RESTORE_INSTANCE_ARN.replace('269416271598', '111111111111')],
    ['VAY2042_RESTORE_ATTESTATION_CHECKSUM', 'a'.repeat(64)], ['VAY2042_DB_PORT', '5433'],
    ['VAY2042_DB_HOST', 'localhost'], ['VAY2042_DB_HOST', `${env.VAY2042_DB_HOST}.attacker.test`],
    ['VAY2042_WRITER_SECRET_ARN', `${env.VAY2042_WRITER_SECRET_ARN}/other`],
    ['VAY2042_WRITER_SECRET_ARN', env.VAY2042_WRITER_SECRET_ARN.replace('target-writer', 'source-reader')],
    ['VAY2042_WRITER_SECRET_ARN', env.VAY2042_WRITER_SECRET_ARN.replace('269416271598', '111111111111')],
    ['VAY2042_WRITER_SECRET_ARN', env.VAY2042_WRITER_SECRET_ARN.slice(0, -1)],
    ['VAY2042_RDS_CA_BUNDLE_GZIP', gzipSync(ca + ca).toString('base64')],
    ['VAY2042_RDS_CA_BUNDLE_GZIP', gzipSync('untrusted').toString('base64')],
  ]) assert.throws(() => configuration({ ...env, [key]: value }), key);
});

test('allows exactly nine inspection databases plus fresh target and stores only target credentials', async () => {
  const deps = dependencies();
  assert.deepEqual(await bootstrap(env, deps), { status: 'OK', stage: 'complete', scope: 'isolated-fresh-target', bound: false });
  const configs = deps.calls.filter((call) => call[0] === 'client').map((call) => call[1]);
  assert.deepEqual(configs.map((config) => config.database), [...manifest.databases, target]);
  assert.equal(deps.calls.filter((call) => call === 'SELECT host(inet_server_addr()) AS address, current_database() AS database').length, configs.length);
  for (const config of configs) assert.deepEqual(config.ssl, { ca, rejectUnauthorized: true, servername: env.VAY2042_DB_HOST });
  const command = deps.calls.find((call) => call instanceof deps.PutSecretValueCommand);
  assert.equal(command.input.SecretId, env.VAY2042_WRITER_SECRET_ARN);
  assert.deepEqual(JSON.parse(command.input.SecretString), credential);
  assert.match(command.input.ClientRequestToken, /^[0-9a-f-]{36}$/);
});

test('refuses reused credentials, wrong databases, nonprivate servers and wrong writer/target pairs', async () => {
  for (const overrides of [
    { destination: { ARN: env.VAY2042_WRITER_SECRET_ARN, Name: secretName, VersionIdsToStages: { prior: ['AWSCURRENT'] } } },
    { destination: { ARN: env.VAY2042_WRITER_SECRET_ARN, Name: secretName, DeletedDate: new Date() } },
    { destination: { ARN: 'different-secret', Name: secretName } },
    { destination: { ARN: env.VAY2042_WRITER_SECRET_ARN, Name: 'source-reader' } },
    { address: '10.230.1.35' }, { address: '10.230.0.256' }, { address: '127.0.0.1' },
    { address: '10.230.0.35/32' }, { address: '::ffff:10.230.0.35' },
    { database: 'different-database' }, { databases: ['unreviewed_target'] },
    { credential: { ...credential, username: 'vay2042_source_reader_20260925' } },
    { credential: { ...credential, database: 'vayada_target_prod' } },
    { credential: { ...credential, password: 'invalid' } },
  ]) {
    const deps = dependencies(overrides);
    assert.equal((await bootstrap(env, deps)).status, 'FAIL');
    assert.ok(!deps.calls.some((call) => call instanceof deps.PutSecretValueCommand));
    if (overrides.destination || overrides.databases) assert.ok(!deps.calls.some((call) => call[0] === 'client'));
    else assert.ok(deps.calls.includes('end'));
  }
});

test('real provisioner cannot issue any provisioning query after endpoint rejection', async () => {
  const deps = dependencies({ address: '10.230.0.35/32' });
  assert.deepEqual(await bootstrap(env, { ...deps, provision: undefined }),
    { status: 'FAIL', stage: 'database-connect', code: 'database_endpoint_invalid', errorClass: 'Error' });
  assert.deepEqual(deps.calls.filter((call) => call[0] === 'client').map((call) => call[1].database), ['postgres']);
  assert.deepEqual(deps.calls.filter((call) => typeof call === 'string'),
    ['SELECT host(inet_server_addr()) AS address, current_database() AS database', 'end', 'destroy']);
  assert.ok(!deps.calls.some((call) => call instanceof deps.PutSecretValueCommand));
});

test('sanitizes failures and preserves indeterminate activation; standalone bundle uses a distinct entry flag', async () => {
  assert.deepEqual(safeFailure('private-stage', { name: 'private-class', code: 'private-code', message: 'private-message' }),
    { status: 'FAIL', stage: 'configuration', code: 'UNKNOWN', errorClass: 'Other' });
  for (const overrides of [
    { connectError: Object.assign(new Error('private-password and hostname'), { code: 'ECONNRESET' }) },
    { storeError: Object.assign(new Error('private-password and credential'), { name: 'AccessDeniedException' }) },
  ]) {
    const result = await bootstrap(env, dependencies(overrides));
    assert.equal(result.status, 'FAIL');
    assert.doesNotMatch(JSON.stringify(result), /private-|hostname|credential"/);
  }
  assert.deepEqual(await bootstrap(env, dependencies({ activationError: new Error('target_writer_activation_outcome_unknown') })),
    { status: 'FAIL', stage: 'target-bootstrap', code: 'target_writer_activation_outcome_unknown', errorClass: 'Error' });
  const bundle = readFileSync(new URL('./generated/vay2042-target-bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /(?:from\s*|import\s*\()['"]\.\//);
  for (const [flag, code] of [['VAY2042_RUN_TARGET_MAIN', 1], ['VAY2042_RUN_MAIN', 0]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', bundle], {
      env: { PATH: process.env.PATH, [flag]: '1' }, encoding: 'utf8',
    });
    assert.equal(result.status, code);
    assert.equal(result.stderr, '');
    if (code === 0) assert.equal(result.stdout, '');
    else assert.deepEqual(JSON.parse(result.stdout), { status: 'FAIL', stage: 'configuration', code: 'configuration_invalid', errorClass: 'Error' });
  }
});
