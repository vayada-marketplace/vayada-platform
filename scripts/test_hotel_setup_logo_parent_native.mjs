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
assert.match(local,/^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:\d+\/postgres$/);
const admin=new pg.Client({connectionString:local});await admin.connect();
await admin.query("CREATE ROLE vayada_admin LOGIN NOSUPERUSER CREATEROLE PASSWORD 'local-stage-test'");
await admin.query('CREATE ROLE vayada_target_prod_user NOLOGIN NOCREATEROLE NOSUPERUSER');
await admin.query('CREATE DATABASE vayada_target_prod');await admin.end();
const url=new URL(local);url.pathname='/vayada_target_prod';
const setup=new pg.Client({connectionString:url.href});await setup.connect();
await setup.query(`CREATE SCHEMA platform; CREATE TABLE platform.hotel_setup_property_scopes(id int);
 ALTER TABLE platform.hotel_setup_property_scopes OWNER TO vayada_target_prod_user;
 CREATE TABLE platform.schema_migrations(id serial,version text,name text,status text,environment text,
 checksum_sha256 text,failure_reason text,applied_at timestamptz DEFAULT now());
 GRANT USAGE ON SCHEMA platform TO vayada_admin;
 GRANT SELECT ON platform.schema_migrations TO vayada_admin;`);
const migrationDir=process.env.TEST_MIGRATION_DIRECTORY;
const hash=name=>createHash('sha256').update(readFileSync(`${migrationDir}/${name}`)).digest('hex');
await setup.query(`INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256)
 VALUES('0464','0464_hotel_setup_reconciliation_cursor.sql','applied','production',$1)`,[hash('0464_hotel_setup_reconciliation_cursor.sql')]);
let uncertain=false;
async function run(){
 let receipt,exit;
 class Client extends pg.Client {
  constructor(options){assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.ca,'test-ca');const connection=new URL(url);connection.username='vayada_admin';super({connectionString:connection.href});}
  async query(...args){const value=await super.query(...args);if(uncertain&&args[0]==='COMMIT')throw Error('acknowledgement lost');return value;}
 }
 const context=vm.createContext({URL,process:{env:{HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL:'postgresql://vayada_admin:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require',VAYADA_DB_RDS_CA_BUNDLE:'test-ca'},set exitCode(v){exit=v;}},console:{log:v=>receipt=JSON.parse(v),error:v=>receipt=JSON.parse(v)}});
 const modules={pg:{default:{Client}},'node:crypto':{createHash},'node:fs':{readFileSync:path=>readFileSync(`${migrationDir}/${path.split('/').at(-1)}`)}};
 const module=new vm.SourceTextModule(readFileSync(new URL('./stage-hotel-setup-logo-migration-scope.mjs',import.meta.url),'utf8'),{context});
 await module.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){for(const [key,value]of Object.entries(modules[name]))this.setExport(key,value);},{context}));await module.evaluate();return {receipt,exit};
}
const absent=async()=>assert.equal((await setup.query("SELECT count(*)::int AS count FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope'")).rows[0].count,0);
await setup.query('ALTER ROLE vayada_target_prod_user CREATEROLE');assert.equal((await run()).exit,1);await absent();await setup.query('ALTER ROLE vayada_target_prod_user NOCREATEROLE');
await setup.query("UPDATE platform.schema_migrations SET checksum_sha256='wrong'");assert.equal((await run()).exit,1);await absent();await setup.query('UPDATE platform.schema_migrations SET checksum_sha256=$1',[hash('0464_hotel_setup_reconciliation_cursor.sql')]);
await setup.query("INSERT INTO platform.schema_migrations(version,name,status,environment,checksum_sha256)VALUES('0467','unexpected','applied','production','wrong')");assert.equal((await run()).exit,1);await absent();await setup.query("DELETE FROM platform.schema_migrations WHERE version='0467'");
const result=await run();assert.equal(result.receipt.status,'PASS');assert.equal(result.receipt.migrationOwnerCanCreateRole,false);
const posture=(await setup.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope'")).rows[0];assert.ok(Object.values(posture).every(value=>value===false));
const edges=(await setup.query("SELECT member::regrole::text AS member,admin_option,inherit_option,set_option FROM pg_catalog.pg_auth_members WHERE roleid='vayada_next_hotel_setup_logo_scope'::regrole OR member='vayada_next_hotel_setup_logo_scope'::regrole")).rows;assert.deepEqual(edges,[{member:'vayada_admin',admin_option:true,inherit_option:false,set_option:false}]);assert.equal(result.receipt.creatorAdminOnlyMembership,true);
assert.equal((await run()).exit,1); // No adopting an already-existing global parent.
await setup.query('DROP ROLE vayada_next_hotel_setup_logo_scope');uncertain=true;assert.equal((await run()).receipt.code,'hotel_setup_scope_commit_inspection_required');
assert.equal((await setup.query("SELECT count(*)::int AS count FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope'")).rows[0].count,1);
assert.equal((await setup.query('SELECT count(*)::int AS count FROM platform.schema_migrations')).rows[0].count,1);
await setup.end();console.log('PASS: native fixed parent staging, owner/ledger denials, exact protected-admin-only membership and no ledger mutation, unknown COMMIT');
