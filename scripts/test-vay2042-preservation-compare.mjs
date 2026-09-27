import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { checksumTable, compare } from './vay2042-preservation-compare.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('checksums preserve duplicate rows and reject injected relations', async () => {
  let fetches = 0;
  const client = { async query(sql) {
    if (sql.startsWith('DECLARE') || sql.startsWith('CLOSE')) return { rows: [] };
    assert.match(sql, /^FETCH FORWARD 500/);
    return { rows: fetches++ === 0 ? [{ row_json: '{"id":1}' }, { row_json: '{"id":1}' }] : [] };
  } };
  assert.deepEqual(await checksumTable(client, 'public.hotels'), {
    count: 2, sha256: sha256(`${sha256('{"id":1}')}\n${sha256('{"id":1}')}\n`),
  });
  await assert.rejects(checksumTable(client, 'public.hotels;drop table hotels'), /manifest_invalid/);
});

function fakeConnections({ changed = false, expanded = false, superuser = false } = {}) {
  const statements = [];
  return { statements, async connect(kind, database) {
    let table;
    let fetched = false;
    const source = manifest.sources.find((entry) => entry.database === database);
    assert.ok(source);
    return { async query(sql) {
      statements.push(sql);
      if (sql === 'SHOW default_transaction_read_only') return {
        rows: [{ default_transaction_read_only: 'on' }],
      };
      if (sql.includes('current_setting')) return { rows: [{ address: '10.230.0.20', database,
        username: kind === 'source' ? 'vay2042_source_reader_20260925' : 'vayada_admin',
        session_username: kind === 'source' ? 'vay2042_source_reader_20260925' : 'vayada_admin',
        read_only: 'on' }] };
      if (sql.includes('SELECT rolname, rolcanlogin, rolconnlimit')) return { rows: [{
        rolname: 'vay2042_source_reader_20260925', rolcanlogin: true, rolconnlimit: 4,
        rolsuper: superuser && kind === 'source', rolcreatedb: false, rolcreaterole: false, rolinherit: false,
        rolreplication: false, rolbypassrls: false, rolvaliduntil: new Date(Date.now() + 86_400_000),
      }] };
      if (sql.includes('FROM pg_roles r WHERE r.rolname')) return { rowCount: 1,
        rows: [{ membership: false, ownership: false, attributes: true,
          database_write: false, schema_write: expanded && kind === 'source', relation_privileges: false,
          sequence_privileges: false, definer_privileges: false, missing_read: false }] };
      if (sql.includes('FROM pg_class c JOIN pg_namespace')) return {
        rows: source.tables.map((name) => ({ name })),
      };
      if (sql.startsWith('DECLARE')) {
        table = source.tables.find((name) => sql.includes(name.replace('.', '"."')));
        assert.ok(table);
        fetched = false;
        return { rows: [] };
      }
      if (sql.startsWith('FETCH')) {
        if (fetched) return { rows: [] };
        fetched = true;
        return { rows: [{ row_json: JSON.stringify({ table,
          value: changed && kind === 'source' && table === 'public.hotels' ? 2 : 1 }) }] };
      }
      return { rows: [] };
    }, async end() {} };
  } };
}

test('all 83 tables match in read-only transactions without logging rows', async () => {
  const fake = fakeConnections();
  const report = await compare(fake);
  assert.equal(report.status, 'OK');
  assert.equal(report.tables, 83);
  assert.equal(report.rows, 83);
  assert.equal(report.evidence.tables.length, 83);
  assert.match(report.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(fake.statements.filter((sql) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 8);
  assert.equal(fake.statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)), false);
});

test('a changed hotel row fails closed', async () => {
  const fake = fakeConnections({ changed: true });
  await assert.rejects(compare(fake), /source_rows_mismatch/);
  assert.ok(fake.statements.includes('ROLLBACK'));
});

test('expanded source privileges fail before source-row reads', async () => {
  const fake = fakeConnections({ expanded: true });
  await assert.rejects(compare(fake), /source_privilege_mismatch/);
  const firstSourceCursor = fake.statements.findIndex((sql) => sql.startsWith('DECLARE'));
  const privilegeCheck = fake.statements.findIndex((sql) => sql.includes('FROM pg_roles r WHERE r.rolname'));
  assert.ok(privilegeCheck > firstSourceCursor);
  assert.equal(fake.statements.slice(privilegeCheck).some((sql) => sql.startsWith('DECLARE')), false);
});

test('a superuser source role fails before source-row reads', async () => {
  const fake = fakeConnections({ superuser: true });
  await assert.rejects(compare(fake), /source_privilege_mismatch/);
});

test('PostgreSQL 16/17 streams the same JSONB checksum inside a read-only transaction',
  { skip: !process.env.VAY2042_TEST_DATABASE_URL }, async () => {
    const { default: pg } = await import(process.env.VAY2042_TEST_PG_MODULE);
    const client = new pg.Client({ connectionString: process.env.VAY2042_TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query('CREATE TEMP TABLE preservation_fixture (id integer, payload jsonb)');
      await client.query(`INSERT INTO preservation_fixture VALUES
        (1, '{"name":"first"}'), (1, '{"name":"first"}'), (2, '{"name":"second"}')`);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      const result = await checksumTable(client, 'pg_temp.preservation_fixture');
      assert.equal(result.count, 3);
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(await checksumTable(client, 'pg_temp.preservation_fixture'), result);
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  });
