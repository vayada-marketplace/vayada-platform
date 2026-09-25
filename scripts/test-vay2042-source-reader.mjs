import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { provisionSourceReader, reader } from './provision-vay2042-source-reader.mjs';

const url = new URL(process.env.VAY2042_TEST_DATABASE_URL ?? 'postgresql://postgres:fixture@127.0.0.1:55442/postgres');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/postgres');
const require = createRequire(pathToFileURL(process.env.VAY2042_TEST_PG_MODULE ?? '/tmp/vay2042-test/node_modules/pg/lib/index.js'));
const { Client } = require('pg');
const ident = (v) => `"${v.replaceAll('"', '""')}"`;
const relation = (v) => v.split('.').map(ident).join('.');
async function open(database, user = 'postgres', password = decodeURIComponent(url.password)) {
  const client = new Client({ host: url.hostname, port: Number(url.port), database, user, password });
  await client.connect();
  return client;
}

test('source bootstrap proves exact grants, denied writes, and safe partial failures on PostgreSQL', async (t) => {
  const root = await open('postgres');
  const dbs = new Map();
  t.after(async () => { await Promise.all([...dbs.values(), root].map((c) => c.end())); });
  assert.deepEqual((await root.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map((r) => r.datname), ['postgres'], 'tests require a fresh disposable PostgreSQL cluster');
  assert.equal((await root.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'")).rows[0].n, 0, 'tests require an empty postgres database');
  await root.query("CREATE ROLE fixture_bootstrap LOGIN CREATEDB CREATEROLE NOINHERIT PASSWORD 'fixture-admin'");
  await root.query('ALTER DATABASE postgres OWNER TO fixture_bootstrap');
  await root.query('REVOKE TEMPORARY ON DATABASE template1 FROM PUBLIC');
  for (const database of manifest.databases) {
    if (database !== 'postgres') await root.query(`CREATE DATABASE ${ident(database)} OWNER fixture_bootstrap`);
    const client = await open(database, 'fixture_bootstrap', 'fixture-admin');
    dbs.set(database, client);
    await client.query(`REVOKE TEMPORARY ON DATABASE ${ident(database)} FROM PUBLIC`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    for (const table of manifest.sources.find((s) => s.database === database)?.tables ?? ['public.retained_target']) {
      const [schema] = table.split('.');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
      await client.query(`CREATE TABLE ${relation(table)} (id int PRIMARY KEY, value text)`);
      await client.query(`INSERT INTO ${relation(table)} VALUES (1, 'synthetic-only')`);
    }
  }
  const connect = (database) => open(database, 'fixture_bootstrap', 'fixture-admin');
  let persisted;
  const persistCredential = async (value) => { persisted = value; };
  const roleState = async () => (await root.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [reader])).rows;
  const discardFixtureRole = async () => {
    for (const database of dbs.keys()) {
      const client = await open(database);
      try { await client.query(`DROP OWNED BY ${ident(reader)}`); } finally { await client.end(); }
    }
    await root.query(`DROP ROLE ${ident(reader)}`);
    persisted = undefined;
  };

  await t.test('rejects changed database and source table inventories before creating a role', async () => {
    await root.query('CREATE DATABASE unexpected_fixture');
    await assert.rejects(provisionSourceReader({ connect, persistCredential }), /restore_database_inventory_changed/);
    assert.deepEqual(await roleState(), []);
    await root.query('DROP DATABASE unexpected_fixture');
    await dbs.get('postgres').query('CREATE TABLE public.unexpected_fixture(id int)');
    await assert.rejects(provisionSourceReader({ connect, persistCredential }), /source_table_inventory_changed/);
    assert.deepEqual(await roleState(), []);
    await dbs.get('postgres').query('DROP TABLE public.unexpected_fixture');
  });
  for (const [name, grant, revoke] of [
    ['public target SELECT', 'GRANT SELECT ON public.retained_target TO PUBLIC', 'REVOKE SELECT ON public.retained_target FROM PUBLIC'],
    ['public target UPDATE', 'GRANT UPDATE(value) ON public.retained_target TO PUBLIC', 'REVOKE UPDATE(value) ON public.retained_target FROM PUBLIC'],
    ['public schema CREATE', 'GRANT CREATE ON SCHEMA public TO PUBLIC', 'REVOKE CREATE ON SCHEMA public FROM PUBLIC'],
    ['public definer routine', 'CREATE FUNCTION public.unsafe_fixture() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$', 'DROP FUNCTION public.unsafe_fixture()'],
  ]) {
    await t.test(`rejects ${name} without publishing or enabling the new role`, async () => {
      const target = dbs.get('vayada_target_prod');
      await target.query(grant);
      await assert.rejects(provisionSourceReader({ connect, persistCredential }), /source_reader_privilege_mismatch/);
      assert.deepEqual(await roleState(), [{ rolcanlogin: false }]);
      assert.equal(persisted, undefined);
      await target.query(revoke);
      await discardFixtureRole();
    });
  }
  await t.test('credential-store failure and retry never enable or overwrite the partial role', async () => {
    await assert.rejects(provisionSourceReader({ connect, persistCredential: async () => { throw new Error('synthetic-store-failure'); } }), /synthetic-store-failure/);
    assert.deepEqual(await roleState(), [{ rolcanlogin: false }]);
    await assert.rejects(provisionSourceReader({ connect, persistCredential }), /source_reader_exists_inspect_prior_attempt/);
    await discardFixtureRole();
  });
  await t.test('holds one advisory lock across the bootstrap', async () => {
    await root.query('SELECT pg_advisory_lock(204220260925)');
    await assert.rejects(provisionSourceReader({ connect, persistCredential }), /source_reader_bootstrap_busy/);
    await root.query('SELECT pg_advisory_unlock(204220260925)');
    assert.deepEqual(await roleState(), []);
  });
  await t.test('reports an indeterminate final activation without claiming disabled or retrying', async () => {
    const lostAckConnect = async (database) => {
      const client = await connect(database);
      const query = client.query.bind(client);
      client.query = async (...args) => {
        const result = await query(...args);
        if (args[0] === `ALTER ROLE ${ident(reader)} LOGIN`) throw new Error('synthetic-lost-ack');
        return result;
      };
      return client;
    };
    await assert.rejects(provisionSourceReader({ connect: lostAckConnect, persistCredential }), /source_reader_activation_outcome_unknown/);
    assert.deepEqual(await roleState(), [{ rolcanlogin: true }]);
    assert.equal(persisted.username, reader);
    await assert.rejects(provisionSourceReader({ connect, persistCredential }), /source_reader_exists_inspect_prior_attempt/);
    await discardFixtureRole();
  });
  await t.test('publishes a verified, expiring reader and rejects writes even in READ WRITE', async () => {
    assert.deepEqual(await provisionSourceReader({ connect, persistCredential }),
      { status: 'OK', scope: 'isolated-source-reader', databases: 4, tables: 83 });
    assert.equal(persisted.username, reader);
    assert.deepEqual(await roleState(), [{ rolcanlogin: true }]);
    const role = (await root.query('SELECT rolpassword, rolvaliduntil FROM pg_authid WHERE rolname=$1', [reader])).rows[0];
    assert.ok(role.rolpassword.startsWith('SCRAM-SHA-256$'));
    assert.ok(role.rolvaliduntil > new Date());
    for (const { database, tables } of manifest.sources) {
      const client = await open(database, reader, persisted.password);
      try {
        for (const table of tables) assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${relation(table)}`)).rows[0].n, 1);
        await client.query('BEGIN READ WRITE');
        await assert.rejects(client.query(`UPDATE ${relation(tables[0])} SET value=value WHERE false`), { code: '42501' });
        await client.query('ROLLBACK');
        await client.query('BEGIN READ WRITE');
        await assert.rejects(client.query('CREATE TEMP TABLE forbidden_fixture(id int)'), { code: '42501' });
        await client.query('ROLLBACK');
      } finally { await client.end(); }
    }
    const other = await open('vayada_target_prod', reader, persisted.password);
    try { await assert.rejects(other.query('SELECT * FROM public.retained_target'), { code: '42501' }); }
    finally { await other.end(); }
  });
});
