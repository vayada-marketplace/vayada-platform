import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  collectSourceCatalog, CATALOG_DATABASES, CATALOG_IDENTITY_SQL,
  CATALOG_IMAGE_DIGEST, CATALOG_SQL_SHA256, sanitizeError,
} from './vay2017-rehearsal-metadata.mjs';

// Fixture copied verbatim from the reviewed product sourceInventory.ts constant.
const fingerprintSql = `
WITH schema_items AS (
  SELECT format('relation|%s|%s|%s', n.nspname, c.relname, c.relkind) AS item
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
    AND n.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('column|%s|%s|%s|%s|%s|%s', n.nspname, c.relname, a.attname,
                pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull,
                pg_catalog.pg_get_expr(d.adbin, d.adrelid))
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
    AND n.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('constraint|%s|%s|%s|%s', n.nspname, c.relname, x.conname,
                pg_catalog.pg_get_constraintdef(x.oid, true))
  FROM pg_catalog.pg_constraint x
  JOIN pg_catalog.pg_class c ON c.oid = x.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('index|%s|%s|%s', schemaname, indexname, indexdef)
  FROM pg_catalog.pg_indexes
  WHERE schemaname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('view|%s|%s|%s', n.nspname, c.relname,
                pg_catalog.pg_get_viewdef(c.oid, true))
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm')
    AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('sequence|%s|%s|%s|%s|%s|%s|%s|%s|%s', n.nspname, c.relname,
                s.seqtypid::regtype, s.seqstart, s.seqincrement, s.seqmax,
                s.seqmin, s.seqcache, s.seqcycle)
  FROM pg_catalog.pg_sequence s
  JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
  UNION ALL
  SELECT format('enum|%s|%s|%s|%s', n.nspname, t.typname, e.enumlabel, e.enumsortorder)
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'vayada_migration_evidence')
    AND n.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('extension|%s|%s', extname, extversion) FROM pg_catalog.pg_extension
)
SELECT current_database() AS source_database,
       md5(string_agg(item, E'\n' ORDER BY item)) AS schema_fingerprint
FROM schema_items`;
const identity = {
  restoreInstanceId: 'vay2017-metadata-rehearsal-isolated-20260923',
  sourceSnapshotId: 'vay2017-legacy-source-freeze-20260920',
  restoreResourceId: 'db-BB7GOFQ3BQTLTBG444I2Q75X6Y',
  restoreInstanceArn: 'arn:aws:rds:eu-west-1:269416271598:db:vay2017-metadata-rehearsal-isolated-20260923',
  restoreAttestationChecksum: 'c'.repeat(64), scannerSourceChecksum: 'b'.repeat(64),
  imageDigest: CATALOG_IMAGE_DIGEST,
};
function fixture(change = () => undefined) {
  const calls = [], connections = [], closed = [];
  const connect = async (name) => {
    connections.push(name);
    return {
      async query(sql) {
        calls.push([name, sql]);
        const override = change(sql, name);
        if (override !== undefined) return override;
        if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: 'on' }] };
        if (sql === CATALOG_IDENTITY_SQL) return { rows: [{ database_name: name, server_address: '10.230.0.42', database_user: 'vay2017_metadata_reader', session_user: 'vay2017_metadata_reader' }] };
        if (sql === fingerprintSql) return { rows: [{ source_database: name, schema_fingerprint: 'a'.repeat(32) }] };
        assert.ok(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql), 'unexpected query');
        return { rows: [] };
      },
      async end() { closed.push(name); },
    };
  };
  return { calls, connections, closed, connect };
}
test('four fingerprints use only pinned catalog SQL and independently read-only transactions', async () => {
  assert.equal(createHash('sha256').update(fingerprintSql).digest('hex'), CATALOG_SQL_SHA256);
  const f = fixture();
  const artifact = await collectSourceCatalog(f.connect, { ...identity, password: 'do-not-emit' }, fingerprintSql, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(f.connections, ['vayada_auth_db', 'vayada_booking_db', 'postgres', 'vayada_pms_db']);
  assert.deepEqual(f.closed, f.connections);
  assert.deepEqual(artifact, {
    artifactVersion: 3, scope: 'isolated-source-catalog', collectedAt: '2026-09-26T00:00:00.000Z',
    ...identity, queryVersion: 'source-catalog-v1', queryChecksum: CATALOG_SQL_SHA256,
    databases: CATALOG_DATABASES.map(([sourceDatabase, name]) => ({ sourceDatabase, name, schemaFingerprint: 'a'.repeat(32) })),
  });
  assert.equal(f.calls.length, 20);
  assert.equal(f.calls.filter(([, sql]) => sql === 'COMMIT').length, 4);
  assert.equal(f.calls.some(([, sql]) => /count_table_rows|snapshot_rows|pg_database/.test(sql)), false);
  assert.doesNotMatch(JSON.stringify(artifact), /do-not-emit|rowCount|tables|columns|bound/);
});
test('changed SQL and wrong immutable identities fail before any connection', async () => {
  for (const [change, sql] of [
    [{}, fingerprintSql + ' '], [{}, undefined],
    [{ restoreResourceId: 'db-OTHER' }, fingerprintSql],
    [{ imageDigest: 'sha256:' + 'f'.repeat(64) }, fingerprintSql],
    [{ restoreInstanceId: 'production' }, fingerprintSql],
    [{ sourceSnapshotId: 'another-snapshot' }, fingerprintSql],
    [{ restoreInstanceArn: 'arn:wrong' }, fingerprintSql],
    [{ scannerSourceChecksum: 'secret' }, fingerprintSql],
    [{ restoreAttestationChecksum: '' }, fingerprintSql],
  ]) {
    const f = fixture();
    await assert.rejects(collectSourceCatalog(f.connect, { ...identity, ...change }, sql));
    assert.deepEqual(f.connections, []);
  }
});
test('unexpected identity, fingerprint, and read-only responses fail closed and close the first connection', async () => {
  for (const [query, rows] of [
    [CATALOG_IDENTITY_SQL, []],
    [CATALOG_IDENTITY_SQL, [{ database_name: 'postgres', server_address: '10.230.0.42' }]],
    ...[{ database_user: 'postgres' }, { session_user: 'postgres' }].map((role) =>
      [CATALOG_IDENTITY_SQL, [{ database_name: 'vayada_auth_db', server_address: '10.230.0.42', ...role }]]),
    ...['10.230.0.42/32', '10.231.0.42', '10.230.0.256', '8.8.8.8', null].map((server_address) =>
      [CATALOG_IDENTITY_SQL, [{ database_name: 'vayada_auth_db', server_address }]]),
    [fingerprintSql, []],
    [fingerprintSql, [{ source_database: 'vayada_auth_db', schema_fingerprint: 'a'.repeat(32) }, {}]],
    [fingerprintSql, [{ source_database: 'postgres', schema_fingerprint: 'a'.repeat(32) }]],
    ...['A'.repeat(32), 'a'.repeat(31), null, 123].map((schema_fingerprint) =>
      [fingerprintSql, [{ source_database: 'vayada_auth_db', schema_fingerprint }]]),
    ['SHOW transaction_read_only', [{ transaction_read_only: 'off' }]],
    ['SHOW transaction_read_only', [{ transaction_read_only: 'on' }, { transaction_read_only: 'on' }]],
  ]) {
    const resultRows = query === CATALOG_IDENTITY_SQL ? rows.map((row) => ({ database_user: 'vay2017_metadata_reader', session_user: 'vay2017_metadata_reader', ...row })) : rows;
    const f = fixture((sql) => sql === query ? { rows: resultRows } : undefined);
    await assert.rejects(collectSourceCatalog(f.connect, identity, fingerprintSql));
    assert.deepEqual(f.connections, ['vayada_auth_db']);
    assert.deepEqual(f.closed, f.connections);
    assert.equal(f.calls.at(-1)[1], 'ROLLBACK');
    assert.equal(f.calls.some(([, sql]) => sql === 'COMMIT'), false);
  }
});
test('every failed transaction stage rolls back and emits only safe error metadata', async () => {
  for (const failed of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SHOW transaction_read_only', CATALOG_IDENTITY_SQL, fingerprintSql, 'COMMIT']) {
    const f = fixture((sql) => {
      if (sql === failed) throw Object.assign(new Error('postgres://user:secret@private-db hotel-row'), { code: '42501' });
    });
    await assert.rejects(collectSourceCatalog(f.connect, identity, fingerprintSql), (error) => {
      assert.deepEqual(sanitizeError(error), { status: 'FAIL', stage: 'source-catalog', code: '42501', errorClass: 'Error' });
      assert.doesNotMatch(JSON.stringify(sanitizeError(error)), /secret|private-db|hotel-row/);
      return true;
    });
    assert.equal(f.calls.at(-1)[1], 'ROLLBACK');
    assert.deepEqual(f.closed, ['vayada_auth_db']);
  }
});
test('connection failures retain no raw credential or database error text', async () => {
  await assert.rejects(collectSourceCatalog(async () => { throw new Error('password=secret host=private-db'); }, identity, fingerprintSql), (error) => {
    assert.deepEqual(sanitizeError(error), { status: 'FAIL', stage: 'database-connect', code: 'UNKNOWN', errorClass: 'Error' });
    return true;
  });
});

test('wrapper accepts only the exact v3 catalog contract, never v2 or row data', async () => {
  const wrapper = readFileSync(new URL('./run-vay2017-rehearsal-metadata.sh', import.meta.url), 'utf8');
  const filter = wrapper.match(/--arg attestation_checksum "\$attestation_checksum" '([\s\S]*?)' <<<"\$artifact_json"/)?.[1];
  assert.ok(filter);
  const args = Object.entries({ snapshot: identity.sourceSnapshotId, restore: identity.restoreInstanceId,
    digest: CATALOG_IMAGE_DIGEST, source_checksum: identity.scannerSourceChecksum,
    query_checksum: CATALOG_SQL_SHA256, instance_arn: identity.restoreInstanceArn,
    attestation_checksum: identity.restoreAttestationChecksum }).flatMap(([key, value]) => ['--arg', key, value]);
  const artifact = await collectSourceCatalog(fixture().connect, identity, fingerprintSql, '2026-09-26T00:00:00.000Z');
  const validate = (value) => spawnSync('jq', ['-e', ...args, filter], { input: JSON.stringify(value), encoding: 'utf8' });
  const valid = validate(artifact);
  assert.equal(valid.status, 0, valid.stderr);
  for (const change of [
    { artifactVersion: 2 }, { scope: 'full-inventory' }, { sourceSnapshotId: 'production' },
    { restoreInstanceId: 'production' }, { restoreResourceId: 'db-OTHER' }, { restoreInstanceArn: 'wrong' },
    { restoreAttestationChecksum: 'd'.repeat(64) }, { imageDigest: 'sha256:' + 'f'.repeat(64) },
    { scannerSourceChecksum: 'd'.repeat(64) }, { queryVersion: 'v2' }, { queryChecksum: 'd'.repeat(64) },
    { collectedAt: 'invalid' }, { password: 'must-not-pass' }, { rowCount: '1' }, { databases: [] },
    { databases: artifact.databases.slice(1) }, { databases: [...artifact.databases, artifact.databases[0]] },
    ...[{ name: 'other' }, { sourceDatabase: 'other' }, { schemaFingerprint: 'a'.repeat(64) },
      { tables: [] }, { rowCount: '1' }].map((bad) => ({ databases: [{ ...artifact.databases[0], ...bad }, ...artifact.databases.slice(1)] })),
  ]) assert.notEqual(validate({ ...artifact, ...change }).status, 0, JSON.stringify(change));
  const tf = readFileSync(new URL('../infra/vay2017-metadata-runner/runner.tf', import.meta.url), 'utf8');
  const task = tf.split('resource "aws_ecs_task_definition" "vay2017_metadata"')[1].split('data "aws_iam_policy_document"')[0];
  assert.match(task, /VAY2017_CATALOG_ONLY", value = "1"/);
  assert.match(task, /image\s*=.*local.vay2042_catalog_image_digest/);
  for (const file of ['run-vay2017-rehearsal-metadata.sh', 'check-vay2017-rehearsal-isolation.sh']) {
    assert.ok(readFileSync(new URL(file, import.meta.url), 'utf8').includes(CATALOG_IMAGE_DIGEST));
  }
  assert.equal(tf.match(/vay2042_catalog_image_digest\s*=\s*"([^"]+)"/)?.[1], CATALOG_IMAGE_DIGEST);
});
