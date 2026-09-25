import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { provisionTarget, target, writer, attestor } from './provision-vay2042-target.mjs';

const url = new URL(process.env.VAY2042_TEST_DATABASE_URL ?? 'postgresql://postgres:fixture@127.0.0.1:55446/postgres');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/postgres');
const { Client } = createRequire(pathToFileURL(process.env.VAY2042_TEST_PG_MODULE ?? '/tmp/vay2042-test/node_modules/pg/lib/index.js'))('pg');
const ident = (v) => `"${v.replaceAll('"', '""')}"`;
async function open(database, user = 'postgres', password = decodeURIComponent(url.password)) {
  const client = new Client({ host: url.hostname, port: Number(url.port), database, user, password });
  await client.connect();
  return client;
}

test('fresh target bootstrap with a non-superuser administrator', async (t) => {
  const root = await open('postgres');
  const dbs = new Map();
  t.after(async () => { await Promise.all([...dbs.values(), root].map((c) => c.end())); });
  assert.deepEqual((await root.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map((r) => r.datname), ['postgres'], 'requires a fresh disposable cluster');
  assert.equal((await root.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'")).rowCount, 0);
  await root.query("CREATE ROLE fixture_bootstrap LOGIN CREATEDB CREATEROLE NOINHERIT PASSWORD 'fixture-admin'");
  await root.query('ALTER DATABASE postgres OWNER TO fixture_bootstrap');
  await root.query('REVOKE TEMPORARY ON DATABASE template1 FROM PUBLIC');
  for (const database of manifest.databases) {
    if (database !== 'postgres') await root.query(`CREATE DATABASE ${ident(database)} OWNER fixture_bootstrap`);
    const client = await open(database, 'fixture_bootstrap', 'fixture-admin');
    dbs.set(database, client);
    await client.query(`REVOKE TEMPORARY ON DATABASE ${ident(database)} FROM PUBLIC`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query("CREATE TABLE public.retained(id int PRIMARY KEY, value text); INSERT INTO public.retained VALUES(1,'synthetic-only')");
  }
  const connect = (database) => open(database, 'fixture_bootstrap', 'fixture-admin');
  let persisted;
  const persistCredential = async (value) => {
    assert.deepEqual(await roleState(), [{ rolcanlogin: false }]);
    persisted = value;
  };
  const roleState = async () => (await root.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [writer])).rows;
  // Test-only cleanup; the provisioner never drops/reuses these objects.
  const discard = async () => {
    if ((await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount) await root.query(`DROP DATABASE ${ident(target)}`);
    if ((await roleState()).length) await root.query(`DROP ROLE ${ident(writer)}`);
    persisted = undefined;
  };
  const retained = async () => JSON.stringify(await Promise.all([...dbs].map(async ([database, client]) => ({ database,
    rows: (await client.query('SELECT * FROM public.retained')).rows,
    acl: (await client.query("SELECT relacl FROM pg_class WHERE oid='public.retained'::regclass")).rows,
    databaseAcl: (await client.query('SELECT datacl FROM pg_database WHERE datname=current_database()')).rows,
  }))));
  const baseline = await retained();

  await t.test('shares the source bootstrap lock', async () => {
    await root.query('SELECT pg_advisory_lock(204220260925)');
    await assert.rejects(provisionTarget({ connect, persistCredential }), /target_bootstrap_busy/);
    await root.query('SELECT pg_advisory_unlock(204220260925)');
    assert.deepEqual(await roleState(), []);
  });
  await t.test('refuses changed inventory, existing target and existing writer before mutation', async () => {
    await root.query('CREATE DATABASE unexpected_fixture');
    await assert.rejects(provisionTarget({ connect, persistCredential }), /restore_database_inventory_changed/);
    await root.query('DROP DATABASE unexpected_fixture');
    await root.query(`CREATE DATABASE ${ident(target)}`);
    await assert.rejects(provisionTarget({ connect, persistCredential }), /target_database_exists_inspect_prior_attempt/);
    assert.deepEqual(await roleState(), []);
    await discard();
    await root.query(`CREATE ROLE ${ident(writer)} NOLOGIN`);
    await assert.rejects(provisionTarget({ connect, persistCredential }), /target_writer_exists_inspect_prior_attempt/);
    await discard();
  });
  for (const [grant, revoke, error] of [
    ['GRANT SELECT(value) ON public.retained TO PUBLIC', 'REVOKE SELECT(value) ON public.retained FROM PUBLIC', /target_writer_privilege_mismatch/],
    ['GRANT UPDATE(value) ON public.retained TO PUBLIC', 'REVOKE UPDATE(value) ON public.retained FROM PUBLIC', /target_writer_privilege_mismatch/],
    ['GRANT CREATE ON SCHEMA public TO PUBLIC', 'REVOKE CREATE ON SCHEMA public FROM PUBLIC', /target_writer_privilege_mismatch/],
    ['CREATE FUNCTION public.unsafe_fixture() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$', 'DROP FUNCTION public.unsafe_fixture()', /target_writer_privilege_mismatch/],
    ['GRANT TEMP ON DATABASE vayada_target_prod TO PUBLIC', 'REVOKE TEMP ON DATABASE vayada_target_prod FROM PUBLIC', /target_writer_other_database_write/],
  ]) await t.test(`rejects effective privilege: ${grant.split(' ').slice(0, 2).join(' ')}`, async () => {
    await dbs.get('vayada_target_prod').query(grant);
    await assert.rejects(provisionTarget({ connect, persistCredential }), error);
    assert.deepEqual(await roleState(), [{ rolcanlogin: false }]);
    assert.equal(persisted, undefined);
    await dbs.get('vayada_target_prod').query(revoke);
    await discard();
  });
  await t.test('rejects unsafe existing attestor without fixing it', async () => {
    await root.query(`ALTER ROLE ${ident(attestor)} LOGIN`);
    await assert.rejects(provisionTarget({ connect, persistCredential }), /target_attestor_untrusted/);
    assert.deepEqual(await roleState(), []);
    assert.equal((await root.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [attestor])).rows[0].rolcanlogin, true);
    await root.query(`ALTER ROLE ${ident(attestor)} NOLOGIN`);
  });
  await t.test('keeps partial target disabled on persistence failure and refuses retry', async () => {
    await assert.rejects(provisionTarget({ connect, persistCredential: async () => { throw new Error('synthetic-store-failure'); } }), /synthetic-store-failure/);
    assert.deepEqual(await roleState(), [{ rolcanlogin: false }]);
    assert.equal((await root.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount, 1);
    await assert.rejects(provisionTarget({ connect, persistCredential }), /target_writer_exists_inspect_prior_attempt/);
    await discard();
  });
  await t.test('rolls back target grants and schema on interrupted evidence DDL', async () => {
    const interrupted = async (database) => {
      const client = await connect(database);
      const query = client.query.bind(client);
      client.query = async (...args) => {
        if (String(args[0]).includes('CREATE TABLE vayada_migration_evidence.database_attestations')) throw new Error('synthetic-ddl-failure');
        return query(...args);
      };
      return client;
    };
    await assert.rejects(provisionTarget({ connect: interrupted, persistCredential }), /synthetic-ddl-failure/);
    assert.deepEqual(await roleState(), [{ rolcanlogin: false }]);
    assert.equal(persisted, undefined);
    const client = await connect(target);
    try {
      assert.equal((await client.query("SELECT 1 FROM pg_namespace WHERE nspname='vayada_migration_evidence'")).rowCount, 0);
      assert.equal((await client.query("SELECT has_database_privilege($1,current_database(),'CONNECT,CREATE') AS access", [writer])).rows[0].access, false);
    } finally { await client.end(); }
    await discard();
  });
  await t.test('reports lost LOGIN acknowledgement explicitly without retry', async () => {
    const lostAck = async (database) => {
      const client = await connect(database);
      const query = client.query.bind(client);
      client.query = async (...args) => {
        const result = await query(...args);
        if (args[0] === `ALTER ROLE ${ident(writer)} LOGIN`) throw new Error('synthetic-lost-ack');
        return result;
      };
      return client;
    };
    await assert.rejects(provisionTarget({ connect: lostAck, persistCredential }), /target_writer_activation_outcome_unknown/);
    assert.deepEqual(await roleState(), [{ rolcanlogin: true }]);
    assert.equal(persisted.database, target);
    await assert.rejects(provisionTarget({ connect, persistCredential }), /target_writer_exists_inspect_prior_attempt/);
    await discard();
  });
  await t.test('allows target migrations but rejects source and attestation mutation', async () => {
    assert.deepEqual(await provisionTarget({ connect, persistCredential }), { status: 'OK', scope: 'isolated-fresh-target', bound: false });
    const role = (await root.query('SELECT * FROM pg_authid WHERE rolname=$1', [writer])).rows[0];
    assert.ok(role.rolpassword.startsWith('SCRAM-SHA-256$'));
    assert.ok(role.rolvaliduntil > new Date());
    assert.equal(role.rolcanlogin, true);
    for (const key of ['rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls']) assert.equal(role[key], false);
    const fresh = await open(target, writer, persisted.password);
    try {
      assert.equal((await fresh.query('SELECT * FROM vayada_migration_evidence.database_attestations')).rowCount, 0);
      await fresh.query('CREATE SCHEMA platform; CREATE TABLE platform.fixture(id int); INSERT INTO platform.fixture VALUES(1); CREATE EXTENSION btree_gist');
      for (const sql of [
        `SET ROLE ${ident(attestor)}`, 'CREATE DATABASE forbidden_fixture', 'CREATE ROLE forbidden_fixture',
        'CREATE TABLE vayada_migration_evidence.forbidden(id int)',
        "INSERT INTO vayada_migration_evidence.database_attestations VALUES('forged','value',now())",
        'TRUNCATE vayada_migration_evidence.database_attestations',
        'DROP SCHEMA vayada_migration_evidence CASCADE',
      ]) await assert.rejects(fresh.query(sql), { code: '42501' });
    } finally { await fresh.end(); }
    for (const database of manifest.databases) {
      const client = await open(database, writer, persisted.password);
      try {
        for (const sql of ['SELECT * FROM public.retained', 'UPDATE public.retained SET value=value', 'CREATE TABLE public.forbidden(id int)', 'CREATE TEMP TABLE forbidden(id int)'])
          await assert.rejects(client.query(sql), { code: '42501' });
      } finally { await client.end(); }
    }
    assert.equal(await retained(), baseline);
  });
});
