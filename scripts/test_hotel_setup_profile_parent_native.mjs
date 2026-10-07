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
const ROLE='vayada_next_hotel_setup_profile_scope';
const admin=new pg.Client({connectionString:localUrl.href,ssl});await admin.connect();
const globalSnapshot=async()=>(await admin.query(`SELECT md5(json_build_object(
 'roles',(SELECT json_agg(r ORDER BY oid) FROM pg_catalog.pg_authid r),
 'settings',(SELECT json_agg(r ORDER BY setdatabase,setrole) FROM pg_catalog.pg_db_role_setting r),
 'memberships',(SELECT json_agg(r ORDER BY roleid,member,grantor) FROM pg_catalog.pg_auth_members r),
 'databases',(SELECT json_agg(json_build_object('name',datname,'acl',datacl) ORDER BY datname) FROM pg_catalog.pg_database))::text) AS hash`)).rows[0].hash;
const before=await globalSnapshot();
assert.equal((await admin.query(`SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('vayada_admin','vayada_target_prod_user','${ROLE}')`)).rows[0].count,0);
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
assert.equal(hash('0470_hotel_setup_profile_edit_scope.sql'),'065464209d9d0f32bb20465c3f511bf7feb7a15199617a2d7ad06c135334e536');
const predecessors=[['0466','hotel_setup_logo_scope'],['0467','hotel_setup_logo_session_binding'],
 ['0468','hotel_setup_logo_media_scope'],['0469','hotel_setup_logo_projection']];
