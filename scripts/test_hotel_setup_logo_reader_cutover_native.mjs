// Run inside retained 18fa against an owned, fully migrated TLS PostgreSQL 16/17 fixture.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {runLogoReaderCutover, verifyLogoReader} from './hotel-setup-logo-reader-cutover.mjs';

const pg = createRequire('/app/apps/api/package.json')('pg');
const inventoryPath = '/app/apps/api/dist/hotelSetupReaderPrivileges.js';
assert.equal(createHash('sha256').update(readFileSync(inventoryPath)).digest('hex'),
  '73ff08cf4ce995bf01224eb35592ca8f5dcc7f7b7da29c34a987ae2217da7d26');
const {HOTEL_SETUP_READER_READ_COLUMNS: reads, HOTEL_SETUP_READER_AUDIT_COLUMNS: auditColumns,
  HOTEL_SETUP_READER_RLS_HELPERS: helpers} = await import(inventoryPath);
const {checkHotelSetupReader} = await import('/app/apps/api/dist/cli/hotelSetupReaderPreflight.js');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.username, 'postgres');
assert.equal(url.pathname, '/vayada_target_prod');
assert.equal(url.search, '?sslmode=verify-full');
assert.ok(url.password);
url.search = '';
const ssl = {rejectUnauthorized: true, ca: readFileSync(process.env.TEST_SSL_CA, 'utf8')};
// The enclosing fixture has network=none: a regressed URL guard cannot reach RDS.
const shortCredential = spawnSync(process.execPath, ['/app/scripts/hotel-setup-logo-reader-cutover.mjs'], {
  encoding: 'utf8', timeout: 15000, maxBuffer: 8192, env: {...process.env,
    GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', HOTEL_SETUP_LOGO_READER_PHASE: 'verify',
    HOTEL_SETUP_LOGO_READER_FROZEN: '1', VAYADA_DB_RDS_CA_BUNDLE: ssl.ca,
    HOTEL_SETUP_COMMAND_READER_DATABASE_URL: 'postgresql://vayada_next_hotel_setup_reader:short@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod?sslmode=verify-full'},
});
assert.equal(shortCredential.status, 1); assert.equal(shortCredential.stdout, '');
assert.deepEqual(JSON.parse(shortCredential.stderr), {status: 'FAIL', scope: 'hotel_setup_logo_reader_cutover',
  phase: 'verify', code: 'hotel_setup_logo_reader_cutover_unavailable', stage: 'configuration', sqlState: null});
const connect = connection => new pg.Client({connectionString: connection.href, ssl,
  connectionTimeoutMillis: 10000, query_timeout: 15000});
const admin = connect(url);
await admin.connect();
const readerName = 'vayada_next_hotel_setup_reader', creatorName = 'vayada_admin';
const missing = {
  'platform.hotel_setup_property_scopes': ['actor_user_id'],
  'platform.media_upload_sessions': ['id', 'actor_user_id', 'owner_organization_id',
    'requested_purpose', 'property_id', 'resource_product', 'resource_type', 'resource_id'],
};
assert.equal(Object.values(missing).flat().length, 9);
for (const [table, columns] of Object.entries(missing))
  assert.ok(columns.every(column => reads[table].includes(column)));
const globalHash = async () => (await admin.query(`SELECT md5(json_build_object(
  'roles',(SELECT json_agg(r ORDER BY oid) FROM pg_authid r),
  'memberships',(SELECT json_agg(r ORDER BY roleid,member,grantor) FROM pg_auth_members r),
  'settings',(SELECT json_agg(r ORDER BY setdatabase,setrole) FROM pg_db_role_setting r),
  'databases',(SELECT json_agg(json_build_object('oid',oid,'name',datname,'acl',datacl)
    ORDER BY oid) FROM pg_database))::text) AS hash`)).rows[0].hash;
