// Run only against an owned loopback PostgreSQL 16/17 fixture with native TLS.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const pg = createRequire(process.env.TEST_PG_MODULE)('pg');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.username, 'postgres');
assert.equal(url.pathname, '/postgres');
assert.equal(url.search, '?sslmode=verify-full');
assert.ok(url.password);
url.search = '';
const ca = readFileSync(process.env.TEST_SSL_CA, 'utf8');
const connect = connection => new pg.Client({connectionString: connection.href,
  ssl: {rejectUnauthorized: true, ca}, connectionTimeoutMillis: 10000, query_timeout: 15000});
const admin = connect(url);
await admin.connect();
const globalHash = async () => (await admin.query(`SELECT md5(json_build_object(
  'roles',(SELECT json_agg(role ORDER BY oid) FROM pg_catalog.pg_authid role),
  'memberships',(SELECT json_agg(edge ORDER BY roleid,member,grantor) FROM pg_catalog.pg_auth_members edge),
  'settings',(SELECT json_agg(setting ORDER BY setdatabase,setrole) FROM pg_catalog.pg_db_role_setting setting),
  'databases',(SELECT json_agg(json_build_object('oid',oid,'name',datname,'acl',datacl) ORDER BY oid)
    FROM pg_catalog.pg_database))::text) AS hash`)).rows[0].hash;
const before = await globalHash();
const existing = (await admin.query(`SELECT rolname FROM pg_catalog.pg_roles
  WHERE rolname IN ('vayada_admin','vayada_target_prod_user','vayada_next_hotel_setup_logo_scope')`)).rows;