for(const [version,name] of predecessors)await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256)
 VALUES($1,$2,'applied','production',$3)`,[version,name,hash(`${version}_${name}.sql`)]);
const catalogSnapshot=async()=>(await setup.query(`SELECT md5(json_build_object(
 'ledger',(SELECT json_agg(r ORDER BY id) FROM platform.schema_migrations r),
 'schemas',(SELECT json_agg(r ORDER BY oid) FROM pg_namespace r),
 'relations',(SELECT json_agg(r ORDER BY oid) FROM pg_class r),
 'functions',(SELECT json_agg(r ORDER BY oid) FROM pg_proc r))::text) AS hash`)).rows[0].hash;
let uncertain=false,selfGrant=false,denyLock=false,edgeMode='stock',imageBytes=null,imagePredecessor=null;
async function run(){
 const catalogBefore=await catalogSnapshot(),globalBefore=await globalSnapshot();
 let receipt,exit;
 class Client extends pg.Client {
  constructor(options){assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.ca,ca??'test-ca');const connection=new URL(url);if(edgeMode==='stock'){connection.username='vayada_admin';connection.password='local-stage-test';}super({connectionString:connection.href,ssl});}
  async connect(){await super.connect();if(edgeMode!=='stock')await super.query('SET SESSION AUTHORIZATION vayada_admin');if(selfGrant)await super.query("SET createrole_self_grant='inherit,set'");}
  async query(...args){
   if(denyLock&&args[0].includes('pg_advisory_xact_lock'))return super.query("SELECT 'SECRET_SENTINEL_DO_NOT_LOG'::integer");
   const create=args[0].startsWith(`CREATE ROLE ${ROLE}`);
   // Catalog emulation only: stock PG's NS creator cannot revoke its bootstrap-granted edge.
   // The zero-edge fixture creates as its owned superuser; every production check still runs NS.
   if(create&&edgeMode==='none')await super.query('RESET SESSION AUTHORIZATION');
   const value=await super.query(...args);
   if(create&&edgeMode!=='stock'){
    await super.query('RESET SESSION AUTHORIZATION');
    if(edgeMode==='foreign')await super.query(`REVOKE ${ROLE} FROM vayada_admin`);
    if(edgeMode==='foreign'||edgeMode==='extra')await super.query(`GRANT ${ROLE} TO vayada_target_prod_user WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
    await super.query('SET SESSION AUTHORIZATION vayada_admin');
   }
   if(uncertain&&args[0]==='COMMIT')throw Error('acknowledgement lost');return value;
  }
 }
 const context=vm.createContext({URL,process:{env:{HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL:'postgresql://vayada_admin:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require',VAYADA_DB_RDS_CA_BUNDLE:ca??'test-ca'},set exitCode(v){exit=v;}},console:{log:v=>receipt=JSON.parse(v),error:v=>receipt=JSON.parse(v)}});
 const imageFile=path=>{const name=path.split('/').at(-1);assert.equal(path,`/app/packages/backend-migration/migrations/${name}`);
  if(imagePredecessor&&name.startsWith(imagePredecessor+'_'))return Buffer.from('-- different predecessor bytes\n');
  return imageBytes&&name.startsWith('0470_')?imageBytes:readFileSync(`${migrationDir}/${name}`);};
 const modules={pg:{default:{Client}},'node:crypto':{createHash},'node:fs':{readFileSync:imageFile}};
 const module=new vm.SourceTextModule(readFileSync(new URL('./stage-hotel-setup-profile-migration-scope.mjs',import.meta.url),'utf8'),{context});
 await module.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){for(const [key,value]of Object.entries(modules[name]))this.setExport(key,value);},{context}));await module.evaluate();
 assert.equal(await catalogSnapshot(),catalogBefore,'Stage changed owned ledger or database catalog');
 if(exit===1&&!uncertain)assert.equal(await globalSnapshot(),globalBefore,'Rejected stage changed global catalog');
 return {receipt,exit};
}
const absent=async()=>assert.equal((await setup.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_roles WHERE rolname='${ROLE}'`)).rows[0].count,0);
const rejects=async(stage)=>{const result=await run();assert.equal(result.exit,1);assert.equal(result.receipt.code,'hotel_setup_scope_staging_unavailable');if(stage)assert.equal(result.receipt.stage,stage);await absent();};
// The image must carry the exact reviewed 0470 bytes and the applied 0466-0469 bytes.
imageBytes=Buffer.from('-- different 0470 bytes\n');await rejects('configuration');imageBytes=null;
imagePredecessor='0468';await rejects('ledger');imagePredecessor=null;
// The production migration owner must be unable to create roles (otherwise 0470 needs no pre-stage).
await setup.query('ALTER ROLE vayada_target_prod_user CREATEROLE');await rejects('owner');await setup.query('ALTER ROLE vayada_target_prod_user NOCREATEROLE');
// Every logo-family predecessor must be exactly applied in production.
await setup.query("UPDATE platform.schema_migrations SET checksum_sha256='wrong' WHERE version='0469'");await rejects('ledger');
await setup.query('UPDATE platform.schema_migrations SET checksum_sha256=$1 WHERE version=$2',[hash('0469_hotel_setup_logo_projection.sql'),'0469']);
await setup.query("UPDATE platform.schema_migrations SET name='0468_hotel_setup_logo_media_scope.sql' WHERE version='0468'");await rejects('ledger');
await setup.query("UPDATE platform.schema_migrations SET name='hotel_setup_logo_media_scope' WHERE version='0468'");
await setup.query("UPDATE platform.schema_migrations SET environment='staging' WHERE version='0467'");await rejects('ledger');
await setup.query("UPDATE platform.schema_migrations SET environment='production' WHERE version='0467'");
await setup.query("UPDATE platform.schema_migrations SET status='failed' WHERE version='0466'");await rejects('ledger');
await setup.query("UPDATE platform.schema_migrations SET status='applied' WHERE version='0466'");
await setup.query("INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason)VALUES('0467','hotel_setup_logo_session_binding','failed','production',$1,'unexpected')",[hash('0467_hotel_setup_logo_session_binding.sql')]);await rejects('ledger');
await setup.query("DELETE FROM platform.schema_migrations WHERE version='0467' AND status='failed'");
await setup.query("DELETE FROM platform.schema_migrations WHERE version='0468'");await rejects('ledger');
await setup.query("INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256)VALUES('0468','hotel_setup_logo_media_scope','applied','production',$1)",[hash('0468_hotel_setup_logo_media_scope.sql')]);
// 0470 may only be absent or an exact CREATE ROLE denial; no later or applied history is adopted.
for(const [values,params] of [
 ["('0470','0470_hotel_setup_profile_edit_scope.sql','failed','production',$1,'permission denied to create role')",[hash('0470_hotel_setup_profile_edit_scope.sql')]],
 ["('0470','hotel_setup_profile_edit_scope','failed','production','wrong','permission denied to create role')",[]],
 ["('0470','hotel_setup_profile_edit_scope','failed','production',$1,'syntax error')",[hash('0470_hotel_setup_profile_edit_scope.sql')]],
 ["('0470','hotel_setup_profile_edit_scope','applied','production',$1,NULL)",[hash('0470_hotel_setup_profile_edit_scope.sql')]],
 ["('0471','hotel_setup_profile_read_models','applied','production','unexpected',NULL)",[]],
 ["('04695','unexpected_between','applied','production','unexpected',NULL)",[]]]){
 await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason)VALUES${values}`,params);
 await rejects('ledger');await setup.query("DELETE FROM platform.schema_migrations WHERE version>'0469'");
}
denyLock=true;const denied=await run();denyLock=false;
assert.equal(denied.exit,1);assert.equal(denied.receipt.stage,'lock');assert.equal(denied.receipt.sqlstate,'22P02');assert.equal(denied.receipt.parentPosture,null);
assert.ok(!JSON.stringify(denied.receipt).includes('SECRET_SENTINEL'));await absent();
selfGrant=true;const inherited=await run();selfGrant=false;
assert.equal(inherited.exit,1);assert.equal(inherited.receipt.stage,'parent_verify');assert.equal(inherited.receipt.sqlstate,null);
assert.equal(inherited.receipt.parentPosture.incoming_memberships,2);
assert.ok(inherited.receipt.parentPosture.creator_edges.some(edge=>edge.creator_matches&&edge.admin_option&&!edge.inherit_option&&!edge.set_option&&edge.grantor_superuser));
assert.ok(inherited.receipt.parentPosture.creator_edges.some(edge=>edge.creator_matches&&!edge.admin_option&&edge.inherit_option&&edge.set_option&&!edge.grantor_superuser));await absent();
for(const [mode,count]of [['foreign',1],['extra',2]]){
 edgeMode=mode;const rejected=await run();edgeMode='stock';
 assert.equal(rejected.exit,1);assert.equal(rejected.receipt.stage,'parent_verify');
 assert.equal(rejected.receipt.parentPosture.incoming_memberships,count);
 assert.ok(rejected.receipt.parentPosture.creator_edges.some(edge=>!edge.creator_matches));await absent();
}
const expectedReceipt=count=>({status:'PASS',migration:'0470',scopeRole:ROLE,login:false,businessGrantsAdded:false,migrationOwner:'vayada_target_prod_user',migrationOwnerCanCreateRole:false,creatorAdminOnlyMembership:true,scopeIncomingMemberships:count});
edgeMode='none';const zero=await run();edgeMode='stock';
assert.deepEqual(zero.receipt,expectedReceipt(0));assert.equal(zero.exit,undefined);
assert.equal((await setup.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_auth_members WHERE roleid='${ROLE}'::regrole OR member='${ROLE}'::regrole`)).rows[0].count,0);
await setup.query(`DROP ROLE ${ROLE}`);
const result=await run();assert.deepEqual(result.receipt,expectedReceipt(1));assert.equal(result.exit,undefined);
const posture=(await setup.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='${ROLE}'`)).rows[0];assert.ok(Object.values(posture).every(value=>value===false));
const edges=(await setup.query(`SELECT member::regrole::text AS member,admin_option,inherit_option,set_option FROM pg_catalog.pg_auth_members WHERE roleid='${ROLE}'::regrole OR member='${ROLE}'::regrole`)).rows;assert.deepEqual(edges,[{member:'vayada_admin',admin_option:true,inherit_option:false,set_option:false}]);assert.equal(result.receipt.creatorAdminOnlyMembership,true);
assert.deepEqual((await setup.query(`SELECT has_schema_privilege('${ROLE}','platform','USAGE') AS usage,
 (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='platform' AND has_table_privilege('${ROLE}',c.oid,'SELECT,INSERT,UPDATE,DELETE')) AS tables`)).rows[0],{usage:false,tables:0},'Parent gained a business grant');
