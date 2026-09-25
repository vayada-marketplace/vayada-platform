import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { bootstrap, configuration, safeFailure, secretName } from './launch-vay2042-source-reader.mjs';
import { reader } from './provision-vay2042-source-reader.mjs';
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
  VAY2042_READER_SECRET_ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${secretName}-Abc123`,
};
function dependencies(overrides = {}) {
  const calls = [];
  class DescribeSecretCommand { constructor(input) { this.input = input; } }
  class PutSecretValueCommand { constructor(input) { this.input = input; } }
  class SecretsManagerClient {
    constructor(config) { calls.push(['secrets-config', config]); }
    async send(command) {
      calls.push(command);
      if (command instanceof DescribeSecretCommand) return overrides.destination ?? { ARN: env.VAY2042_READER_SECRET_ARN, Name: secretName };
      if (overrides.storeError) throw overrides.storeError;
    }
    destroy() { calls.push('destroy'); }
  }
  class Client {
    constructor(config) { this.database = config.database; calls.push(['client', config]); }
    on(event, handler) { assert.equal(event, 'error'); handler(new Error('private-async-driver-error')); }
    async connect() { if (overrides.connectError) throw overrides.connectError; }
    async query(sql) { calls.push(sql); return { rows: [{ address: overrides.address ?? '10.230.0.35', database: overrides.database ?? this.database }] }; }
    async end() { calls.push('end'); }
  }
  return { calls, Client, SecretsManagerClient, DescribeSecretCommand, PutSecretValueCommand,
    provision: async ({ connect, persistCredential }) => {
      const client = await connect('postgres');
      try { await persistCredential(overrides.credential ?? { username: reader, password: 'p'.repeat(48) }); }
      finally { await client.end(); }
    } };
}

test('configuration pins every identity, credential destination, port and CA', () => {
  assert.equal(configuration(env).ca, ca);
  for (const key of Object.keys(env)) assert.throws(() => configuration({ ...env, [key]: '' }), key);
  for (const [key, value] of [
    ['AWS_REGION', 'us-east-1'], ['VAY2042_RESTORE_RESOURCE_ID', 'db-OTHER'],
    ['VAY2042_RESTORE_INSTANCE_ID', 'vayada-database'], ['VAY2042_SOURCE_SNAPSHOT_ID', 'new-snapshot'],
    ['VAY2042_RESTORE_INSTANCE_ARN', env.VAY2042_RESTORE_INSTANCE_ARN.replace('269416271598', '111111111111')],
    ['VAY2042_RESTORE_ATTESTATION_CHECKSUM', 'a'.repeat(64)], ['VAY2042_DB_PORT', '5433'],
    ['VAY2042_DB_HOST', 'localhost'], ['VAY2042_DB_HOST', `${env.VAY2042_DB_HOST}.attacker.test`],
    ['VAY2042_READER_SECRET_ARN', `${env.VAY2042_READER_SECRET_ARN}/other`],
    ['VAY2042_READER_SECRET_ARN', env.VAY2042_READER_SECRET_ARN.replace('source-reader', 'metadata-reader')],
    ['VAY2042_READER_SECRET_ARN', env.VAY2042_READER_SECRET_ARN.replace('269416271598', '111111111111')],
    ['VAY2042_READER_SECRET_ARN', env.VAY2042_READER_SECRET_ARN.slice(0, -1)],
    ['VAY2042_RDS_CA_BUNDLE_GZIP', gzipSync(ca + ca).toString('base64')],
    ['VAY2042_RDS_CA_BUNDLE_GZIP', gzipSync('untrusted').toString('base64')],
  ]) assert.throws(() => configuration({ ...env, [key]: value }), key);
});

test('writes only fixed generated credentials after private hostname-verified connection', async () => {
  const deps = dependencies();
  assert.deepEqual(await bootstrap(env, deps), { status: 'OK', stage: 'complete', scope: 'isolated-source-reader', databases: 4, tables: 83 });
  const config = deps.calls.find((call) => call[0] === 'client')[1];
  assert.deepEqual(config.ssl, { ca, rejectUnauthorized: true, servername: env.VAY2042_DB_HOST });
  assert.equal(config.database, 'postgres');
  const command = deps.calls.find((call) => call instanceof deps.PutSecretValueCommand);
  assert.equal(command.input.SecretId, env.VAY2042_READER_SECRET_ARN);
  assert.deepEqual(JSON.parse(command.input.SecretString), { username: reader, password: 'p'.repeat(48) });
  assert.match(command.input.ClientRequestToken, /^[0-9a-f-]{36}$/);
});

test('rejects occupied or different secret before connections and nonprivate servers before persistence', async () => {
  for (const overrides of [
    { destination: { ARN: env.VAY2042_READER_SECRET_ARN, Name: secretName, VersionIdsToStages: { prior: ['AWSCURRENT'] } } },
    { destination: { ARN: env.VAY2042_READER_SECRET_ARN, Name: secretName, DeletedDate: new Date() } },
    { destination: { ARN: 'different-secret', Name: secretName } },
    { destination: { ARN: env.VAY2042_READER_SECRET_ARN, Name: 'metadata-reader' } },
    { address: '10.230.1.35' }, { address: '10.230.0.256' }, { address: '127.0.0.1' },
    { database: 'different-database' },
    { credential: { username: 'vay2017_metadata_reader', password: 'p'.repeat(48) } },
  ]) {
    const deps = dependencies(overrides);
    assert.equal((await bootstrap(env, deps)).status, 'FAIL');
    assert.ok(!deps.calls.some((call) => call instanceof deps.PutSecretValueCommand));
    if (overrides.destination) assert.ok(!deps.calls.some((call) => call[0] === 'client'));
    else assert.ok(deps.calls.includes('end'));
  }
});

test('errors expose only allowlisted stage/code/class, including credential-store failures', async () => {
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
  const bundle = readFileSync(new URL('./generated/vay2042-source-reader-bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /(?:from\s*|import\s*\()['"]\.\//);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', bundle], {
    env: { PATH: process.env.PATH, VAY2042_RUN_MAIN: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { status: 'FAIL', stage: 'configuration', code: 'configuration_invalid', errorClass: 'Error' });
});
