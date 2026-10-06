// Run only against an owned loopback PostgreSQL 16/17 fixture with native TLS.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const pg = createRequire(process.env.TEST_PG_MODULE)('pg');
const inventoryPath = resolve(process.env.TEST_MIGRATION_DIRECTORY,'../../../apps/api/dist/hotelSetupLogoPrivileges.js');
const inventoryModule = await import(pathToFileURL(inventoryPath).href);
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
    'scopes',(SELECT json_agg(row ORDER BY id) FROM platform.hotel_setup_property_scopes row),
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
        const read = (/^SELECT\s/.test(text) || text.startsWith('WITH history AS (')) && !text.includes(';') &&
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
      'node:fs': {readFileSync: path => readFileSync(path==='/app/apps/api/dist/hotelSetupLogoPrivileges.js' ? inventoryPath : `${directory}/${path.split('/').at(-1)}`)}};
    const module = new vm.SourceTextModule(readFileSync(new URL('./inspect-hotel-setup-logo-migration.mjs', import.meta.url), 'utf8'), {context,
      importModuleDynamically: async name => {
        assert.equal(name,'/app/apps/api/dist/hotelSetupLogoPrivileges.js');
        const exports = ['HOTEL_SETUP_LOGO_PRIVILEGES','HOTEL_SETUP_LOGO_RLS_HELPERS'];
        const inventory = new vm.SyntheticModule(exports,function(){for(const key of exports)this.setExport(key,inventoryModule[key]);},{context});
        await inventory.link(()=>{});await inventory.evaluate();return inventory;
      }});
    await module.link(name => new vm.SyntheticModule(Object.keys(modules[name]), function() {
      for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
    }, {context}));
    await module.evaluate();
    assert.equal(exit, undefined, JSON.stringify(receipt)); assert.equal(receipt.status, 'PASS'); assert.ok(queries > 10);
    assert.equal(await rowHash(), beforeRows); assert.equal(await globalHash(), beforeGlobals);
    assert.equal(receipt.inspection.identity.rolsuper, false);
    assert.equal(receipt.inspection.identity.rolcreaterole, true);
    assert.equal(JSON.stringify(receipt).includes('SECRET_SENTINEL'), false);
    assert.equal(JSON.stringify(receipt).includes(password), false);
    return receipt.inspection;
  }
  let inspection = await run();
  assert.equal(inspection.roles.some(role => role.name === 'vayada_next_hotel_setup_logo_scope'), false);
  assert.deepEqual(inspection.logoBootstraps.map(attempt=>[attempt.owner,attempt.roles.total,attempt.scopes.columnsPresent,attempt.authorityReadable]),[['animals',0,false,false],['sri',0,false,false]]);
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
  // Owned fixtures exercise real catalog permissions, orphan roles, pending/ready rows and fixed-owner isolation.
  await setup.query('CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog');
  for (const [table,privileges] of Object.entries(inventoryModule.HOTEL_SETUP_LOGO_PRIVILEGES)) {
    const columns=[...new Set(Object.values(privileges).flat())];
    await setup.query(`CREATE TABLE ${table}(${columns.map(column=>`${column} ${column==='id'?'uuid':'text'}`).join(',')})`);
    await setup.query(`ALTER TABLE ${table} OWNER TO vayada_target_prod_user`);
  }
  await setup.query(`ALTER TABLE platform.hotel_setup_property_scopes ADD database_login name,ADD property_id uuid,ADD organization_id uuid,
    ADD actor_user_id uuid,ADD operation_class text,ADD active boolean,ADD credential_role_oid oid,ADD credential_secret_version text,ADD credential_ready_at timestamptz;
    CREATE TABLE identity.users(id uuid,status text);
    CREATE TABLE identity.organization_memberships(id uuid,user_id uuid,organization_id uuid,status text,role_key text,permission_overrides jsonb,role_definition_id uuid,property_access_mode text,access_origin text,pms_access_enabled boolean,booking_access_enabled boolean);
    CREATE TABLE identity.organization_roles(id uuid,organization_id uuid,security_class text,base_role_key text,preset_key text,default_permissions jsonb);
    CREATE TABLE identity.role_permission_grants(organization_kind text,role_key text,permission_key text);
    CREATE TABLE identity.membership_property_assignments(membership_id uuid,property_id uuid);
    ALTER TABLE identity.organization_resource_links ALTER organization_id TYPE uuid USING organization_id::uuid;
    GRANT USAGE ON SCHEMA identity,hotel_catalog TO vayada_admin;
    GRANT SELECT ON ALL TABLES IN SCHEMA identity,hotel_catalog,platform TO vayada_admin`);
  const animals={property:'f4b1d762-7592-4182-b103-20b53014c171',organization:'2734e584-022d-432a-9637-ccb0cce59c53',actor:'a729d719-2297-4be7-8f7a-12bdf87da1b3'};
  const prefix='vayada_next_hotel_setup_logo_37f915790bff5732_';
  const staged=prefix+'000000000001', pending=prefix+'000000000002', ready=prefix+'000000000003', malformed=prefix+'SECRET_SENTINEL';
  for(const role of ['vayada_next_hotel_setup_logo_scope',malformed,staged,pending,ready,'vayada_next_hotel_setup_logo_unrelated']){
    await setup.query(`CREATE ROLE ${setup.escapeIdentifier(role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB`);createdRoles.push(role);
  }
  await setup.query(`GRANT vayada_next_hotel_setup_logo_scope TO ${staged},${pending},${ready} WITH INHERIT TRUE,SET FALSE;
    ALTER ROLE ${ready} LOGIN PASSWORD 'SECRET_SENTINEL_NATIVE_PASSWORD';
    CREATE FUNCTION platform.hotel_setup_logo_context() RETURNS boolean LANGUAGE sql AS 'SELECT true';
    ALTER FUNCTION platform.hotel_setup_logo_context() OWNER TO vayada_target_prod_user;
    REVOKE ALL ON FUNCTION platform.hotel_setup_logo_context() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION platform.hotel_setup_logo_context() TO vayada_next_hotel_setup_logo_scope;
    GRANT SELECT(id,profile_revision,default_locale,profile_status) ON hotel_catalog.properties TO vayada_admin WITH GRANT OPTION;
    GRANT USAGE ON SCHEMA hotel_catalog TO vayada_admin WITH GRANT OPTION;
    GRANT DELETE ON hotel_catalog.property_media TO vayada_admin WITH GRANT OPTION;
    GRANT SELECT(oid,rolpassword) ON pg_catalog.pg_authid TO vayada_admin`);
  await setup.query('INSERT INTO identity.users VALUES($1,$2)',[animals.actor,'active']);
  await setup.query('INSERT INTO identity.organizations(id,kind,status)VALUES($1,$2,$3)',[animals.organization,'hotel_group','active']);
  await setup.query('INSERT INTO hotel_catalog.properties(id)VALUES($1)',[animals.property]);
  await setup.query("INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status)VALUES($1,'hotel_catalog','property',$2,'owner','active')",[animals.organization,animals.property]);
  await setup.query("INSERT INTO identity.organization_memberships(id,user_id,organization_id,status,role_key,property_access_mode,access_origin,pms_access_enabled,booking_access_enabled)VALUES($1,$2,$3,'active','hotel_owner','all','agency',false,false)",[randomUUID(),animals.actor,animals.organization]);
  await setup.query("INSERT INTO identity.role_permission_grants VALUES('hotel_group','hotel_owner','hotel_catalog.setup.manage')");
  const version=randomUUID();
  await setup.query(`INSERT INTO platform.hotel_setup_property_scopes(id,database_login,property_id,organization_id,actor_user_id,operation_class,active)
    VALUES(1,$1,$2,$3,$4,'property_logo',false)`,[pending,animals.property,animals.organization,animals.actor]);
  await setup.query(`INSERT INTO platform.hotel_setup_property_scopes(id,database_login,property_id,organization_id,actor_user_id,operation_class,active,credential_role_oid,credential_secret_version,credential_ready_at)
    VALUES(2,$1::text::name,$2,$3,$4,'property_logo',true,$1::text::regrole::oid,$5,now())`,[ready,animals.property,animals.organization,animals.actor,version]);
  inspection=await run();
  const attempt=inspection.logoBootstraps[0], capabilities=inspection.bootstrapCapabilities;
  assert.equal(attempt.roles.total,4);assert.equal(attempt.scopes.total,2);assert.equal(attempt.passwordPresenceReadable,true);
  assert.equal(attempt.roles.entries.find(role=>role.name===staged).passwordPresent,false);
  assert.equal(attempt.roles.entries.find(role=>role.name===ready).passwordPresent,true);
  assert.ok(attempt.roles.entries.filter(role=>role.name!=='other').every(role=>role.exact_scope_edges===1));
  assert.equal(attempt.roles.entries.find(role=>role.name==='other').nameSha256,createHash('sha256').update(malformed).digest('hex'));
  assert.ok(Object.entries(attempt.authority).every(([key,value])=>key==='membership_count'?value===1:value===true));
  assert.equal(attempt.scopes.entries.find(scope=>scope.login.name===pending).ready_at_present,false);
  assert.equal(attempt.scopes.entries.find(scope=>scope.login.name===ready).secretVersion,version);
  assert.equal(attempt.scopes.entries.find(scope=>scope.login.name===ready).role_oid_matches,true);
  assert.equal(inspection.logoBootstraps[1].roles.total,0);assert.equal(inspection.logoBootstraps[1].scopes.total,0);
  assert.deepEqual(capabilities.columns.find(row=>row.table_name==='hotel_catalog.properties'&&row.privilege==='SELECT'),
    {table_name:'hotel_catalog.properties',privilege:'SELECT',expected_columns:4,found_columns:4,grantable_columns:4});
  assert.equal(capabilities.columns.find(row=>row.table_name==='hotel_catalog.properties'&&row.privilege==='UPDATE').grantable_columns,0);
  assert.equal(capabilities.mediaDeleteGrant,true);
  assert.equal(capabilities.schemas.find(row=>row.name==='hotel_catalog').usage_grant,true);
  assert.equal(capabilities.helpers.find(row=>row.signature==='platform.hotel_setup_logo_context()').parent_execute,true);
  assert.equal(capabilities.helpers.find(row=>row.signature==='platform.hotel_setup_logo_context()').expected_owner,true);
  await setup.query("UPDATE identity.organization_memberships SET permission_overrides='{\"grant\":[],\"deny\":[\"SECRET_SENTINEL\"]}'");
  await setup.query('UPDATE platform.hotel_setup_property_scopes SET actor_user_id=$1,credential_secret_version=$2 WHERE id=2',[randomUUID(),'SECRET_SENTINEL']);
  await setup.query('REVOKE SELECT(oid,rolpassword) ON pg_catalog.pg_authid FROM vayada_admin');
  inspection=await run();
  assert.equal(inspection.logoBootstraps[0].authority.exact_owner_membership,false);
  assert.equal(inspection.logoBootstraps[0].scopes.entries.find(scope=>scope.login.name===ready).actor_matches,false);
  assert.equal(inspection.logoBootstraps[0].scopes.entries.find(scope=>scope.login.name===ready).secretVersion,null);
  assert.equal(inspection.logoBootstraps[0].passwordPresenceReadable,false);
  await setup.query("UPDATE identity.organization_memberships SET access_origin='SECRET_SENTINEL',pms_access_enabled=NULL");
  for(let i=4;i<=6;i++){
    const role=prefix+String(i).padStart(12,'0');await setup.query(`CREATE ROLE ${role} NOLOGIN`);createdRoles.push(role);
  }
  inspection=await run();
  assert.equal(inspection.logoBootstraps[0].authority.product_flags_valid,false);
  assert.equal(inspection.logoBootstraps[0].authority.property_access,false);
  assert.equal(inspection.logoBootstraps[0].roles.total,7);assert.equal(inspection.logoBootstraps[0].roles.entries.length,5);
} finally {
  await setup?.end();
  if (databaseCreated) await admin.query('DROP DATABASE vayada_target_prod');
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE ${admin.escapeIdentifier(role)}`);
  assert.equal(await globalHash(), before, 'Exact global roles/settings/memberships/database ACL cleanup differs');
  await admin.end();
}
console.log('PASS: native TLS NOSUPERUSER audit, pinned inventory grant capabilities, fixed Owner authority and bounded orphan/pending/ready metadata, password-presence capability, canonical history, read-only queries, sanitized output and exact catalog/global cleanup');