assert.equal((await run()).exit,1); // No adopting an already-existing global parent.
await setup.query(`DROP ROLE ${ROLE}`);
// Fallback order: a merged 0470 that failed exactly on CREATE ROLE may be pre-staged afterwards.
await setup.query("INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256,failure_reason)VALUES('0470','hotel_setup_profile_edit_scope','failed','production',$1,'permission denied to create role')",[hash('0470_hotel_setup_profile_edit_scope.sql')]);
uncertain=true;assert.equal((await run()).receipt.code,'hotel_setup_scope_commit_inspection_required');
assert.equal((await setup.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_roles WHERE rolname='${ROLE}'`)).rows[0].count,1);
assert.equal((await setup.query('SELECT count(*)::int AS count FROM platform.schema_migrations')).rows[0].count,5);
} finally {
 await setup?.end();
 if(databaseCreated)await admin.query('DROP DATABASE vayada_target_prod');
 if(created.length&& (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname='${ROLE}'`)).rowCount)await admin.query(`DROP ROLE ${ROLE}`);
 for(const role of created.reverse())await admin.query(`DROP ROLE ${role}`);
 assert.equal(await globalSnapshot(),before,'Exact global roles/settings/membership/database ACL cleanup differs');
 await admin.end();
}
console.log('PASS: profile 0470 parent — real NS creator with exact stock ADMIN-only edge, zero-edge native catalog emulation (not RDS authority proof), exact 0/1 receipts, pinned 0470 bytes, foreign/extra/self-grant rejection, exact applied 0466-0469 predecessors, absent-or-CREATE-ROLE-denied 0470 only, bounded SQLSTATE without error text, ledger/catalog preservation, unknown COMMIT and exact global cleanup');
