// Native PostgreSQL 16/17 test: production URL/CA remain fixed in the module;
// only this test adapter redirects its connection into an isolated local cluster.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(process.env.TEST_PG_MODULE);
const pg=require('pg');
const local=process.env.TEST_DATABASE_URL;
assert.match(local,/^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:\d+\/postgres(?:\?sslmode=verify-full)?$/);
const localUrl=new URL(local);localUrl.search='';
const ca=process.env.TEST_SSL_CA ? readFileSync(process.env.TEST_SSL_CA,'utf8') : undefined;
if(new URL(local).search)assert.ok(ca,'Native TLS requires TEST_SSL_CA');
const ssl=ca ? {rejectUnauthorized:true,ca} : undefined;
const admin=new pg.Client({connectionString:localUrl.href,ssl});await admin.connect();
const globalSnapshot=async()=>(await admin.query(`SELECT md5(json_build_object(
 'roles',(SELECT json_agg(r ORDER BY oid) FROM pg_catalog.pg_authid r),
 'settings',(SELECT json_agg(r ORDER BY setdatabase,setrole) FROM pg_catalog.pg_db_role_setting r),
 'memberships',(SELECT json_agg(r ORDER BY roleid,member,grantor) FROM pg_catalog.pg_auth_members r),
 'databases',(SELECT json_agg(json_build_object('name',datname,'acl',datacl) ORDER BY datname) FROM pg_catalog.pg_database))::text) AS hash`)).rows[0].hash;
