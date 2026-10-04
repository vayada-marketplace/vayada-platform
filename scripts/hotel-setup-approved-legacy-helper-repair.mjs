import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const BINDINGS = [
  { organizationId:'6a717155-a188-45f3-87e5-5c8408f41a87', actorUserId:'b9eec40b-2e2d-4ff1-b3d4-6d6e03bb58d9', login:'vayada_next_hotel_setup_org_c0be02f6ee4d481aadb8c7eca98d74c1' },
  { organizationId:'2734e584-022d-432a-9637-ccb0cce59c53', actorUserId:'a729d719-2297-4be7-8f7a-12bdf87da1b3', login:'vayada_next_hotel_setup_org_74adc91d74b84f11bacdf2b961cc8438' },
];
const FUNCTIONS = [
  ['platform.channex_management_worker_scope(text,text,uuid)','3962821606acc183a80d7cdeba3e264c6e957b97de8ac021c32b84ad1a7ea13c','2876336c9cdddbc60acc10f74c7cb9f9a575fb035824f55b961390215281cbb2'],
  ['platform.channex_management_worker_source(text,text,uuid)','81ad6522ed4c24661b0fd47dcc301799adc25b833c5aa313a506ade413ee5dd7','8333d3b5cfe357880922d0dc0b46360d419f06194ecd449371bd115bcef73b76'],
];
const PRODUCTION_OIDS = { roles:[247805,247808], functions:[245710,245718], owner:28700 };
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const require = value => { if (!value) throw new Error('hotel_setup_approved_legacy_helper_repair_unavailable'); };
const secretName = binding => `hotel-setup-command/prod/organization/${binding.login}`;

async function authority(client, binding, primitives, locked) {
  const organizations = (await client.query(`SELECT id,kind,status FROM identity.organizations
    WHERE id=$1::uuid${locked ? ' FOR UPDATE' : ''}`, [binding.organizationId])).rows;
  require(organizations.length === 1 && organizations[0].kind === 'hotel_group' && organizations[0].status === 'active');
  const reads = [];
  // The compiled permission resolver is shared with serving. READ ONLY snapshots remove
  // only its trailing row-lock clause; apply executes the same statements unchanged.
  const permissions = await primitives.lockHotelSetupCreationPermissions({
    async query(sql,values) {
      const result = await client.query(locked ? sql : sql.replace(/\s+FOR SHARE\s*$/, ''),values);
      reads.push(result.rows); return result;
    },
  },binding);
  require(permissions?.includes('hotel_catalog.setup.manage'));
  return {organizations,reads};
}