const originalGlobal = await globalHash();
const databaseAcls = (await admin.query('SELECT datname,datacl::text AS acl FROM pg_database ORDER BY datname')).rows;
assert.deepEqual((await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',
  [[creatorName, readerName]])).rows, []);
assert.equal((await admin.query("SELECT to_regclass('platform.reader_cutover_sentinel') AS relation")).rows[0].relation, null);
const password = randomUUID() + randomUUID(), created = [];
let creator, sentinelCreated = false;
const boundedFailure = (error, phase) => {
  console.error(JSON.stringify({status: 'FAIL', phase,
    sqlState: /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null,
    assertion: error?.code === 'ERR_ASSERTION',
    line: /test_hotel_setup_logo_reader_cutover_native\.mjs:(\d+):/.exec(error?.stack ?? '')?.[1] ?? null}));
  throw new Error(`Native reader cutover ${phase} failed; bounded diagnostic above`);
};
try {
  await admin.query(`CREATE ROLE ${creatorName} LOGIN NOINHERIT NOSUPERUSER CREATEROLE
    NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(password)}`);
  created.push(creatorName);
  await admin.query(`CREATE ROLE ${readerName} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE
    NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(password)}`);
  created.push(readerName);
  for (const database of databaseAcls)
    await admin.query(`REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.datname)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE vayada_target_prod TO ${creatorName},${readerName};
    GRANT USAGE ON SCHEMA identity,platform TO ${creatorName},${readerName}`);
  for (const [table, columns] of Object.entries(reads)) {
    const retained = columns.filter(column => !missing[table]?.includes(column));
    if (retained.length) await admin.query(`GRANT SELECT(${retained.join(',')}) ON ${table} TO ${readerName}`);
  }
  await admin.query(`GRANT INSERT(${auditColumns.join(',')}) ON platform.product_audit_events TO ${readerName}`);
  for (const helper of helpers) await admin.query(`GRANT EXECUTE ON FUNCTION ${helper} TO ${readerName}`);
  for (const [table, columns] of Object.entries(missing))
    await admin.query(`GRANT SELECT(${columns.join(',')}) ON ${table} TO ${creatorName} WITH GRANT OPTION`);
  await admin.query('CREATE TABLE platform.reader_cutover_sentinel(id uuid,payload text)');
  sentinelCreated = true;
  await admin.query('INSERT INTO platform.reader_cutover_sentinel VALUES($1,$2)',
    [randomUUID(), 'SECRET_SENTINEL_BUSINESS_DATA']);
  const readerOid = (await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1', [readerName])).rows[0].oid;
  const creatorUrl = new URL(url); creatorUrl.username = creatorName; creatorUrl.password = password;
  const readerUrl = new URL(url); readerUrl.username = readerName; readerUrl.password = password;
  creator = connect(creatorUrl); await creator.connect();
  assert.deepEqual((await creator.query(`SELECT rolsuper,rolcreaterole,
    has_table_privilege(current_user,'pg_catalog.pg_authid','SELECT') AS catalog_select,
    has_table_privilege(current_user,'pg_catalog.pg_authid','UPDATE') AS catalog_update
    FROM pg_roles WHERE rolname=current_user`)).rows,
  [{rolsuper: false, rolcreaterole: true, catalog_select: false, catalog_update: false}]);
  await assert.rejects(creator.query('SELECT oid FROM pg_catalog.pg_authid LIMIT 1'), {code: '42501'});
  const snapshot = async () => [await globalHash(), (await admin.query(`SELECT md5(json_build_object(
    'columns',(SELECT json_agg(r ORDER BY attrelid,attnum) FROM pg_attribute r),
    'relations',(SELECT json_agg(r ORDER BY oid) FROM pg_class r),
    'schemas',(SELECT json_agg(r ORDER BY oid) FROM pg_namespace r),
    'functions',(SELECT json_agg(r ORDER BY oid) FROM pg_proc r),
    'scopes',(SELECT json_agg(r ORDER BY database_login) FROM platform.hotel_setup_property_scopes r),
    'uploads',(SELECT json_agg(r ORDER BY id) FROM platform.media_upload_sessions r),
    'audits',(SELECT json_agg(r ORDER BY audit_key) FROM platform.product_audit_events r),
    'sentinel',(SELECT json_agg(r ORDER BY id) FROM platform.reader_cutover_sentinel r))::text) AS hash`)).rows[0].hash];
  const safeReceipt = result => {
    const text = JSON.stringify(result);
    assert.ok(!text.includes(password) && !text.includes('SECRET_SENTINEL') && !text.includes('postgresql://'));
    return result;
  };
  const proof = async () => {
    const client = connect(readerUrl); await client.connect();
    try { await checkHotelSetupReader(client, 'property_commands'); }
    finally { await client.end(); }
  };
  const run = async (phase, frozen, mode = 'normal') => {
    const client = connect(creatorUrl); await client.connect();
    const query = client.query.bind(client), grants = [];
    let commits = 0;
    client.query = async (sql, ...args) => {
      assert.equal(typeof sql, 'string');
      assert.ok(!/\b(?:FROM|JOIN)\s+(?:pg_catalog\.)?pg_authid\b/i.test(sql));
      assert.ok(!/^\s*(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|REVOKE)\b/i.test(sql));
      if (/^\s*GRANT\b/i.test(sql)) {
        const grant = /^GRANT SELECT\s*\(([^)]+)\)\s+ON\s+(\S+)\s+TO\s+(\S+)\s*;?$/i.exec(sql.trim());
        assert.ok(grant, 'Only fixed column SELECT grants are permitted');
        const table = grant[2].replaceAll('"', ''), role = grant[3].replaceAll('"', '').replace(/;$/, '');
        assert.equal(role, readerName);
        const columns = grant[1].replaceAll('"', '').split(',').map(column => column.trim());
        assert.ok(columns.every(column => missing[table]?.includes(column)));
        grants.push(...columns.map(column => `${table}.${column}`));
      }
      const result = await query(sql, ...args); // Always execute real PostgreSQL first.
      if (mode === 'grantError' && grants.length && /^\s*GRANT\b/i.test(sql))
        throw Object.assign(Error('SECRET_SENTINEL_AFTER_REAL_GRANT'), {code: 'XX000'});
      if (sql === 'COMMIT') {
        commits++;
        if (mode === 'lost') throw Error('SECRET_SENTINEL_LOST_COMMIT');
      } else if (mode === 'readback' && commits && /^\s*SELECT\b/i.test(sql)) {
        throw Object.assign(Error('SECRET_SENTINEL_READBACK'), {code: 'XX000'});
      }
      return result;
    };
    try {return {receipt: safeReceipt(await runLogoReaderCutover(client, phase, frozen)), grants, commits};}
    finally {await client.end();}
  };
  await assert.rejects(proof(), /column privileges mismatch/);
  for (const [table, columns] of Object.entries(missing))
    await creator.query(`GRANT SELECT(${columns.join(',')}) ON ${table} TO ${readerName}`);
  try {
    await proof();
    console.log('PASS: original retained18fa native reader check after exact9 fixture grants');
  } finally {
    for (const [table, columns] of Object.entries(missing))
      await creator.query(`REVOKE SELECT(${columns.join(',')}) ON ${table} FROM ${readerName}`);
  }
  await assert.rejects(proof(), /column privileges mismatch/);
  const beforeInspect = await snapshot(), inspected = await run('inspect');
  assert.equal(inspected.receipt.status, 'PLAN', JSON.stringify(inspected.receipt));
  assert.equal(inspected.receipt.roleOid, readerOid); assert.equal(inspected.receipt.login, readerName);
  assert.deepEqual(inspected.receipt.missingColumns,
    Object.entries(missing).flatMap(([table, columns]) => columns.map(column => `${table}:${column}:SELECT`)).sort());
  assert.match(inspected.receipt.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(inspected.grants.length, 0); assert.equal(inspected.commits, 0);
  assert.deepEqual(await snapshot(), beforeInspect, 'Inspect must not change catalog or business state');
  const failed = (result, phase, stage, sqlState = null, status = 'FAIL') =>
    assert.deepEqual(result.receipt, {status, scope: 'hotel_setup_logo_reader_cutover', phase,
      code: 'hotel_setup_logo_reader_cutover_unavailable', stage, sqlState});
  const rejected = async stage => {
    const before = await snapshot(), result = await run('inspect');
    failed(result, 'inspect', stage);
    assert.equal(result.grants.length, 0); assert.equal(result.commits, 0);
    assert.deepEqual(await snapshot(), before);
  };
  for (const [change, undo, stage] of [
    [`GRANT SELECT(payload) ON platform.reader_cutover_sentinel TO ${readerName}`,
      `REVOKE SELECT(payload) ON platform.reader_cutover_sentinel FROM ${readerName}`, 'column_privileges'],
    [`GRANT SELECT(id) ON identity.users TO ${readerName} WITH GRANT OPTION`,
      `REVOKE GRANT OPTION FOR SELECT(id) ON identity.users FROM ${readerName}`, 'column_privileges'],
    [`ALTER ROLE ${readerName} INHERIT`, `ALTER ROLE ${readerName} NOINHERIT`, 'role_posture'],
    [`REVOKE SELECT(email) ON identity.users FROM ${readerName}`, `GRANT SELECT(email) ON identity.users TO ${readerName}`, 'columns'],
    [`GRANT CREATE ON SCHEMA platform TO ${readerName}`, `REVOKE CREATE ON SCHEMA platform FROM ${readerName}`, 'column_privileges'],
    [`REVOKE GRANT OPTION FOR SELECT(actor_user_id) ON platform.hotel_setup_property_scopes FROM ${creatorName}`,
      `GRANT SELECT(actor_user_id) ON platform.hotel_setup_property_scopes TO ${creatorName} WITH GRANT OPTION`, 'columns'],
  ]) {
    await admin.query(change);
    try {await rejected(stage);} finally {await admin.query(undo);}
  }
  for (const [table, column] of [['pg_authid', 'rolpassword'], ['pg_shadow', 'passwd']]) {
    const original = (await admin.query(`SELECT attrelid,attnum,attacl::text AS acl
      FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2`, [`pg_catalog.${table}`, column])).rows[0];
    const before = await snapshot();
    await admin.query(`GRANT SELECT(${column}) ON pg_catalog.${table} TO PUBLIC`);
    try {await rejected('role_posture');}
    finally {
      await admin.query('UPDATE pg_attribute SET attacl=$1::aclitem[] WHERE attrelid=$2 AND attnum=$3',
        [original.acl, original.attrelid, original.attnum]);
    }
    assert.deepEqual(await snapshot(), before, 'Restore exact PUBLIC catalog column ACL');
  }
  const membershipPlan = (await run('inspect')).receipt;
  assert.equal(membershipPlan.status, 'PLAN', JSON.stringify(membershipPlan));
  const beforeMembership = await snapshot();
  await admin.query(`GRANT ${readerName} TO ${creatorName}`);
  try {
    await rejected('role_posture');
    const drift = await run('apply', membershipPlan.fingerprint);
    failed(drift, 'apply', 'role_posture');
    assert.equal(drift.grants.length, 0); assert.equal(drift.commits, 0);
  } finally {await admin.query(`REVOKE ${readerName} FROM ${creatorName}`);}
  assert.deepEqual(await snapshot(), beforeMembership);
  const plan = (await run('inspect')).receipt;
  assert.equal(plan.status, 'PLAN', JSON.stringify(plan));
  const beforeApply = await snapshot();
  const drift = await run('apply', '0'.repeat(64));
  failed(drift, 'apply', 'fingerprint');
  assert.equal(drift.grants.length, 0); assert.equal(drift.commits, 0);
  assert.deepEqual(await snapshot(), beforeApply);
  const rollback = await run('apply', plan.fingerprint, 'grantError');
  failed(rollback, 'apply', 'grant', 'XX000'); assert.ok(rollback.grants.length > 0);
  assert.equal(rollback.commits, 0); assert.deepEqual(await snapshot(), beforeApply);
  await assert.rejects(proof(), /column privileges mismatch/);
  const applied = await run('apply', plan.fingerprint);
  assert.equal(applied.receipt.status, 'PASS', JSON.stringify(applied.receipt)); assert.equal(applied.commits, 1);
  assert.deepEqual(applied.grants.sort(), Object.entries(missing).flatMap(([table, columns]) => columns.map(column => `${table}.${column}`)).sort());
  await proof();
  const native = connect(readerUrl); await native.connect();
  try {
    failed({receipt: safeReceipt(await verifyLogoReader(native, readerOid + 1))}, 'verify', 'identity');
    assert.equal(safeReceipt(await verifyLogoReader(native, readerOid)).status, 'PASS');
  }
  finally {await native.end();}
  const reset = async () => {
    for (const [table, columns] of Object.entries(missing))
      await creator.query(`REVOKE SELECT(${columns.join(',')}) ON ${table} FROM ${readerName}`);
    await assert.rejects(proof(), /column privileges mismatch/);
  };
  for (const [mode, status] of [['lost', 'UNCERTAIN'], ['readback', 'COMMITTED_UNVERIFIED']]) {
    await reset();
    const fresh = (await run('inspect')).receipt;
    assert.equal(fresh.status, 'PLAN', JSON.stringify(fresh));
    const outcome = await run('apply', fresh.fingerprint, mode);
    failed(outcome, 'apply', mode === 'lost' ? 'commit' : 'identity', mode === 'lost' ? null : 'XX000', status);
    assert.equal(outcome.commits, 1);
    assert.equal(outcome.grants.length, 9); await proof();
    const committed = await snapshot(), retry = await run('apply', fresh.fingerprint);
    failed(retry, 'apply', 'fingerprint'); assert.equal(retry.grants.length, 0);
    assert.equal(retry.commits, 0); assert.deepEqual(await snapshot(), committed);
  }
  assert.deepEqual((await admin.query('SELECT payload FROM platform.reader_cutover_sentinel')).rows,
    [{payload: 'SECRET_SENTINEL_BUSINESS_DATA'}]);
} catch (error) {
  boundedFailure(error, 'assertions'); // Retain the original failure if cleanup also fails.
} finally {
  try {
    if (creator) {
      for (const [table, columns] of Object.entries(missing))
        await creator.query(`REVOKE SELECT(${columns.join(',')}) ON ${table} FROM ${readerName}`);
      await creator.end();
    }
    if (sentinelCreated) await admin.query('DROP TABLE platform.reader_cutover_sentinel');
    for (const role of created.reverse()) {
      await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(role)}`);
      await admin.query(`DROP ROLE ${admin.escapeIdentifier(role)}`);
    }
    for (const database of databaseAcls)
      await admin.query('UPDATE pg_database SET datacl=$1::aclitem[] WHERE datname=$2', [database.acl, database.datname]);
    assert.equal(await globalHash(), originalGlobal, 'Exact fixture global cleanup');
    await admin.end();
  } catch (error) {boundedFailure(error, 'cleanup');}
}
console.log('PASS: actual retained18fa reader preflight, NS catalog denial, exact9 real grants, extra/grantable/posture/unknown-missing/fingerprint refusal, real grant rollback and lost-COMMIT no retry, bounded receipts and exact global cleanup');
