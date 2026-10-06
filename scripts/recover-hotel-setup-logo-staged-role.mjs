import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const login='vayada_next_hotel_setup_logo_37f915790bff5732_072438f4e0a8';
const prefix='vayada_next_hotel_setup_logo_37f915790bff5732_';
const property='f4b1d762-7592-4182-b103-20b53014c171';
const parent='vayada_next_hotel_setup_logo_scope';
const scope='hotel_setup_logo_staged_recovery';
const inventoryPath='/app/apps/api/dist/hotelSetupLogoPrivileges.js';
const inventoryHash='65944cbb9cbed464fdd91b3052ce40c5422a09dc8bf3a98376d2340f74c91c22';
const require=value=>{if(!value)throw new Error('hotel_setup_logo_staged_recovery_unavailable');};
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const safeRole=r=>r&&!r.rolcanlogin&&!r.rolinherit&&!r.rolsuper&&!r.rolcreaterole&&!r.rolcreatedb&&
  !r.rolreplication&&!r.rolbypassrls&&r.rolconnlimit===-1&&r.rolconfig===null&&r.rolvaliduntil===null;

// Only the local native fixture overrides the OID; production always uses the inspected 247978.
export async function recoverLogoStagedRole(client,phase,frozen,expectedRoleOid=247978){
  let failed=false,locked=false,commitAttempted=false,committed=false,stage='configuration';
  const onError=()=>{failed=true;},onNotice=n=>{if(['01007','01006'].includes(n.code))failed=true;};
  client.on('error',onError);client.on('notice',onNotice);
  const query=async(...args)=>{require(!failed);const result=await client.query(...args);require(!failed);return result;};
  try{
    require(['inspect','apply'].includes(phase)&&(phase==='inspect'?frozen===undefined:/^[a-f0-9]{64}$/.test(frozen??'')));
    require(Number.isInteger(expectedRoleOid)&&expectedRoleOid>0&&expectedRoleOid<=4294967295);
    require(hash(readFileSync(inventoryPath))===inventoryHash);
    const {HOTEL_SETUP_LOGO_PRIVILEGES:inventory}=await import(inventoryPath);
    const schemas=[...new Set(Object.keys(inventory).map(table=>table.split('.')[0]))].sort();
    const expected=Object.entries(inventory).flatMap(([table,privileges])=>Object.entries(privileges)
      .flatMap(([privilege,columns])=>columns.map(column=>['column',table,column,privilege])));
    expected.push(['relation','hotel_catalog.property_media','','DELETE'],['database','vayada_target_prod','','CONNECT'],
      ...schemas.map(schema=>['schema',schema,'','USAGE']));
    const allowed=new Set(expected.map(JSON.stringify)),limit=expected.length+1;
    const emptyCounts=async()=>{
      const row=(await query(`SELECT
        (SELECT count(*)::int FROM pg_catalog.pg_db_role_setting WHERE setrole=$1::oid) AS settings,
        (SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE usesysid=$1::oid) AS backends,
        (SELECT count(*)::int FROM platform.hotel_setup_property_scopes WHERE database_login=$2
          OR credential_role_oid=$1::oid OR pg_catalog.left(database_login::text,length($3))=$3
          OR (property_id=$4::uuid AND operation_class='property_logo')) AS assignments,
        (SELECT count(*)::int FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=$1::oid OR EXISTS
          (SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=$1::oid OR a.grantor=$1::oid)) AS defaults`,
        [expectedRoleOid,login,prefix,property])).rows[0];
      require(row&&Object.values(row).every(n=>n===0));return row;
    };
    const capture=async(cleared=false)=>{
      const identity=(await query(`SELECT current_user,session_user,current_database(),pg_catalog.pg_is_in_recovery() AS replica,
        r.oid,r.rolsuper,r.rolcanlogin,r.rolcreaterole,(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid
        FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)).rows[0];
      require(identity?.current_user==='vayada_admin'&&identity.session_user==='vayada_admin'&&identity.current_database==='vayada_target_prod'&&
        identity.replica===false&&identity.rolsuper===false&&identity.rolcanlogin===true&&identity.rolcreaterole===true);
      const roles=(await query(`SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,
        rolconnlimit,rolconfig,rolvaliduntil FROM pg_catalog.pg_roles WHERE pg_catalog.left(rolname::text,length($1))=$1 OR rolname=$2 ORDER BY rolname LIMIT 3`,[prefix,parent])).rows;
      const role=roles.find(r=>r.rolname===login),scopeRole=roles.find(r=>r.rolname===parent);
      require(roles.length===2&&role?.oid===expectedRoleOid&&safeRole(role)&&safeRole(scopeRole));
      const edges=(await query(`SELECT e.roleid,e.member,e.grantor,e.admin_option,e.inherit_option,e.set_option,
        g.rolname AS grantor_name,g.rolsuper AS grantor_superuser FROM pg_catalog.pg_auth_members e JOIN pg_catalog.pg_roles g ON g.oid=e.grantor
        WHERE e.roleid=$1::oid OR e.member=$1::oid OR e.grantor=$1::oid ORDER BY e.roleid,e.member,e.grantor LIMIT 3`,[expectedRoleOid])).rows;
      require(edges.length===1&&edges[0].roleid===scopeRole.oid&&edges[0].member===expectedRoleOid&&
        edges[0].grantor_name==='rdsadmin'&&edges[0].grantor_superuser===true&&
        !edges[0].admin_option&&edges[0].inherit_option&&!edges[0].set_option);
      const counts=await emptyCounts();
      const acl=(await query(`SELECT * FROM (
        SELECT 'column' AS kind,n.nspname||'.'||c.relname AS object,a.attname::text AS column_name,
          'pg_catalog.pg_class'::regclass::oid AS classid,c.oid AS objid,a.attnum::int AS objsubid,c.relowner AS owner,p.*
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,'','pg_catalog.pg_class'::regclass::oid,c.oid,0,c.relowner,p.*
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        UNION ALL SELECT 'schema',n.nspname::text,'','pg_catalog.pg_namespace'::regclass::oid,n.oid,0,n.nspowner,p.*
          FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        UNION ALL SELECT 'database',d.datname::text,'','pg_catalog.pg_database'::regclass::oid,d.oid,0,d.datdba,p.*
          FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        ) entries ORDER BY classid,objid,objsubid,privilege_type,grantor LIMIT $2`,[expectedRoleOid,limit])).rows;
      require(acl.length===(cleared?0:expected.length)&&new Set(acl.map(a=>JSON.stringify([a.kind,a.object,a.column_name,a.privilege_type]))).size===acl.length);
      require(acl.every(a=>a.grantee===expectedRoleOid&&!a.is_grantable&&(a.grantor===a.owner||a.grantor===identity.oid)&&
        allowed.has(JSON.stringify([a.kind,a.object,a.column_name,a.privilege_type]))));
      const dependencies=(await query(`SELECT dbid,classid,objid,objsubid,deptype FROM pg_catalog.pg_shdepend
        WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=$1::oid
        ORDER BY dbid,classid,objid,objsubid,deptype LIMIT $2`,[expectedRoleOid,limit])).rows;
      require(dependencies.length<limit&&dependencies.every(d=>d.deptype==='a'&&(d.dbid===0||d.dbid===identity.database_oid)&&
        acl.some(a=>a.classid===d.classid&&a.objid===d.objid&&a.objsubid===d.objsubid)));
      return {identity,role,scopeRole,edges,counts,acl,dependencies};
    };
    stage='lock';require((await query('SELECT pg_catalog.pg_try_advisory_lock(8734516) AS held')).rows[0]?.held===true);locked=true;
    await query(phase==='inspect'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    await query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
    stage='capture';const before=await capture(),fingerprint=hash(JSON.stringify({inventoryHash,...before}));
    if(phase==='apply'){
      stage='fingerprint';require(frozen===fingerprint);
      stage='revoke';
      for(const [table,privileges] of Object.entries(inventory))for(const [privilege,columns] of Object.entries(privileges))
        await query(`REVOKE ${privilege}(${columns.join(',')}) ON ${table} FROM ${login}`);
      await query(`REVOKE DELETE ON hotel_catalog.property_media FROM ${login}`);
      await query(`REVOKE USAGE ON SCHEMA ${schemas.join(',')} FROM ${login}`);
      await query(`REVOKE CONNECT ON DATABASE vayada_target_prod FROM ${login}`);
      stage='readback';const after=await capture(true);
      require(same(before.identity,after.identity)&&same(before.role,after.role)&&same(before.scopeRole,after.scopeRole)&&same(before.edges,after.edges));
      stage='drop';await query(`DROP ROLE ${login}`);
      stage='commit';commitAttempted=true;await query('COMMIT');committed=true;
      stage='verify';await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      require((await query('SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE oid=$1::oid OR pg_catalog.left(rolname::text,length($2))=$2',[expectedRoleOid,prefix])).rows[0]?.n===0);
      await emptyCounts();await query('ROLLBACK');
    }else await query('ROLLBACK');
    return {status:phase==='inspect'?'PLAN':'PASS',scope,phase,login,roleOid:expectedRoleOid,fingerprint,roleRemoved:phase==='apply',businessWrites:false};
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    return {status:committed?'COMMITTED_UNVERIFIED':commitAttempted?'UNCERTAIN':'FAIL',scope,phase,
      code:'hotel_setup_logo_staged_recovery_unavailable',stage,sqlState:/^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:null};
  }finally{
    if(locked)await client.query('SELECT pg_catalog.pg_advisory_unlock(8734516)').catch(()=>{});
    client.removeListener('error',onError);client.removeListener('notice',onNotice);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let client;
  try{
    const url=new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL??'');
    require(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REF==='refs/heads/main'&&url.protocol==='postgresql:'&&
      url.hostname==='vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com'&&url.port==='5432'&&url.username==='vayada_admin'&&
      url.pathname==='/postgres'&&url.password&&!url.hash&&url.search==='?sslmode=require'&&process.env.VAYADA_DB_RDS_CA_BUNDLE);
    const {default:pg}=await import('pg');
    client=new pg.Client({host:url.hostname,port:5432,database:'vayada_target_prod',user:'vayada_admin',password:decodeURIComponent(url.password),
      ssl:{ca:process.env.VAYADA_DB_RDS_CA_BUNDLE,rejectUnauthorized:true,servername:url.hostname},connectionTimeoutMillis:10000,query_timeout:15000});
    client.on('error',()=>{}); // Never expose an unhandled connection diagnostic outside the guarded operation.
    await client.connect();
    const result=await recoverLogoStagedRole(client,process.env.HOTEL_SETUP_LOGO_RECOVERY_PHASE,process.env.HOTEL_SETUP_LOGO_RECOVERY_FROZEN||undefined);
    console.log(JSON.stringify(result));if(!['PLAN','PASS'].includes(result.status))process.exitCode=2;
  }catch{console.error(JSON.stringify({status:'FAIL',scope,code:'hotel_setup_logo_staged_recovery_unavailable'}));process.exitCode=1;}
  finally{await client?.end().catch(()=>{});}
}
