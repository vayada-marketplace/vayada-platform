// Owned native TLS PG16/17. Guards and ACL revokes run NS; only successful final DROP emulates RDS authority.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
const pg=createRequire(process.env.TEST_PG_MODULE)('pg');
const inventoryPath=resolve(process.env.TEST_MIGRATION_DIRECTORY,'../../../apps/api/dist/hotelSetupLogoPrivileges.js');
const inventory=await import(pathToFileURL(inventoryPath).href);
const url=new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'postgres');assert.equal(url.pathname,'/postgres');assert.equal(url.search,'?sslmode=verify-full');url.search='';
const ssl={rejectUnauthorized:true,ca:readFileSync(process.env.TEST_SSL_CA,'utf8')};
const connect=u=>new pg.Client({connectionString:u.href,ssl,connectionTimeoutMillis:10000,query_timeout:15000});
const admin=connect(url);await admin.connect();
const globalHash=async()=>(await admin.query(`SELECT md5(json_build_object(
 'roles',(SELECT json_agg(r ORDER BY oid) FROM pg_authid r),
 'settings',(SELECT json_agg(r ORDER BY setdatabase,setrole) FROM pg_db_role_setting r),
 'memberships',(SELECT json_agg(r ORDER BY roleid,member,grantor) FROM pg_auth_members r),
 'databases',(SELECT json_agg(json_build_object('name',datname,'acl',datacl) ORDER BY datname) FROM pg_database))::text) AS hash`)).rows[0].hash;
