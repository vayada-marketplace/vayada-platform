import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const roles=['vayada_next_hotel_setup_scope','vayada_next_hotel_setup_property_scope'];
const functions=[
  ['platform.tenant_scope_key(text,uuid,uuid)','b975b52125e7946a2735008e510b0cca','a74c4ffd81f721267c22bdec5e907a1b'],
  ['platform.valid_tenant_scope(text,uuid,uuid)','db09c1fcfb5609b6b59964f2bba7f537','a203c5d9db7f62b1c66bc1719ba436e0'],
];
const require=value=>{if(!value)throw new Error('hotel_setup_tenant_helpers_unavailable');};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function capture(client,principal){
  const identity=(await client.query(`SELECT current_user,session_user,current_database(),pg_is_in_recovery() AS replica`)).rows[0];
  require(identity?.current_user===principal&&identity.session_user===principal&&identity.current_database==='vayada_target_prod'&&identity.replica===false);
  const parents=(await client.query(`SELECT to_jsonb(r) AS role FROM pg_roles r WHERE rolname=ANY($1::text[]) ORDER BY rolname`,[roles])).rows.map(r=>({...r.role,oid:Number(r.role.oid)}));
  require(parents.length===2&&parents.every(r=>Number.isInteger(r.oid)&&r.oid>0&&!r.rolcanlogin&&!r.rolinherit&&!r.rolsuper&&!r.rolcreaterole&&!r.rolcreatedb&&!r.rolreplication&&!r.rolbypassrls&&r.rolconfig===null&&r.rolvaliduntil===null));
  const helpers=(await client.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,p.proowner,
    to_jsonb(p)-'proacl' AS metadata,md5(p.prosrc) AS body,md5(pg_get_functiondef(p.oid)) AS definition,
    has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') AS can_grant
    FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY p.oid::regprocedure::text`,[functions.map(f=>f[0])])).rows;
  require(helpers.length===2);
  for(const fn of helpers){
    const expected=functions.find(f=>f[0]===fn.signature);
    require(expected&&fn.body===expected[1]&&fn.definition===expected[2]&&fn.can_grant&&
      !fn.metadata.prosecdef&&fn.metadata.provolatile==='i'&&fn.proowner===(await client.query('SELECT oid FROM pg_roles WHERE rolname=$1',[principal])).rows[0]?.oid);
    // Do not emit function source or arbitrary catalog text in operational receipts.
    delete fn.metadata.prosrc;
    fn.acl=(await client.query(`SELECT grantor,grantee,privilege_type,is_grantable FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=$1 ORDER BY grantor,grantee,privilege_type,is_grantable`,[fn.oid])).rows;
    require(!fn.acl.some(e=>parents.some(r=>r.oid===e.grantee)&&e.is_grantable));
  }
  return {identity,parents,helpers};
}
export async function repairTenantHelpers(client,mode,frozen,principal='vayada_target_prod_user'){
  require(['inspect','apply'].includes(mode)&&(mode==='inspect'?frozen===undefined:/^[a-f0-9]{64}$/.test(frozen??'')));
  require((await client.query('SELECT pg_try_advisory_lock(8734516) AS held')).rows[0]?.held===true);
  let committed=false,commitAttempted=false,stage='capture';
  try{
    await client.query(mode==='inspect'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
    const before=await capture(client,principal), hash=fingerprint(before);
    const missing=before.helpers.flatMap(fn=>before.parents.filter(r=>!fn.acl.some(e=>e.grantee===r.oid&&e.privilege_type==='EXECUTE')).map(r=>({signature:fn.signature,role:r.rolname,oid:r.oid})));
    if(mode==='apply'){
      stage='freeze';require(frozen===hash);
      stage='grant';
      for(const edge of missing)await client.query(`GRANT EXECUTE ON FUNCTION ${edge.signature} TO ${edge.role}`);
      stage='readback';const after=await capture(client,principal);
      require(same(before.identity,after.identity)&&same(before.parents,after.parents));
      for(const old of before.helpers){
        const next=after.helpers.find(fn=>fn.oid===old.oid);
        require(same({...old,acl:[]},{...next,acl:[]}));
        const added=next.acl.filter(e=>!old.acl.some(prior=>same(prior,e))),expected=missing.filter(e=>e.signature===old.signature);
        require(old.acl.every(e=>next.acl.some(prior=>same(prior,e)))&&added.length===expected.length&&
          added.every(e=>expected.some(x=>x.oid===e.grantee)&&e.grantor===old.proowner&&e.privilege_type==='EXECUTE'&&!e.is_grantable));
      }
      stage='commit';commitAttempted=true;await client.query('COMMIT');committed=true;
      stage='verify';
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      require(same(after,await capture(client,principal)));await client.query('ROLLBACK');
    }else await client.query('ROLLBACK');
    return {status:'PASS',scope:'hotel_setup_tenant_helpers',mode,fingerprint:hash,addedEdges:mode==='apply'?missing.length:0,missingEdges:mode==='apply'?0:missing.length,businessWrites:false,publicGrants:false};
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    return {status:committed?'COMMITTED_UNVERIFIED':commitAttempted?'UNCERTAIN':'FAIL',scope:'hotel_setup_tenant_helpers',mode,businessWrites:false,stage,sqlState:/^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:null};
  }finally{await client.query('SELECT pg_advisory_unlock(8734516)').catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let client,failed=false;
  try{
    const url=new URL(process.env.TARGET_DATABASE_MIGRATION_URL??'');
    require(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REF==='refs/heads/main'&&
      url.protocol==='postgresql:'&&url.hostname==='vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com'&&url.port==='5432'&&
      url.username==='vayada_target_prod_user'&&url.pathname==='/vayada_target_prod'&&url.password&&!url.hash&&url.search==='?sslmode=require'&&process.env.VAYADA_DB_RDS_CA_BUNDLE);
    const {default:pg}=await import('pg');
    client=new pg.Client({host:url.hostname,port:5432,database:'vayada_target_prod',user:'vayada_target_prod_user',password:decodeURIComponent(url.password),
      ssl:{ca:process.env.VAYADA_DB_RDS_CA_BUNDLE,rejectUnauthorized:true,servername:url.hostname},connectionTimeoutMillis:10000,query_timeout:15000});
    client.on('error',()=>{failed=true;});client.on('notice',n=>{if(n.code==='01007')failed=true;});
    await client.connect();
    let result=await repairTenantHelpers(client,process.env.HOTEL_SETUP_LEGACY_HELPER_MODE,process.env.HOTEL_SETUP_LEGACY_HELPER_FROZEN);
    if(failed&&result.status==='PASS')result={status:result.mode==='apply'?'COMMITTED_UNVERIFIED':'FAIL',scope:'hotel_setup_tenant_helpers',mode:result.mode,businessWrites:false};
    console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=2;
  }catch{console.error(JSON.stringify({status:'FAIL',scope:'hotel_setup_tenant_helpers',code:'hotel_setup_tenant_helpers_unavailable'}));process.exitCode=1;}
  finally{await client?.end().catch(()=>{});}
}