async function capture(client, principal, primitives, expected, locked = false) {
  const identity = (await client.query(`SELECT current_user AS principal,session_user AS session,
    pg_is_in_recovery() AS replica,(SELECT oid FROM pg_roles WHERE rolname=current_user) AS oid,
    (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS can_create_roles,
    EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
      WHERE m.member=current_user::regrole::oid AND r.rolname='vayada_next_hotel_setup_scope' AND m.admin_option) AS scope_role_admin`)).rows[0];
  require(identity?.principal === principal && identity.session === principal && identity.replica === false && identity.oid === expected.owner);
  const roles = (await client.query(`SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,
    rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig FROM pg_roles WHERE oid=ANY($1::oid[]) ORDER BY oid`,[expected.roles])).rows;
  require(roles.length === 2);
  for (const [index,binding] of BINDINGS.entries()) {
    const role = roles.find(r => r.oid === expected.roles[index]);
    require(role?.rolname === binding.login && role.rolcanlogin && !role.rolinherit && !role.rolsuper &&
      !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication && !role.rolbypassrls &&
      role.rolvaliduntil === null && role.rolconfig === null);
  }
  const memberships = (await client.query(`SELECT m.*,r.rolname AS parent FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
    WHERE m.roleid=ANY($1::oid[]) OR m.member=ANY($1::oid[]) ORDER BY roleid,member,grantor`,[expected.roles])).rows;
  for (const oid of expected.roles) {
    const parents = memberships.filter(m => m.member === oid);
    require(parents.length === 1 && parents[0].parent === 'vayada_next_hotel_setup_scope' &&
      parents[0].inherit_option && !parents[0].set_option && !parents[0].admin_option);
  }
  const assignments = [], authorities = [];
  for (const binding of [...BINDINGS].sort((a,b) => a.organizationId.localeCompare(b.organizationId))) {
    authorities.push(await authority(client,binding,primitives,locked));
    const rows = (await client.query(`SELECT database_login,organization_id FROM platform.hotel_setup_creation_scopes
      WHERE database_login=$1 OR organization_id=$2::uuid ORDER BY database_login${locked ? ' FOR UPDATE' : ''}`,
      [binding.login,binding.organizationId])).rows;
    require(rows.length === 1 && rows[0].database_login === binding.login && rows[0].organization_id === binding.organizationId);
    assignments.push(rows[0]);
  }
  const owners = (await client.query(`SELECT relowner FROM pg_class
    WHERE oid IN ('platform.hotel_setup_creation_scopes'::regclass,'platform.hotel_setup_property_scopes'::regclass) ORDER BY oid`)).rows;
  require(owners.length === 2 && owners.every(r => r.relowner === expected.owner));
  const functions = (await client.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,p.proowner,
    to_jsonb(p)-'prosrc'-'proacl' AS metadata,p.prosrc,pg_get_functiondef(p.oid) AS definition,
    (pg_has_role(current_user,p.proowner,'USAGE') OR has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')) AS can_grant
    FROM pg_proc p WHERE p.oid=ANY($1::oid[]) ORDER BY oid`,[expected.functions])).rows;
  require(functions.length === 2);
  for (const [index,[signature,bodyHash,definitionHash]] of FUNCTIONS.entries()) {
    const fn = functions.find(f => f.oid === expected.functions[index]);
    require(fn?.signature === signature && fn.proowner === expected.owner && fn.can_grant &&
      hash(fn.prosrc) === bodyHash && hash(fn.definition) === definitionHash);
    delete fn.prosrc; delete fn.definition;
    fn.acl = (await client.query(`SELECT grantor,grantee,privilege_type,is_grantable FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1
      ORDER BY grantor,grantee,privilege_type,is_grantable`,[fn.oid])).rows;
    require(!fn.acl.some(e => e.grantee === 0 && e.privilege_type === 'EXECUTE') &&
      !fn.acl.some(e => expected.roles.includes(e.grantee) && e.is_grantable));
  }
  const permissions = (await client.query(`SELECT r.oid AS role_oid,p.oid AS function_oid,
    has_schema_privilege(r.oid,p.pronamespace,'USAGE') AS schema_usage,
    has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable
    FROM pg_roles r CROSS JOIN pg_proc p WHERE r.oid=ANY($1::oid[]) AND p.oid=ANY($2::oid[])
    ORDER BY r.oid,p.oid`,[expected.roles,expected.functions])).rows;
  require(permissions.length === 4 && permissions.every(p => p.schema_usage && !p.grantable));
  return {identity,roles,memberships,assignments,authorities,owners,functions,permissions};
}

async function snapshot(admin,principal,primitives,expected) {
  await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await admin.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
    return await capture(admin,principal,primitives,expected);
  } finally { await admin.query('ROLLBACK'); }
}
function version(metadata,binding) {
  const name = secretName(binding), prefix = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`;
  const versions = Object.entries(metadata.VersionIdsToStages ?? {});
  require(metadata.Name === name && metadata.ARN?.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(metadata.ARN.slice(prefix.length)) &&
    !metadata.DeletedDate && versions.length === 1 && /^[A-Za-z0-9-]{32,64}$/.test(versions[0][0]) && same(versions[0][1],['AWSCURRENT']));
  return versions[0][0];
}

// Outcome observation must not reject changed metadata: report unexpected/unavailable after COMMIT.
async function observe(client, expected, transaction = true) {
  if(transaction) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = (await client.query(`SELECT jsonb_build_object(
      'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY oid) FROM pg_roles r WHERE oid=ANY($1::oid[])),
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor) FROM pg_auth_members m WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[])),
      'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM pg_proc p WHERE oid=ANY($2::oid[])),
      'assignments',(SELECT jsonb_agg(to_jsonb(s) ORDER BY database_login) FROM platform.hotel_setup_creation_scopes s WHERE database_login=ANY($3::text[]))
    ) AS catalog`,[expected.roles,expected.functions,BINDINGS.map(b => b.login)])).rows[0]?.catalog;
    require(result);return result;
  } finally {if(transaction) await client.query('ROLLBACK');}
}

/** Operational only; fixture overrides accept OIDs, never alternative names or bindings. */
export async function repairLegacyHelpers({connectAdmin,principal='vayada_target_prod_user',primitives,mode,frozen,describe,read,connectNative,expected=PRODUCTION_OIDS,onCommitPhase=() => {}}) {
  require(['inspect','apply'].includes(mode) && (mode === 'inspect' ? frozen === undefined : /^[a-f0-9]{64}$/.test(frozen ?? '')) &&
    expected.roles.length === 2 && expected.functions.length === 2 &&
    [...expected.roles,...expected.functions,expected.owner].every(oid => Number.isInteger(oid) && oid > 0 && oid <= 4294967295));
  let admin = await connectAdmin();
  const lock = async () => require((await admin.query('SELECT pg_try_advisory_lock(8734516) AS locked')).rows[0]?.locked === true);
  try {
    await lock();
    const before = await snapshot(admin,principal,primitives,expected);
    const originalCatalog = await observe(admin,expected);
    const versions = await Promise.all(BINDINGS.map(async b => version(await describe(secretName(b)),b)));
    const current = async () => {
      const next = await Promise.all(BINDINGS.map(async b => version(await describe(secretName(b)),b)));
      require(same(next,versions));
    };
    let nativeCheck=null;
    const native = async proveHelpers => {
      for (const [index,binding] of BINDINGS.entries()) {
        const payload = await read(secretName(binding),versions[index]);
        require(payload && same(Object.keys(payload).sort(),['password','username']) && payload.username === binding.login &&
          typeof payload.password === 'string' && Buffer.byteLength(payload.password) >= 32);
        const client = await connectNative(binding.login,payload.password);
        try {
          // The assigned-organization policy requires READ COMMITTED row locks; no business write is issued.
          await client.query(proveHelpers ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          nativeCheck='identity';const identity = (await client.query('SELECT current_user,session_user,session_user::regrole::oid AS oid')).rows[0];
          require(identity?.current_user === binding.login && identity.session_user === binding.login && identity.oid === expected.roles[index]);
          if (proveHelpers) {
            nativeCheck='helpers';const proof = (await client.query(`SELECT platform.channex_management_worker_source('organization',$1::text,NULL::uuid) AS source,
              platform.channex_management_worker_scope('property',$1::text,NULL::uuid) AS scope`,[binding.organizationId])).rows[0];
            require(proof?.source === true && proof.scope === true);
            nativeCheck='own_org';require((await client.query('SELECT id FROM identity.organizations WHERE id=$1::uuid',[binding.organizationId])).rows.length === 1);
          }
        } finally { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
      }
    };
    await native(false);
    require(same(before,await snapshot(admin,principal,primitives,expected)));
    await current();
    const fingerprint = hash(JSON.stringify({before,versions}));
    if (mode === 'apply') require(frozen === fingerprint);
    let addedEdges = 0, grantedMetadata, committedCatalog;
    if (mode === 'apply') {
      await admin.query('BEGIN');
      try {
        await admin.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
        require(same(before,await capture(admin,principal,primitives,expected,true)));
        await current();
        for (const [signature] of FUNCTIONS) for (const [index,binding] of BINDINGS.entries()) {
          const fn = before.functions.find(f => f.signature === signature);
          if (!fn.acl.some(e => e.grantee === expected.roles[index] && e.privilege_type === 'EXECUTE')) {
            await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${binding.login}`);
            addedEdges++;
          }
        }
        const after = await capture(admin,principal,primitives,expected,true);
        grantedMetadata = after;
        const unchanged = object => ({...object,functions:object.functions.map(fn => ({...fn,acl:[]}))});
        require(same(unchanged(before),unchanged(after)));
        for (const old of before.functions) {
          const fn = after.functions.find(f => f.oid === old.oid);
          const additions = fn.acl.filter(e => !old.acl.some(prior => same(prior,e)));
          const missing = expected.roles.filter(oid => !old.acl.some(e => e.grantee === oid && e.privilege_type === 'EXECUTE'));
          require(additions.length === missing.length && additions.every(e => missing.includes(e.grantee) &&
            e.privilege_type === 'EXECUTE' && !e.is_grantable && [old.proowner,before.identity.oid].includes(e.grantor)) &&
            old.acl.every(e => fn.acl.some(next => same(next,e))) && expected.roles.every(oid =>
              fn.acl.some(e => e.grantee === oid && e.privilege_type === 'EXECUTE' && !e.is_grantable)));
        }
        committedCatalog=await observe(admin,expected,false);
        await current();
        onCommitPhase('commit_attempted',{fingerprint,addedEdges});
        try { await admin.query('COMMIT'); }
        catch {
          let catalog='unavailable';
          try {
            await admin.end().catch(() => {});admin = await connectAdmin();await lock();
            const observed=await observe(admin,expected);
            catalog=same(observed,committedCatalog) ? 'exact_granted' : same(observed,originalCatalog) ? 'unchanged' : 'unexpected';
          } catch {}
          return {status:'UNCERTAIN',scope:'hotel_setup_approved_legacy_helper_repair',mode,fingerprint,catalog};
        }
      } catch (error) { await admin.query('ROLLBACK').catch(() => {}); throw error; }
      onCommitPhase('committed',{fingerprint,addedEdges});
      let proofStage='catalog';
      try {
        require(same(await observe(admin,expected),committedCatalog));
        proofStage='native';await native(true);
        proofStage='metadata';const after = await snapshot(admin,principal,primitives,expected);
        require(same(after,grantedMetadata));
        proofStage='versions';await current();
        require(after.functions.every(fn => expected.roles.every(oid => fn.acl.some(e => e.grantee === oid && e.privilege_type === 'EXECUTE' && !e.is_grantable))));
      } catch (error) {
        let catalog='unavailable';
        try {catalog=same(await observe(admin,expected),committedCatalog) ? 'unchanged_since_commit' : 'changed';} catch {}
        return {status:'COMMITTED_UNVERIFIED',scope:'hotel_setup_approved_legacy_helper_repair',mode,
          fingerprint,committed:true,addedEdges,catalog,nativeProof:'unverified',proofStage,nativeCheck,sqlState:/^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null};
      }
    }
    return {status:'PASS',scope:'hotel_setup_approved_legacy_helper_repair',
      owner:{oid:before.identity.oid,canCreateRoles:before.identity.can_create_roles,scopeRoleAdmin:before.identity.scope_role_admin},mode,fingerprint,addedEdges,committed:mode === 'apply',
      missingEdges:mode === 'apply' ? 0 : before.functions.reduce((count,fn) => count + expected.roles.filter(oid => !fn.acl.some(e => e.grantee === oid && e.privilege_type === 'EXECUTE')).length,0),
      organizations:BINDINGS.map((b,index) => ({...b,roleOid:expected.roles[index],secretVersion:versions[index]})),
      nativeProof:mode === 'apply' ? 'helpers_and_own_org' : 'identity_only'};
  } finally { await admin.query('SELECT pg_advisory_unlock(8734516)').catch(() => {}); await admin.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let sts,secrets,failed=false,commitPhase=null,commitReceipt={};
  const timer=setTimeout(() => {
    const status=commitPhase === 'committed' ? 'COMMITTED_UNVERIFIED' : commitPhase === 'commit_attempted' ? 'UNCERTAIN' : 'FAIL';
    console.error(JSON.stringify({status,scope:'hotel_setup_approved_legacy_helper_repair',
      code:'hotel_setup_approved_legacy_helper_deadline',...commitReceipt,
      ...(commitPhase ? {catalog:'unavailable',nativeProof:'unverified'} : {}),
      ...(commitPhase === 'committed' ? {committed:true} : {})}));process.exit(1);
  },170000);
  try {
    const url=new URL(process.env.TARGET_DATABASE_MIGRATION_URL ?? '');
    require(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF === 'refs/heads/main' &&
      ['inspect','apply'].includes(process.env.HOTEL_SETUP_LEGACY_HELPER_MODE) &&
      url.protocol === 'postgresql:' && url.hostname === 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' &&
      url.port === '5432' && url.username === 'vayada_target_prod_user' && url.pathname === '/vayada_target_prod' &&
      url.password && !url.hash && url.search === '?sslmode=require' && process.env.VAYADA_DB_RDS_CA_BUNDLE);
    const {default:pg}=await import('pg');
    const [{STSClient,GetCallerIdentityCommand},{SecretsManagerClient,DescribeSecretCommand,GetSecretValueCommand},membership]=await Promise.all([
      import('@aws-sdk/client-sts'),import('@aws-sdk/client-secrets-manager'),
      import('/app/apps/api/dist/hotelSetupMembership.js')]);
    sts=new STSClient({region:'eu-west-1',endpoint:'https://sts.eu-west-1.amazonaws.com',maxAttempts:1});
    const caller=await sts.send(new GetCallerIdentityCommand({}));
    require(caller.Account === '269416271598' && /^arn:aws:sts::269416271598:assumed-role\/vayada-hotel-setup-creation-bootstrap\/[-A-Za-z0-9_]+$/.test(caller.Arn ?? ''));
    secrets=new SecretsManagerClient({region:'eu-west-1',endpoint:'https://secretsmanager.eu-west-1.amazonaws.com',maxAttempts:1,credentials:await sts.config.credentials()});
    const connection=async (user,password) => {
      const client=new pg.Client({host:url.hostname,port:5432,database:'vayada_target_prod',user,password,
        ssl:{ca:process.env.VAYADA_DB_RDS_CA_BUNDLE,rejectUnauthorized:true,servername:url.hostname},
        connectionTimeoutMillis:10000,query_timeout:15000,statement_timeout:15000,options:'-c search_path=pg_catalog'});
      client.on('error',() => {failed=true;});
      client.on('notice',notice => {if(notice.code === '01007')failed=true;});
      try {await client.connect();return client;} catch(error){await client.end().catch(() => {});throw error;}
    };
    let result=await repairLegacyHelpers({
      connectAdmin:() => connection('vayada_target_prod_user',decodeURIComponent(url.password)),
      primitives:membership,onCommitPhase:(phase,receipt) => {commitPhase=phase;commitReceipt=receipt;},
      mode:process.env.HOTEL_SETUP_LEGACY_HELPER_MODE,frozen:process.env.HOTEL_SETUP_LEGACY_HELPER_FROZEN,
      describe:name => secrets.send(new DescribeSecretCommand({SecretId:name}),{abortSignal:AbortSignal.timeout(5000)}),
      read:async (name,versionId) => {
        const stored=await secrets.send(new GetSecretValueCommand({SecretId:name,VersionId:versionId}),{abortSignal:AbortSignal.timeout(5000)});
        const prefix=`arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`;
        require(stored.Name === name && stored.VersionId === versionId && stored.ARN?.startsWith(prefix) &&
          /^[A-Za-z0-9]{6}$/.test(stored.ARN.slice(prefix.length)) && typeof stored.SecretString === 'string' && !stored.SecretBinary);
        return JSON.parse(stored.SecretString);
      },connectNative:connection,
    });
    if(failed && result.status === 'PASS') result={...result,status:result.committed ? 'COMMITTED_UNVERIFIED' : 'FAIL',catalog:'unavailable',nativeProof:'unverified'};
    require(Buffer.byteLength(JSON.stringify(result)) <= 8192);
    console.log(JSON.stringify(result));
    if(result.status !== 'PASS')process.exitCode=2;
  } catch { console.error(JSON.stringify({status:'FAIL',code:'hotel_setup_approved_legacy_helper_repair_unavailable'}));process.exitCode=1; }
  finally { clearTimeout(timer);sts?.destroy();secrets?.destroy(); }
}