const before=await globalHash(),password=randomUUID()+randomUUID();
const login='vayada_next_hotel_setup_logo_37f915790bff5732_072438f4e0a8',parent='vayada_next_hotel_setup_logo_scope';
const roles=['vayada_admin','vayada_target_prod_user',parent,login,'rdsadmin'];
assert.deepEqual((await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rows,[]);
assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname='vayada_target_prod'")).rows[0].n,0);
let setup,creator,databaseCreated=false,created=[];
try {
 await admin.query(`CREATE ROLE vayada_admin LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB PASSWORD '${password}'`);created.push(roles[0]);
 for(const role of roles.slice(1,3)){await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`);created.push(role);}
 await admin.query('CREATE ROLE rdsadmin SUPERUSER NOLOGIN');created.push('rdsadmin');
 await admin.query('CREATE DATABASE vayada_target_prod TEMPLATE template0');databaseCreated=true;
 const fixture=new URL(url);fixture.pathname='/vayada_target_prod';setup=connect(fixture);await setup.connect();
 const creatorUrl=new URL(fixture);creatorUrl.username='vayada_admin';creatorUrl.password=password;creator=connect(creatorUrl);await creator.connect();
 await assert.rejects(creator.query('SELECT oid FROM pg_catalog.pg_authid LIMIT 1'),{code:'42501'});
 await setup.query(`CREATE SCHEMA identity;CREATE SCHEMA hotel_catalog;CREATE SCHEMA platform;
  CREATE TABLE platform.hotel_setup_property_scopes(database_login name,property_id uuid,operation_class text,credential_role_oid oid);
  CREATE TABLE platform.schema_migrations(version text);
  GRANT USAGE ON SCHEMA identity,hotel_catalog,platform TO vayada_admin WITH GRANT OPTION;
  GRANT SELECT ON platform.hotel_setup_property_scopes,platform.schema_migrations TO vayada_admin;
  GRANT CONNECT ON DATABASE vayada_target_prod TO vayada_admin WITH GRANT OPTION;
  GRANT ${parent} TO vayada_admin,rdsadmin WITH ADMIN TRUE,INHERIT FALSE,SET FALSE`);
 for(const [table,grants]of Object.entries(inventory.HOTEL_SETUP_LOGO_PRIVILEGES)){
  const columns=[...new Set(Object.values(grants).flat())];
  await setup.query(`CREATE TABLE ${table}(${columns.map(c=>c+' text').join(',')});ALTER TABLE ${table} OWNER TO vayada_target_prod_user;GRANT ALL ON ${table} TO vayada_admin WITH GRANT OPTION`);
 }
 const catalogHash=async()=>(await setup.query(`SELECT md5(json_build_object(
  'relations',(SELECT json_agg(r ORDER BY oid) FROM pg_class r),'columns',(SELECT json_agg(r ORDER BY attrelid,attnum) FROM pg_attribute r),
  'schemas',(SELECT json_agg(r ORDER BY oid) FROM pg_namespace r),'functions',(SELECT json_agg(r ORDER BY oid) FROM pg_proc r),
  'scopes',(SELECT json_agg(r ORDER BY database_login) FROM platform.hotel_setup_property_scopes r),
  'ledger',(SELECT json_agg(r ORDER BY version) FROM platform.schema_migrations r))::text) AS hash`)).rows[0].hash;
 const snapshot=async()=>[await globalHash(),await catalogHash()];
 const context=vm.createContext({URL,process:{env:{},argv:[]},console:{log(){},error(){}}});
 const modules={'node:crypto':{createHash},'node:fs':{readFileSync:p=>readFileSync(p==='/app/apps/api/dist/hotelSetupLogoPrivileges.js'?inventoryPath:p)},'node:url':{pathToFileURL},pg:{default:pg}};
 const module=new vm.SourceTextModule(readFileSync(new URL('./recover-hotel-setup-logo-staged-role.mjs',import.meta.url),'utf8'),{context,identifier:'file:///fixture/recovery.mjs',initializeImportMeta(meta){meta.url='file:///fixture/recovery.mjs';},
  importModuleDynamically:async name=>{assert.equal(name,'/app/apps/api/dist/hotelSetupLogoPrivileges.js');const keys=['HOTEL_SETUP_LOGO_PRIVILEGES','HOTEL_SETUP_LOGO_RLS_HELPERS'];const m=new vm.SyntheticModule(keys,function(){for(const key of keys)this.setExport(key,inventory[key]);},{context});await m.link(()=>{});await m.evaluate();return m;}});
 await module.link(name=>{assert.ok(modules[name],name);return new vm.SyntheticModule(Object.keys(modules[name]),function(){for(const [key,value]of Object.entries(modules[name]))this.setExport(key,value);},{context});});await module.evaluate();
 const recover=module.namespace.recoverLogoStagedRole;
 let oid;
 // Fixture-only parent ADMIN lets stock PG record a grantor named rdsadmin; not an RDS parent-catalog assertion.
 const stage=async(grantor='rdsadmin')=>{
  await creator.query(`CREATE ROLE ${login} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await setup.query(`GRANT ${parent} TO ${login} WITH INHERIT TRUE,SET FALSE GRANTED BY ${grantor}`);
  await creator.query(`GRANT CONNECT ON DATABASE vayada_target_prod TO ${login};GRANT USAGE ON SCHEMA identity,hotel_catalog,platform TO ${login};GRANT DELETE ON hotel_catalog.property_media TO ${login}`);
  for(const [table,grants]of Object.entries(inventory.HOTEL_SETUP_LOGO_PRIVILEGES))for(const [privilege,columns]of Object.entries(grants))await creator.query(`GRANT ${privilege}(${columns.join(',')}) ON ${table} TO ${login}`);
  await setup.query(`REVOKE ${login} FROM vayada_admin`); // RDS zero-incoming catalog emulation only.
  oid=(await setup.query('SELECT oid FROM pg_roles WHERE rolname=$1',[login])).rows[0].oid;
 };
 let drops=0,commits=0;
 const run=async(phase,frozen,mode='native',expected=oid)=>{
  const emulate=['emulate','lost','readback'].includes(mode);let warned=false;
  const client=connect(emulate?fixture:creatorUrl);await client.connect();
  if(emulate)await client.query('SET SESSION AUTHORIZATION vayada_admin');
  const query=client.query.bind(client);
  client.query=async(sql,...args)=>{
   assert.ok(!/DROP OWNED|CASCADE/.test(sql),'Broad destructive SQL forbidden');
   if(sql.startsWith('DROP ROLE')){
    drops++;
    if(emulate)await query('RESET SESSION AUTHORIZATION');
    const value=await query(sql,...args);
    if(emulate)await query('SET SESSION AUTHORIZATION vayada_admin');
    return value;
   }
   const value=await query(sql,...args);
   if(mode.startsWith('warning')&&!warned&&sql.startsWith('REVOKE')){warned=true;client.emit('notice',{code:mode.slice(7)});}
   if(mode==='readback'&&commits===1&&sql.startsWith('SELECT count(*)::int AS n FROM pg_catalog.pg_roles'))throw Object.assign(Error('Synthetic post-commit readback failure'),{code:'XX000'});
   if(sql==='COMMIT'){commits++;if(mode==='lost')throw Error('Synthetic lost COMMIT acknowledgement');}
   return value;
  };
  try{return JSON.parse(JSON.stringify(await recover(client,phase,frozen,expected)));}finally{await client.end();}
 };
 await stage('postgres');const wrongBefore=await snapshot(),wrongProvider=await run('inspect');assert.equal(wrongProvider.status,'FAIL');assert.equal(wrongProvider.stage,'capture');assert.deepEqual(await snapshot(),wrongBefore);
 await setup.query(`REVOKE ${parent} FROM ${login} GRANTED BY postgres;GRANT ${parent} TO ${login} WITH INHERIT TRUE,SET FALSE GRANTED BY rdsadmin`);
 const safe=await snapshot(),plan=await run('inspect');assert.match(plan.fingerprint,/^[a-f0-9]{64}$/);
 const receipt=(phase,fingerprint)=>({status:phase==='inspect'?'PLAN':'PASS',scope:'hotel_setup_logo_staged_recovery',phase,login,roleOid:oid,fingerprint,roleRemoved:phase==='apply',businessWrites:false});
 assert.deepEqual(plan,receipt('inspect',plan.fingerprint));assert.deepEqual(await snapshot(),safe);
 const rejected=async()=>{const before=await snapshot(),result=await run('inspect');assert.equal(result.status,'FAIL');assert.equal(result.stage,'capture');assert.deepEqual(await snapshot(),before);};
 assert.equal((await run('inspect',undefined,'native',oid+1)).status,'FAIL');assert.deepEqual(await snapshot(),safe);
 for(const [change,undo]of [
  ['ALTER ROLE rdsadmin NOSUPERUSER','ALTER ROLE rdsadmin SUPERUSER'],
  [`ALTER ROLE ${login} LOGIN`,`ALTER ROLE ${login} NOLOGIN`],
  [`ALTER ROLE ${login} SET search_path TO public`,`ALTER ROLE ${login} RESET search_path`],
  [`GRANT ${login} TO vayada_target_prod_user`,`REVOKE ${login} FROM vayada_target_prod_user`],
  [`GRANT SELECT ON hotel_catalog.properties TO ${login}`,`REVOKE SELECT ON hotel_catalog.properties FROM ${login}`],
  [`CREATE TABLE platform.unexpected_owned(id int);ALTER TABLE platform.unexpected_owned OWNER TO ${login}`,'DROP TABLE platform.unexpected_owned'],
  [`INSERT INTO platform.hotel_setup_property_scopes VALUES('${login}','f4b1d762-7592-4182-b103-20b53014c171','property_logo',NULL)`,'DELETE FROM platform.hotel_setup_property_scopes'],
  [`INSERT INTO platform.hotel_setup_property_scopes VALUES('unrelated_fixture_login','00000000-0000-0000-0000-000000000001','launch_settings',${oid})`,'DELETE FROM platform.hotel_setup_property_scopes'],
 ]){await setup.query(change);await rejected();await setup.query(undo);}
 await setup.query(`ALTER ROLE ${login} LOGIN PASSWORD '${password}'`);
 const activeUrl=new URL(fixture);activeUrl.username=login;activeUrl.password=password;
 const active=connect(activeUrl);await active.connect();
 try{await setup.query(`ALTER ROLE ${login} NOLOGIN`);await rejected();}
 finally{await active.end();await setup.query(`ALTER ROLE ${login} PASSWORD NULL`);}
 const drift=await run('apply','0'.repeat(64));assert.equal(drift.status,'FAIL');assert.equal(drift.stage,'fingerprint');assert.equal(drops,0);assert.deepEqual(await snapshot(),safe);
 for(const code of ['01006','01007']){const warning=await run('apply',plan.fingerprint,'warning'+code);assert.equal(warning.status,'FAIL');assert.equal(warning.stage,'revoke');assert.equal(drops,0);assert.equal(commits,0);assert.deepEqual(await snapshot(),safe);}
 const denied=await run('apply',plan.fingerprint);assert.equal(denied.status,'FAIL');assert.equal(denied.stage,'drop');assert.equal(denied.sqlState,'42501');assert.equal(drops,1);assert.equal(commits,0);assert.deepEqual(await snapshot(),safe,'Real NS DROP denial must roll back every ACL revoke and retain the exact provider edge');
 drops=commits=0;const applied=await run('apply',plan.fingerprint,'emulate');assert.deepEqual(applied,receipt('apply',plan.fingerprint));assert.equal(drops,1);assert.equal(commits,1);assert.equal((await setup.query('SELECT oid FROM pg_roles WHERE rolname=$1',[login])).rowCount,0);assert.equal((await setup.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid OR grantor=$1::oid',[oid])).rows[0].n,0,'Plain DROP must remove the retained exact provider membership');assert.equal((await run('inspect')).status,'FAIL');
 await stage();const second=await run('inspect');drops=commits=0;const lost=await run('apply',second.fingerprint,'lost');assert.equal(lost.status,'UNCERTAIN');assert.equal(lost.stage,'commit');assert.equal(lost.sqlState,null);assert.equal(drops,1);assert.equal(commits,1);assert.equal((await setup.query('SELECT oid FROM pg_roles WHERE rolname=$1',[login])).rowCount,0,'Lost acknowledgement must never retry or recreate');assert.equal((await run('inspect')).status,'FAIL');
 await stage();const third=await run('inspect');drops=commits=0;const readback=await run('apply',third.fingerprint,'readback');assert.equal(readback.status,'COMMITTED_UNVERIFIED');assert.equal(readback.stage,'verify');assert.equal(readback.sqlState,'XX000');assert.equal(drops,1);assert.equal(commits,1);assert.equal((await run('inspect')).status,'FAIL');
} finally {
 await creator?.end();await setup?.end();
 if(databaseCreated)await admin.query('DROP DATABASE vayada_target_prod WITH (FORCE)');
 if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[login])).rowCount)await admin.query(`DROP ROLE ${login}`);
 for(const role of created.reverse())await admin.query(`DROP ROLE ${role}`);
 assert.equal(await globalHash(),before,'Exact fixture global cleanup');await admin.end();
}
console.log('PASS: NS catalog denial, zero-incoming catalog guards, fingerprint drift, real NS DROP denial rollback, exact provider membership retained through ACL revokes and removed by plain DROP, fixture-SU final-DROP authority emulation only, lost COMMIT no retry, exact cleanup; not RDS DROP authority proof');
