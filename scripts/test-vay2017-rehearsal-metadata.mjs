import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  collectMetadata,
  DATABASES_SQL,
  INVENTORY_SQL,
  SCHEMAS_SQL,
  sanitizeError,
  quoteIdentifier,
  rowCountSql,
} from './vay2017-rehearsal-metadata.mjs';

const identity = {
  restoreInstanceId: 'vay2017-legacy-rehearsal-20260921',
  sourceSnapshotId: 'vay2017-legacy-source-freeze-20260920',
  restoreEventId: '6c80019b-26bd-460c-8750-5a950bf48441',
  restoreEventTime: '2026-09-20T16:19:33Z',
  restoreResourceId: 'db-MHCPB2UKUGKW6FLKDBQC4RQWJQ',
  restoreInstanceArn: 'arn:aws:rds:eu-west-1:269416271598:db:vay2017-legacy-rehearsal-20260921',
  restoreAttestationChecksum: 'c'.repeat(64),
  imageDigest: `sha256:${'a'.repeat(64)}`,
  scannerSourceChecksum: 'b'.repeat(64),
};

function fakeConnect(calls, connections) {
  return async (databaseName) => {
    connections.push(databaseName);
    return {
      async query(sql) {
        calls.push({ databaseName, sql });
        if (sql.startsWith('SHOW')) return { rows: [{ transaction_read_only: 'on' }] };
        if (sql === DATABASES_SQL) return { rows: [{ database_name: 'app_db' }, { database_name: 'postgres' }] };
        if (sql === SCHEMAS_SQL) return { rows: [{ schema_name: 'empty_schema' }, { schema_name: 'public' }] };
        if (sql === INVENTORY_SQL) return { rows: [
          { schema_name: 'public', table_name: 'reservations', column_ordinal: 1, column_name: 'id', data_type: 'uuid', not_null: true, primary_key: true, primary_key_ordinal: 1 },
          { schema_name: 'public', table_name: 'reservations', column_ordinal: 2, column_name: 'guest_name', data_type: 'text', not_null: false, primary_key: false, primary_key_ordinal: null },
        ] };
        if (sql.startsWith('SELECT count(*)::text AS row_count FROM ')) return { rows: [{ row_count: '10' }] };
        return { rows: [] };
      },
      async end() {},
    };
  };
}