const before=await globalSnapshot();
assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('vayada_admin','vayada_target_prod_user','vayada_next_hotel_setup_logo_scope')")).rows[0].count,0);
assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_database WHERE datname='vayada_target_prod'")).rows[0].count,0);
const created=[];
let databaseCreated=false,setup;
try {
await admin.query("CREATE ROLE vayada_admin LOGIN NOSUPERUSER CREATEROLE PASSWORD 'local-stage-test'");
created.push('vayada_admin');
await admin.query('CREATE ROLE vayada_target_prod_user NOLOGIN NOCREATEROLE NOSUPERUSER');
created.push('vayada_target_prod_user');
await admin.query('CREATE DATABASE vayada_target_prod TEMPLATE template0');databaseCreated=true;
const url=new URL(localUrl);url.pathname='/vayada_target_prod';
setup=new pg.Client({connectionString:url.href,ssl});await setup.connect();
await setup.query(`CREATE SCHEMA platform; CREATE TABLE platform.hotel_setup_property_scopes(id int);
 ALTER TABLE platform.hotel_setup_property_scopes OWNER TO vayada_target_prod_user;
 CREATE TABLE platform.schema_migrations(id serial,version text,name text,status text,environment text,
 checksum_sha256 text,failure_reason text,applied_at timestamptz DEFAULT now());
 GRANT USAGE ON SCHEMA platform TO vayada_admin;
 GRANT SELECT ON platform.schema_migrations TO vayada_admin;`);
const migrationDir=process.env.TEST_MIGRATION_DIRECTORY;
const hash=name=>createHash('sha256').update(readFileSync(`${migrationDir}/${name}`)).digest('hex');
await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256)
 VALUES('0464','hotel_setup_reconciliation_cursor','applied','production',$1)`,[hash('0464_hotel_setup_reconciliation_cursor.sql')]);
const catalogSnapshot=async()=>(await setup.query(`SELECT md5(json_build_object(
 'ledger',(SELECT json_agg(r ORDER BY id) FROM platform.schema_migrations r),
 'schemas',(SELECT json_agg(r ORDER BY oid) FROM pg_namespace r),
 'relations',(SELECT json_agg(r ORDER BY oid) FROM pg_class r),
 'functions',(SELECT json_agg(r ORDER BY oid) FROM pg_proc r))::text) AS hash`)).rows[0].hash;
let uncertain=false,selfGrant=false,denyLock=false;
async function run(){
 const catalogBefore=await catalogSnapshot(),globalBefore=await globalSnapshot();
 let receipt,exit;
 class Client extends pg.Client {
  constructor(options){assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.ca,ca??'test-ca');const connection=new URL(url);connection.username='vayada_admin';connection.password='local-stage-test';super({connectionString:connection.href,ssl});}
  async connect(){await super.connect();if(selfGrant)await super.query("SET createrole_self_grant='inherit,set'");}
  async query(...args){if(denyLock&&args[0].includes('pg_advisory_xact_lock'))return super.query("SELECT 'SECRET_SENTINEL_DO_NOT_LOG'::integer");const value=await super.query(...args);if(uncertain&&args[0]==='COMMIT')throw Error('acknowledgement lost');return value;}
 }
 const context=vm.createContext({URL,process:{env:{HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL:'postgresql://vayada_admin:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require',VAYADA_DB_RDS_CA_BUNDLE:ca??'test-ca'},set exitCode(v){exit=v;}},console:{log:v=>receipt=JSON.parse(v),error:v=>receipt=JSON.parse(v)}});
 const modules={pg:{default:{Client}},'node:crypto':{createHash},'node:fs':{readFileSync:path=>readFileSync(`${migrationDir}/${path.split('/').at(-1)}`)}};
 const module=new vm.SourceTextModule(readFileSync(new URL('./stage-hotel-setup-logo-migration-scope.mjs',import.meta.url),'utf8'),{context});
 await module.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){for(const [key,value]of Object.entries(modules[name]))this.setExport(key,value);},{context}));await module.evaluate();
 assert.equal(await catalogSnapshot(),catalogBefore,'Stage changed owned ledger or database catalog');
 if(exit===1&&!uncertain)assert.equal(await globalSnapshot(),globalBefore,'Rejected stage changed global catalog');
 return {receipt,exit};
}
const absent=async()=>assert.equal((await setup.query("SELECT count(*)::int AS count FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope'")).rows[0].count,0);
await setup.query('ALTER ROLE vayada_target_prod_user CREATEROLE');assert.equal((await run()).exit,1);await absent();await setup.query('ALTER ROLE vayada_target_prod_user NOCREATEROLE');
await setup.query("UPDATE platform.schema_migrations SET checksum_sha256='wrong'");assert.equal((await run()).exit,1);await absent();await setup.query('UPDATE platform.schema_migrations SET checksum_sha256=$1',[hash('0464_hotel_setup_reconciliation_cursor.sql')]);
await setup.query("UPDATE platform.schema_migrations SET name='0464_hotel_setup_reconciliation_cursor.sql'");assert.equal((await run()).exit,1);await absent();await setup.query("UPDATE platform.schema_migrations SET name='hotel_setup_reconciliation_cursor'");
await setup.query("INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason)VALUES('0466','0466_hotel_setup_logo_scope.sql','failed','production',$1,'permission denied to create role')",[hash('0466_hotel_setup_logo_scope.sql')]);assert.equal((await run()).exit,1);await absent();await setup.query("DELETE FROM platform.schema_migrations WHERE version='0466'");
await setup.query("INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256)VALUES('0467','unexpected','applied','production','wrong')");assert.equal((await run()).exit,1);await absent();await setup.query("DELETE FROM platform.schema_migrations WHERE version='0467'");
denyLock=true;const denied=await run();denyLock=false;
assert.equal(denied.exit,1);assert.equal(denied.receipt.stage,'lock');assert.equal(denied.receipt.sqlstate,'22P02');assert.equal(denied.receipt.parentPosture,null);
assert.ok(!JSON.stringify(denied.receipt).includes('SECRET_SENTINEL'));await absent();
selfGrant=true;const inherited=await run();selfGrant=false;
assert.equal(inherited.exit,1);assert.equal(inherited.receipt.stage,'parent_verify');assert.equal(inherited.receipt.sqlstate,null);
assert.equal(inherited.receipt.parentPosture.incoming_memberships,2);
assert.ok(inherited.receipt.parentPosture.creator_edges.some(edge=>edge.creator_matches&&edge.admin_option&&!edge.inherit_option&&!edge.set_option&&edge.grantor_superuser));
assert.ok(inherited.receipt.parentPosture.creator_edges.some(edge=>edge.creator_matches&&!edge.admin_option&&edge.inherit_option&&edge.set_option&&!edge.grantor_superuser));await absent();
const result=await run();assert.equal(result.receipt.status,'PASS');assert.equal(result.receipt.migrationOwnerCanCreateRole,false);
const posture=(await setup.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope'")).rows[0];assert.ok(Object.values(posture).every(value=>value===false));
const edges=(await setup.query("SELECT member::regrole::text AS member,admin_option,inherit_option,set_option FROM pg_catalog.pg_auth_members WHERE roleid='vayada_next_hotel_setup_logo_scope'::regrole OR member='vayada_next_hotel_setup_logo_scope'::regrole")).rows;assert.deepEqual(edges,[{member:'vayada_admin',admin_option:true,inherit_option:false,set_option:false}]);assert.equal(result.receipt.creatorAdminOnlyMembership,true);
assert.equal((await run()).exit,1); // No adopting an already-existing global parent.
await setup.query('DROP ROLE vayada_next_hotel_setup_logo_scope');
await setup.query("INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason)VALUES('0466','hotel_setup_logo_scope','failed','production',$1,'permission denied to create role')",[hash('0466_hotel_setup_logo_scope.sql')]);
uncertain=true;assert.equal((await run()).receipt.code,'hotel_setup_scope_commit_inspection_required');
assert.equal((await setup.query("SELECT count(*)::int AS count FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope'")).rows[0].count,1);
assert.equal((await setup.query('SELECT count(*)::int AS count FROM platform.schema_migrations')).rows[0].count,2);
} finally {
 await setup?.end();
 if(databaseCreated)await admin.query('DROP DATABASE vayada_target_prod');
 if(created.length&& (await admin.query("SELECT 1 FROM pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope'")).rowCount)await admin.query('DROP ROLE vayada_next_hotel_setup_logo_scope');
 for(const role of created.reverse())await admin.query(`DROP ROLE ${role}`);
 assert.equal(await globalSnapshot(),before,'Exact global roles/settings/membership/database ACL cleanup differs');
 await admin.end();
}
console.log('PASS: native fixed parent staging, canonical ledger denials, strict self-grant rejection with rolled-back posture, bounded SQLSTATE without error text, exact protected-admin-only membership, ledger/catalog preservation, unknown COMMIT and exact global cleanup');
