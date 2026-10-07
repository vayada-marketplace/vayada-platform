import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const login='vayada_next_hotel_setup_reader',scope='hotel_setup_logo_reader_cutover';
const paths={privileges:'/app/apps/api/dist/hotelSetupReaderPrivileges.js',
  config:'/app/apps/api/dist/hotelSetupCommandServiceConfig.js',preflight:'/app/apps/api/dist/cli/hotelSetupReaderPreflight.js'};
const hashes={privileges:'73ff08cf4ce995bf01224eb35592ca8f5dcc7f7b7da29c34a987ae2217da7d26',
  config:'40e57d36d3fcb85676dac0fd9cf42e4dc30c8aa43a93225d0668bf03c3e9fd2b',
  preflight:'3a898a0d589250ef0741530d852232a8b9ff7f686ae8a79502ce821d565dbb1c'};
const additions={'platform.hotel_setup_property_scopes':['actor_user_id'],
  'platform.media_upload_sessions':['id','actor_user_id','owner_organization_id','requested_purpose','property_id','resource_product','resource_type','resource_id']};
const allowedMissing=new Set(Object.entries(additions).flatMap(([table,columns])=>columns.map(column=>`${table}:${column}:SELECT`)));
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const require=value=>{if(!value)throw new Error('hotel_setup_logo_reader_cutover_unavailable');};
const failure=(error,phase,stage,status='FAIL')=>({status,scope,phase,code:'hotel_setup_logo_reader_cutover_unavailable',stage,
  sqlState:/^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:null});
async function modules(){
  for(const [key,path]of Object.entries(paths))require(hash(readFileSync(path))===hashes[key]);
  return {p:await import(paths.privileges),c:await import(paths.config),f:await import(paths.preflight)};
}
const inventoryFor=p=>Object.fromEntries(Object.entries(p.HOTEL_SETUP_READER_READ_COLUMNS).map(([table,SELECT])=>[table,
  {SELECT:[...SELECT],...(table==='platform.product_audit_events'?{INSERT:[...p.HOTEL_SETUP_READER_AUDIT_COLUMNS]}:{})}]));

