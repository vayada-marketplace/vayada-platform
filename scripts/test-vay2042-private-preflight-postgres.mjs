import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { provisionSourceReader, reader } from './provision-vay2042-source-reader.mjs';
import { provisionTarget, target, writer } from './provision-vay2042-target.mjs';
import { runPreflight } from './vay2042-private-preflight.mjs';

const url = new URL(process.env.VAY2042_TEST_DATABASE_URL ??
  'postgresql://postgres:fixture@127.0.0.1:55442/postgres');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/postgres');
const { Client } = createRequire(pathToFileURL(process.env.VAY2042_TEST_PG_MODULE ??
  '/tmp/vay2042-test/node_modules/pg/lib/index.js'))('pg');
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const relation = (value) => value.split('.').map(ident).join('.');
async function open(database, user = 'postgres', password = decodeURIComponent(url.password)) {
  const client = new Client({ host: url.hostname, port: Number(url.port), database, user, password });
  await client.connect();
  return client;
}

test('preflight renews only the exact two roles on a synthetic PostgreSQL restore', async (t) => {
  const root = await open('postgres');
  t.after(() => root.end());
  assert.deepEqual((await root.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'))
    .rows.map((row) => row.datname), ['postgres'], 'requires a fresh disposable cluster');
  await root.query("CREATE ROLE fixture_bootstrap LOGIN CREATEDB CREATEROLE NOINHERIT PASSWORD 'fixture-admin'");
  await root.query('ALTER DATABASE postgres OWNER TO fixture_bootstrap');
  await root.query('REVOKE TEMPORARY ON DATABASE template1 FROM PUBLIC');
  for (const database of manifest.databases) {
    if (database !== 'postgres') await root.query(`CREATE DATABASE ${ident(database)} OWNER fixture_bootstrap`);
    const client = await open(database, 'fixture_bootstrap', 'fixture-admin');
    try {
      await client.query(`REVOKE TEMPORARY ON DATABASE ${ident(database)} FROM PUBLIC`);
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      for (const table of manifest.sources.find((source) => source.database === database)?.tables ??
        ['public.retained_target']) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(table.split('.')[0])}`);
        await client.query(`CREATE TABLE ${relation(table)} (id int PRIMARY KEY, value text)`);
        await client.query(`INSERT INTO ${relation(table)} VALUES (1, 'synthetic-only')`);
      }
    } finally { await client.end(); }
  }
  const connectAdmin = (database) => open(database, 'fixture_bootstrap', 'fixture-admin');
  let sourceCredential;
  let targetCredential;
  assert.equal((await provisionSourceReader({ connect: connectAdmin,
    persistCredential: async (value) => { sourceCredential = value; },
    now: () => Date.parse('2026-09-25T13:22:45Z') })).status, 'OK');
  assert.equal((await provisionTarget({ connect: connectAdmin,
    persistCredential: async (value) => { targetCredential = value; },
    now: () => Date.parse('2026-09-25T13:34:20Z') })).status, 'OK');
  const connect = (database, identity) => identity === 'admin' ? connectAdmin(database) :
    identity === 'source' ? open(database, reader, sourceCredential.password) :
      open(database, writer, targetCredential.password);
  const result = await runPreflight({ connect, now: () => Date.parse('2026-09-26T16:00:00Z') });
  assert.deepEqual(result, { status: 'OK', stage: 'complete', scope: 'isolated-catalog-preflight',
    databases: 10, tables: 83, bound: false, expiresAt: '2026-09-27T16:00:00.000Z' });
  const roles = (await root.query('SELECT rolname,rolvaliduntil FROM pg_roles WHERE rolname = ANY($1::text[])',
    [[reader, writer]])).rows;
  assert.equal(roles.length, 2);
  for (const role of roles) assert.equal(role.rolvaliduntil.toISOString(), result.expiresAt);
  assert.equal((await root.query(`SELECT count(*)::int AS n FROM ${relation(manifest.sources[0].tables[0])}`))
    .rows[0].n, 1);
  const fresh = await open(target, writer, targetCredential.password);
  try {
    assert.equal((await fresh.query('SELECT count(*)::int AS n FROM vayada_migration_evidence.database_attestations'))
      .rows[0].n, 0);
  } finally { await fresh.end(); }
});