test('inventory queries read database, schema, and table catalogs; exact counts are isolated', () => {
  assert.match(DATABASES_SQL, /pg_catalog\.pg_database/);
  assert.match(SCHEMAS_SQL, /pg_catalog\.pg_namespace/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_class/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_namespace/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_attribute/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_index/);
  assert.doesNotMatch(INVENTORY_SQL, /reltuples/);
  assert.doesNotMatch(INVENTORY_SQL, /\bSELECT\s+\*\b|\bFROM\s+(?!pg_catalog\.)[a-z_][\w.]*/i);
  assert.doesNotMatch(INVENTORY_SQL, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
  assert.equal(quoteIdentifier('public"; DROP TABLE x;--'), '"public""; DROP TABLE x;--"');
  assert.equal(
    rowCountSql('public"; DROP TABLE x;--', 'records'),
    'SELECT count(*)::text AS row_count FROM "public""; DROP TABLE x;--"."records"',
  );
});

test('metadata collection inventories every database and empty schema with exact counts', async () => {
  const calls = [];
  const connections = [];
  const artifact = await collectMetadata(fakeConnect(calls, connections), identity, '2026-09-21T00:00:00.000Z');
  assert.deepEqual(connections, ['postgres', 'app_db', 'postgres']);
  assert.equal(calls.filter(({ sql }) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 3);
  assert.equal(calls.filter(({ sql }) => sql === 'COMMIT').length, 3);
  assert.deepEqual(artifact.databases.map(({ name }) => name), ['app_db', 'postgres']);
  assert.deepEqual(artifact.databases[0].schemas, ['empty_schema', 'public']);
  assert.deepEqual(artifact.databases[0].tables[0].primaryKey, [{ name: 'id', ordinal: 1 }]);
  assert.equal(artifact.databases[0].tables[0].rowCount, '10');
  assert.match(artifact.rowCountSemantics, /exact COUNT\(\*\)/);
  assert.equal(artifact.imageDigest, identity.imageDigest);
  assert.equal(artifact.scannerSourceChecksum, identity.scannerSourceChecksum);
  assert.equal(artifact.restoreEventId, identity.restoreEventId);
  assert.equal(artifact.restoreEventTime, identity.restoreEventTime);
  assert.equal(artifact.restoreResourceId, identity.restoreResourceId);
  assert.equal(artifact.restoreInstanceArn, identity.restoreInstanceArn);
  assert.equal(artifact.restoreAttestationChecksum, identity.restoreAttestationChecksum);
  assert.equal(JSON.stringify(artifact).includes(identity.sourceSnapshotId), true);
  assert.equal(JSON.stringify(artifact).includes('guest_name'), true);
  assert.equal(JSON.stringify(artifact).includes('customer@example.test'), false);
  assert.match(artifact.schemaFingerprint, /^[a-f0-9]{64}$/);
  assert.match(artifact.queryChecksum, /^[a-f0-9]{64}$/);
});

test('wrong restore, snapshot, and image identities fail before queries', async () => {
  for (const change of [
    { restoreInstanceId: 'vayada-database' },
    { sourceSnapshotId: 'another-snapshot' },
    { restoreEventId: 'unverified-event' },
    { imageDigest: 'sha256:latest' },
  ]) {
    const calls = [];
    const connections = [];
    await assert.rejects(collectMetadata(fakeConnect(calls, connections), { ...identity, ...change }));
    assert.equal(calls.length, 0);
    assert.equal(connections.length, 0);
  }
});

test('sanitized errors omit raw messages, hosts, and credentials', () => {
  const output = JSON.stringify(sanitizeError(new Error('postgres://user:secret@db.example.test')));
  assert.deepEqual(JSON.parse(output), { status: 'FAIL', stage: 'metadata-read', code: 'UNKNOWN' });
  assert.doesNotMatch(output, /secret|db\.example|postgres:\/\//);
});

test('runner contains no row-value query or caller-controlled SQL', async () => {
  const source = await readFile(new URL('./vay2017-rehearsal-metadata.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env\.[A-Z0-9_]+\s*\|\|\s*['"`].*SELECT/i);
  assert.match(source, /transaction_timeout|statement_timeout/);
  assert.match(source, /rejectUnauthorized:\s*true/);
});

test('infrastructure keeps execution fixed and network access private and narrow', async () => {
  const tf = await readFile(new URL('../infra/vay2017_rehearsal_metadata_runner.tf', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/vay2017-metadata-inventory.yml', import.meta.url), 'utf8');
  const runner = await readFile(new URL('./run-vay2017-rehearsal-metadata.sh', import.meta.url), 'utf8');
  const attestation = JSON.parse(await readFile(new URL('./fixtures/vay2017-restore-attestation.json', import.meta.url), 'utf8'));
  assert.match(tf, /AssignPublicIp\s*=\s*"DISABLED"/);
  assert.match(tf, /resource "aws_route_table_association" "vay2017_rehearsal_private"/);
  assert.match(tf, /route_table_ids\s*=\s*\[aws_route_table\.vay2017_rehearsal_private\.id\]/);
  assert.match(tf, /resource "aws_vpc_endpoint" "vay2017_interface"/);
  assert.match(tf, /resource "aws_vpc_security_group_egress_rule" "vay2017_runner_postgres"/);
  assert.match(tf, /resource "aws_vpc_security_group_egress_rule" "vay2017_runner_https"/);
  assert.match(tf, /resource "aws_vpc_security_group_egress_rule" "vay2017_runner_ecr_s3"/);
  assert.doesNotMatch(tf, /0\.0\.0\.0\/0|nat_gateway|\bpublic_ip\s*=\s*true|assign_public_ip\s*=\s*true/i);
  assert.match(tf, /masterUserSecretArn/);
  assert.match(tf, /"secretsmanager:GetSecretValue"/);
  assert.doesNotMatch(tf, /ec2:Describe|rds:Describe|ecr:DescribeImages/);
  assert.doesNotMatch(tf, /data "aws_(vpc|db_instance|db_snapshot|ecr_repository|prefix_list)"/);
  assert.match(tf, /vay2017-legacy-rehearsal-20260921/);
  assert.match(tf, /vay2017-legacy-source-freeze-20260920/);
  assert.match(tf, /6c80019b-26bd-460c-8750-5a950bf48441/);
  assert.match(tf, /filesha256\([\s\S]*vay2017-restore-attestation\.json/);
  assert.doesNotMatch(tf, /cloudtrail:LookupEvents/);
  assert.doesNotMatch(tf, /target-database-url|target-database-runtime-url|db-marketplace-url|vayada-database\.c7eiqkoq4as4/);
  assert.match(tf, /ResultSelector[\s\S]*taskArn\.\$[\s\S]*ResultPath/);
  assert.doesNotMatch(tf, /Overrides|commandOverrides|ecs:RunTask.*\*/i);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /role\/vayada-github-actions-vay2017-metadata/);
  assert.doesNotMatch(workflow, /vayada-github-actions-platform-deploy/);
  assert.doesNotMatch(workflow, /inputs:|workflow_call:/);
  assert.match(runner, /--input '\{\}'/);
  assert.doesNotMatch(runner, /check-vay2017-rehearsal-isolation\.sh/);
  const isolation = await readFile(new URL('./check-vay2017-rehearsal-isolation.sh', import.meta.url), 'utf8');
  assert.match(isolation, /describe-vpc-attribute/);
  assert.match(isolation, /describe-images/);
  assert.equal(attestation.eventName, 'RestoreDBInstanceFromDBSnapshot');
  assert.match(runner, /restoreAttestationChecksum/);
  assert.equal(attestation.eventId, identity.restoreEventId);
  assert.equal(attestation.eventTime, identity.restoreEventTime);
  assert.equal(attestation.sourceSnapshotId, identity.sourceSnapshotId);
  assert.equal(attestation.restoreInstanceId, identity.restoreInstanceId);
  assert.equal(attestation.restoreInstanceResourceId, identity.restoreResourceId);
  assert.equal(attestation.restoreInstanceArn, identity.restoreInstanceArn);
  assert.doesNotMatch(runner, /aws\s+(rds\s+modify|ec2\s+authorize|iam\s+|ecs\s+run-task)/);
});