assert.deepEqual(existing, []);
assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_catalog.pg_database WHERE datname='vayada_target_prod'")).rows[0].count, 0);
const password = randomUUID().replaceAll('-', '');
const createdRoles = [];
let databaseCreated = false, setup;
try {
  await admin.query(`CREATE ROLE vayada_admin LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB
    NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  createdRoles.push('vayada_admin');
  await admin.query('CREATE ROLE vayada_target_prod_user NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB');
  createdRoles.push('vayada_target_prod_user');
  await admin.query('CREATE DATABASE vayada_target_prod TEMPLATE template0');
  databaseCreated = true;
  const fixture = new URL(url); fixture.pathname = '/vayada_target_prod';
  setup = connect(fixture); await setup.connect();
  await setup.query(`CREATE SCHEMA platform;
    ALTER SCHEMA platform OWNER TO vayada_target_prod_user;
    CREATE TABLE platform.hotel_setup_property_scopes(id int);
    ALTER TABLE platform.hotel_setup_property_scopes OWNER TO vayada_target_prod_user;
    CREATE TABLE platform.schema_migrations(id serial,version text,name text,status text,environment text,
      checksum_sha256 text,failure_reason text,applied_at timestamptz DEFAULT now(),
      duration_ms int,statement_count int,requires_rebuild boolean DEFAULT false);
    GRANT USAGE ON SCHEMA platform TO vayada_admin;
    GRANT SELECT ON platform.schema_migrations TO vayada_admin`);
  const directory = process.env.TEST_MIGRATION_DIRECTORY;
  const hash = name => createHash('sha256').update(readFileSync(`${directory}/${name}`)).digest('hex');
  const rowHash = async () => (await setup.query(`SELECT md5(json_build_object(
    'ledger',(SELECT json_agg(row ORDER BY id) FROM platform.schema_migrations row),
    'schemas',(SELECT json_agg(row ORDER BY oid) FROM pg_catalog.pg_namespace row),
    'relations',(SELECT json_agg(row ORDER BY oid) FROM pg_catalog.pg_class row),
    'functions',(SELECT json_agg(row ORDER BY oid) FROM pg_catalog.pg_proc row))::text) AS hash`)).rows[0].hash;
  await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256)
    SELECT '0464','hotel_setup_reconciliation_cursor','applied','production',$1 FROM generate_series(1,4)`,
    [hash('0464_hotel_setup_reconciliation_cursor.sql')]);
  async function run() {
    let receipt, exit, queries = 0;
    const beforeRows = await rowHash(), beforeGlobals = await globalHash();
    class Client extends pg.Client {
      constructor(options) {
        assert.equal(options.ssl.rejectUnauthorized, true); assert.equal(options.ssl.ca, ca);
        const connection = new URL(fixture); connection.username = 'vayada_admin'; connection.password = password;
        super({connectionString: connection.href, ssl: options.ssl});
      }
      async query(text, ...args) {
        const unquoted = text.replace(/'(?:[^']|'')*'/g, "''");
        const read = (text.startsWith('SELECT ') || text.startsWith('WITH history AS (')) && !text.includes(';') &&
          !/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COMMIT)\b/i.test(unquoted) &&
          !/\bpg_advisory_[a-z_]*\s*\(/i.test(unquoted);
        assert.ok(text === 'BEGIN READ ONLY' || text === "SET LOCAL statement_timeout='15s'" || text === 'ROLLBACK' || read);
        queries++;
        try {return await super.query(text, ...args);} catch (error) {
          console.error(JSON.stringify({nativeQuerySqlState: error.code, nativeQueryPosition: error.position}));
          throw error;
        }
      }
    }
    const context = vm.createContext({URL, process: {env: {
      HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL: 'postgresql://vayada_admin:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require',
      VAYADA_DB_RDS_CA_BUNDLE: ca}, set exitCode(value) {exit = value;}},
      console: {log: value => receipt = JSON.parse(value), error: value => receipt = JSON.parse(value)}});
    const modules = {pg: {default: {Client}}, 'node:crypto': {createHash},
      'node:fs': {readFileSync: path => readFileSync(`${directory}/${path.split('/').at(-1)}`)}};
    const module = new vm.SourceTextModule(readFileSync(new URL('./inspect-hotel-setup-logo-migration.mjs', import.meta.url), 'utf8'), {context});
    await module.link(name => new vm.SyntheticModule(Object.keys(modules[name]), function() {
      for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
    }, {context}));
    await module.evaluate();
    assert.equal(exit, undefined, JSON.stringify(receipt)); assert.equal(receipt.status, 'PASS'); assert.ok(queries > 10);
    assert.equal(await rowHash(), beforeRows); assert.equal(await globalHash(), beforeGlobals);
    assert.equal(receipt.inspection.identity.rolsuper, false);
    assert.equal(receipt.inspection.identity.rolcreaterole, true);
    assert.equal(receipt.inspection.roles.some(role => role.name === 'vayada_next_hotel_setup_logo_scope'), false);
    assert.equal(JSON.stringify(receipt).includes('SECRET_SENTINEL'), false);
    assert.equal(JSON.stringify(receipt).includes(password), false);
    return receipt.inspection;
  }
  let inspection = await run();
  assert.ok([16,17].includes(Math.floor(inspection.server.serverVersionNum / 10000)));
  assert.equal(inspection.server.createroleSelfGrant, '');
  assert.equal(inspection.server.createroleSelfGrantReset, '');
  assert.equal(inspection.server.createroleSelfGrantSource, 'default');
  assert.equal(inspection.server.advisoryLockExecute, true); assert.equal(inspection.server.lockHashExecute, true);
  for (const value of ['inherit','set','set, inherit']) {
    await setup.query(`ALTER ROLE vayada_admin SET createrole_self_grant TO '${value}'`);
    const configured = (await run()).server;
    const expected = value === 'set, inherit' ? 'inherit,set' : value;
    assert.equal(configured.createroleSelfGrant, expected); assert.equal(configured.createroleSelfGrantReset, expected);
    assert.equal(configured.createroleSelfGrantSource, 'user');
  }
  await setup.query('ALTER ROLE vayada_admin RESET createrole_self_grant');
  await setup.query('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint), pg_catalog.hashtextextended(text,bigint) FROM PUBLIC');
  const restricted = (await run()).server;
  assert.equal(restricted.advisoryLockExecute, false); assert.equal(restricted.lockHashExecute, false);
  await setup.query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint), pg_catalog.hashtextextended(text,bigint) TO PUBLIC');
  assert.equal(inspection.ledger[0].total, 4); assert.equal(inspection.ledger[0].latest.length, 3);
  assert.equal(inspection.ledger[0].allAppliedBasenamePinned, true);
  assert.equal(inspection.ledger[0].allAppliedPinned, false);
  assert.ok(inspection.ledger[0].latest.every(row => row.basenameMatches && !row.filenameMatches));
  await setup.query("UPDATE platform.schema_migrations SET name='SECRET_SENTINEL' WHERE id=1");
  inspection = await run();
  assert.equal(inspection.ledger[0].allAppliedBasenamePinned, false);
  assert.ok(inspection.ledger[0].latest.every(row => row.basenameMatches));
  await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason)
    VALUES('0466','hotel_setup_logo_scope','failed','production',$1,'permission denied to create role SECRET_SENTINEL')`,
    [hash('0466_hotel_setup_logo_scope.sql')]);
  inspection = await run();
  assert.equal(inspection.ledger[2].allCreateRoleDeniedBasenamePinned, true);
  assert.equal(inspection.ledger[2].latest[0].reason, 'create_role_denied');
  const checksum = hash('0464_hotel_setup_reconciliation_cursor.sql'), rejected = 'a'.repeat(64);
  await setup.query("UPDATE platform.schema_migrations SET status='failed',failure_reason='SECRET_SENTINEL older DDL failure' WHERE id=1");
  await setup.query("UPDATE platform.schema_migrations SET checksum_sha256=$1 WHERE id=2", [rejected]);
  await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason,duration_ms,statement_count)
    VALUES('0464','hotel_setup_reconciliation_cursor','failed','production',$1,'SECRET_SENTINEL newer DDL failure',1,3)`, [checksum]);
  await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason,duration_ms)
    SELECT '0464','hotel_setup_reconciliation_cursor','failed','production',$1,$2,0 FROM generate_series(1,3)`,
    [rejected, `Checksum mismatch for 0464_hotel_setup_reconciliation_cursor.sql: ledger has ${checksum}, file is ${rejected}`]);
  inspection = await run();
  const witness = inspection.ledger[0].appliedWitness;
  assert.equal(witness.present, true); assert.equal(witness.canonical_pinned, true);
  assert.equal(witness.newer_attempts, 4); assert.equal(witness.newer_unresolved, 1);
  assert.equal(witness.older_total, 3); assert.equal(witness.older_failed, 1);
  assert.equal(witness.older_other_failure, 1); assert.equal(witness.older_applied_mismatch, 1);
  assert.ok(inspection.ledger[0].latest.every(row => row.reason === 'checksum_rejection'));
} finally {
  await setup?.end();
  if (databaseCreated) await admin.query('DROP DATABASE vayada_target_prod');
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE ${role}`);
  assert.equal(await globalHash(), before, 'Exact global roles/settings/memberships/database ACL cleanup differs');
  await admin.end();
}
console.log('PASS: native TLS NOSUPERUSER audit, bounded server/self-grant settings and function privileges, canonical basename/history diagnostics, absent parent, read-only queries, sanitized output and exact catalog/global cleanup');