// Catalog checks use the fixed reader as has_*_privilege subject; no SET ROLE or membership grant.
export async function runLogoReaderCutover(client,phase,frozen){
  let stage='configuration',locked=false,invalid=false,commitAttempted=false,committed=false;
  const onError=()=>{invalid=true;},onNotice=n=>{if(['01006','01007'].includes(n.code))invalid=true;};
  client.on('error',onError);client.on('notice',onNotice);
  const query=async(...args)=>{require(!invalid);const result=await client.query(...args);require(!invalid);return result;};
  try{
    require(['inspect','apply'].includes(phase)&&(phase==='inspect'?frozen===undefined:/^[a-f0-9]{64}$/.test(frozen??'')));
    const {p,f}=await modules(),inventory=inventoryFor(p);
    const expected=Object.entries(inventory).flatMap(([table,grants])=>Object.entries(grants).flatMap(([privilege,columns])=>columns.map(column=>({table,column,privilege}))));
    require([...allowedMissing].every(key=>expected.some(e=>`${e.table}:${e.column}:${e.privilege}`===key)));
    const asReader={query:(sql,values)=>{
      require(/^\s*SELECT\b/.test(sql));sql=sql.replace(/\bcurrent_user\b/g,`'${login}'::name`);
      // A constant catalog subject changes planner ordering; sequence checks require sequence OIDs.
      const sequence=`pg_catalog.has_sequence_privilege('${login}'::name,c.oid,'USAGE,SELECT,UPDATE')`;
      return query(sql.replace(sequence,`(CASE WHEN c.relkind='S' THEN ${sequence} ELSE false END)`),values);
    }};
    const capture=async()=>{
      stage='identity';const identity=(await query(`SELECT current_user,session_user,current_database(),pg_is_in_recovery() AS replica,
        r.oid,r.rolsuper,r.rolcanlogin FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
      require(identity?.current_user==='vayada_admin'&&identity.session_user==='vayada_admin'&&identity.current_database==='vayada_target_prod'&&
        identity.replica===false&&identity.rolsuper===false&&identity.rolcanlogin===true);
      stage='role_posture';const roles=(await query(`SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,
        rolreplication,rolbypassrls,rolconnlimit,rolconfig,rolvaliduntil::text FROM pg_roles WHERE rolname=$1`,[login])).rows;
      const role=roles[0];require(roles.length===1&&role.rolcanlogin&&!role.rolinherit&&!role.rolsuper&&!role.rolcreaterole&&!role.rolcreatedb&&
        !role.rolreplication&&!role.rolbypassrls&&role.rolconnlimit===-1&&role.rolconfig===null&&role.rolvaliduntil===null);
      const memberships=(await query(`SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members
        WHERE roleid=$1::oid OR member=$1::oid OR grantor=$1::oid ORDER BY roleid,member,grantor LIMIT 3`,[role.oid])).rows;
      require(memberships.length<=1&&memberships.every(e=>e.roleid===role.oid&&e.member===identity.oid&&e.admin_option&&!e.inherit_option&&!e.set_option));
      const counts=(await query(`SELECT
        (SELECT count(*)::int FROM pg_db_role_setting WHERE setrole=$1::oid) AS settings,
        (SELECT count(*)::int FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1::oid AND deptype='o') AS owned,
        (SELECT count(*)::int FROM pg_default_acl d WHERE d.defaclrole=$1::oid OR EXISTS
          (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee=$1::oid OR a.grantor=$1::oid)) AS defaults,
        (has_table_privilege($1::oid,'pg_authid','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege($1::oid,'pg_authid','SELECT,INSERT,UPDATE,REFERENCES')) AS authid,
        (has_table_privilege($1::oid,'pg_shadow','SELECT') OR has_any_column_privilege($1::oid,'pg_shadow','SELECT')) AS shadow`,[role.oid])).rows[0];
      require(counts&&counts.settings===0&&counts.owned===0&&counts.defaults===0&&!counts.authid&&!counts.shadow);
      stage='readiness_schema';await p.assertHotelSetupCredentialReadinessSchema(asReader);
      stage='rls_helpers';await p.assertHotelSetupReaderRlsHelpers(asReader);
      stage='audit_boundary';await p.assertHotelSetupAuditBoundary(asReader);
      stage='database_isolation';await f.assertHotelSetupDatabaseIsolation(asReader);
      stage='columns';const columns=(await query(`SELECT e.table,e.column,e.privilege,c.oid,a.attnum,
        has_column_privilege($2::oid,c.oid,a.attnum,e.privilege) AS allowed,
        has_column_privilege(current_user,c.oid,a.attnum,e.privilege||' WITH GRANT OPTION') AS can_grant
        FROM jsonb_to_recordset($1::jsonb) e("table" text,"column" text,privilege text)
        LEFT JOIN pg_class c ON c.oid=to_regclass(e.table)
        LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY e.table,e.column,e.privilege`,[JSON.stringify(expected),role.oid])).rows;
      require(columns.length===expected.length&&columns.every(e=>e.oid&&e.attnum));
      const missing=columns.filter(e=>!e.allowed).map(e=>`${e.table}:${e.column}:${e.privilege}`);
      require(missing.every(key=>allowedMissing.has(key))&&columns.filter(e=>!e.allowed).every(e=>e.can_grant===true));
      const present=inventoryFor(p);for(const [table,grants]of Object.entries(present))for(const [privilege,names]of Object.entries(grants))
        grants[privilege]=names.filter(column=>!missing.includes(`${table}:${column}:${privilege}`));
      stage='column_privileges';await p.assertHotelSetupColumnPrivileges(asReader,present);
      stage='direct_acl';const acl=(await query(`SELECT * FROM (
        SELECT 'column' AS kind,n.nspname||'.'||c.relname AS object,a.attname::text AS column_name,c.oid AS object_oid,c.relowner AS owner,p.*
          FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL aclexplode(a.attacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,'',c.oid,c.relowner,p.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        UNION ALL SELECT 'schema',n.nspname::text,'',n.oid,n.nspowner,p.* FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        UNION ALL SELECT 'database',d.datname::text,'',d.oid,d.datdba,p.* FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        UNION ALL SELECT 'function',f.oid::regprocedure::text,'',f.oid,f.proowner,p.* FROM pg_proc f CROSS JOIN LATERAL aclexplode(f.proacl) p WHERE p.grantee=$1::oid OR p.grantor=$1::oid
        ) entries ORDER BY kind,object,column_name,privilege_type,grantor LIMIT $2`,[role.oid,expected.length+10])).rows;
      require(acl.length<expected.length+10&&acl.every(a=>a.grantee===role.oid&&!a.is_grantable&&(
        (a.kind==='column'&&expected.some(e=>e.table===a.object&&e.column===a.column_name&&e.privilege===a.privilege_type))||
        (a.kind==='schema'&&['identity','platform'].includes(a.object)&&a.privilege_type==='USAGE')||
        (a.kind==='database'&&a.object==='vayada_target_prod'&&a.privilege_type==='CONNECT')||
        (a.kind==='function'&&p.HOTEL_SETUP_READER_RLS_HELPERS.includes(a.object)&&a.privilege_type==='EXECUTE'))));
      return {identity,role,memberships,counts,columns,acl,missing};
    };
    stage='lock';require((await query('SELECT pg_try_advisory_lock(8734516) AS held')).rows[0]?.held===true);locked=true;
    await query(phase==='inspect'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    await query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
    const before=await capture(),fingerprint=hash(JSON.stringify({hashes,...before}));
    if(phase==='apply'){
      stage='fingerprint';require(frozen===fingerprint);
      stage='grant';for(const [table,names]of Object.entries(additions)){
        const missing=names.filter(column=>before.missing.includes(`${table}:${column}:SELECT`));
        if(missing.length)await query(`GRANT SELECT (${missing.join(',')}) ON ${table} TO ${login}`);
      }
      const after=await capture();stage='readback';require(after.missing.length===0);
      for(const key of ['identity','role','memberships','counts'])require(same(before[key],after[key]));
      require(same(before.columns.map(e=>({...e,allowed:true})),after.columns));
      require(before.acl.every(edge=>after.acl.some(next=>same(edge,next))));
      const added=after.acl.filter(edge=>!before.acl.some(prior=>same(edge,prior)));
      require(added.length===before.missing.length&&added.every(e=>e.kind==='column'&&before.missing.includes(`${e.object}:${e.column_name}:${e.privilege_type}`)&&
        [e.owner,before.identity.oid].includes(e.grantor)));
      stage='commit';commitAttempted=true;await query('COMMIT');committed=true;
      await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const verified=await capture();stage='verify';require(same(after,verified));await query('ROLLBACK');
    }else await query('ROLLBACK');
    return {status:phase==='inspect'?'PLAN':'PASS',scope,phase,login,roleOid:before.role.oid,fingerprint,missingColumns:before.missing,businessWrites:false};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});return failure(error,phase,stage,committed?'COMMITTED_UNVERIFIED':commitAttempted?'UNCERTAIN':'FAIL');}
  finally{if(locked)await client.query('SELECT pg_advisory_unlock(8734516)').catch(()=>{});client.removeListener('error',onError);client.removeListener('notice',onNotice);}
}

// This proof authenticates as the literal native reader and runs the original deployed checks.
export async function verifyLogoReader(client,expectedRoleOid){
  let stage='configuration',invalid=false;const onError=()=>{invalid=true;};client.on('error',onError);
  try{
    require(Number.isInteger(expectedRoleOid)&&expectedRoleOid>0&&expectedRoleOid<=4294967295);
    const {p,c,f}=await modules();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    stage='identity';const role=(await client.query('SELECT oid FROM pg_roles WHERE rolname=session_user AND session_user=current_user AND rolname=$1',[login])).rows[0];require(role?.oid===expectedRoleOid);
    stage='role_posture';await c.assertHotelSetupServiceReader(client,'property_commands');
    stage='readiness_schema';await p.assertHotelSetupCredentialReadinessSchema(client);
    stage='rls_helpers';await p.assertHotelSetupReaderRlsHelpers(client);
    stage='audit_boundary';await p.assertHotelSetupAuditBoundary(client);
    stage='database_isolation';await f.assertHotelSetupDatabaseIsolation(client);
    stage='column_privileges';await p.assertHotelSetupColumnPrivileges(client,inventoryFor(p));
    await client.query('ROLLBACK');require(!invalid);
    return {status:'PASS',scope,phase:'verify',login,roleOid:role.oid,businessWrites:false};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});return failure(error,'verify',stage);}
  finally{client.removeListener('error',onError);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let client,stage='configuration';const phase=process.env.HOTEL_SETUP_LOGO_READER_PHASE;
  try{
    const native=phase==='verify',url=new URL(process.env[native?'HOTEL_SETUP_COMMAND_READER_DATABASE_URL':'HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL']??'');
    require(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REF==='refs/heads/main'&&url.protocol==='postgresql:'&&
      url.hostname==='vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com'&&url.port==='5432'&&url.username===(native?login:'vayada_admin')&&
      url.pathname===(native?'/vayada_target_prod':'/postgres')&&url.password&&(!native||Buffer.byteLength(decodeURIComponent(url.password))>=32)&&
      !url.hash&&url.search===(native?'?sslmode=verify-full':'?sslmode=require')&&process.env.VAYADA_DB_RDS_CA_BUNDLE);
    const {default:pg}=await import('pg');client=new pg.Client({host:url.hostname,port:5432,database:'vayada_target_prod',user:url.username,password:decodeURIComponent(url.password),
      ssl:{ca:process.env.VAYADA_DB_RDS_CA_BUNDLE,rejectUnauthorized:true,servername:url.hostname},connectionTimeoutMillis:10000,query_timeout:15000,
      options:'-c search_path=pg_catalog'+(phase==='apply'?'':' -c default_transaction_read_only=on')});
    client.on('error',()=>{});stage='connect';await client.connect();
    const result=native?await verifyLogoReader(client,Number(process.env.HOTEL_SETUP_LOGO_READER_FROZEN)):
      await runLogoReaderCutover(client,phase,process.env.HOTEL_SETUP_LOGO_READER_FROZEN||undefined);
    console.log(JSON.stringify(result));if(!['PLAN','PASS'].includes(result.status))process.exitCode=2;
  }catch(error){console.error(JSON.stringify(failure(error,['inspect','apply','verify'].includes(phase)?phase:'inspect',stage)));process.exitCode=1;}
  finally{await client?.end().catch(()=>{});}
}
