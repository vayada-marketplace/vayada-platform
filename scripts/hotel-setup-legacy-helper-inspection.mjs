import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const BINDINGS = [
  { organizationId: '6a717155-a188-45f3-87e5-5c8408f41a87', actorUserId: 'b9eec40b-2e2d-4ff1-b3d4-6d6e03bb58d9', login: 'vayada_next_hotel_setup_org_c0be02f6ee4d481aadb8c7eca98d74c1' },
  { organizationId: '2734e584-022d-432a-9637-ccb0cce59c53', actorUserId: 'a729d719-2297-4be7-8f7a-12bdf87da1b3', login: 'vayada_next_hotel_setup_org_74adc91d74b84f11bacdf2b961cc8438' },
];
const helpers = new Map([
  ['platform.channex_management_worker_scope(text,text,uuid)', '3962821606acc183a80d7cdeba3e264c6e957b97de8ac021c32b84ad1a7ea13c'],
  ['platform.channex_management_worker_source(text,text,uuid)', '81ad6522ed4c24661b0fd47dcc301799adc25b833c5aa313a506ade413ee5dd7'],
]);
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const require = value => { if (!value) throw new Error('hotel_setup_legacy_helper_inspection_unavailable'); };
const secretName = binding => `hotel-setup-command/prod/organization/${binding.login}`;

async function snapshot(client, principal) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
    const identity = (await client.query(`SELECT current_database() AS database,current_user AS principal,
      session_user AS session,pg_is_in_recovery() AS replica,
      (SELECT oid FROM pg_roles WHERE rolname=current_user) AS oid`)).rows;
    require(identity.length === 1 && identity[0].principal === principal &&
      identity[0].session === principal && identity[0].replica === false);
    const creationScopesTableOwnerOid = (await client.query(`SELECT relowner FROM pg_class
      WHERE oid='platform.hotel_setup_creation_scopes'::regclass`)).rows[0]?.relowner;
    const propertyScopesTableOwnerOid = (await client.query(`SELECT relowner FROM pg_class
      WHERE oid='platform.hotel_setup_property_scopes'::regclass`)).rows[0]?.relowner;
    require(Number.isInteger(creationScopesTableOwnerOid) && Number.isInteger(propertyScopesTableOwnerOid));
    const roles = (await client.query(`SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,
      rolcreatedb,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig
      FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [BINDINGS.map(b => b.login)])).rows;
    require(roles.length === 2 && roles.every(r => r.rolcanlogin && !r.rolinherit && !r.rolsuper &&
      !r.rolcreaterole && !r.rolcreatedb && !r.rolreplication && !r.rolbypassrls &&
      r.rolvaliduntil === null && r.rolconfig === null));
    const memberships = (await client.query(`SELECT m.*,p.rolname AS parent FROM pg_auth_members m
      JOIN pg_roles p ON p.oid=m.roleid WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[])
      ORDER BY roleid,member,grantor`, [roles.map(r => r.oid)])).rows;
    for (const role of roles) {
      const parents = memberships.filter(m => m.member === role.oid);
      require(parents.length === 1 && parents[0].parent === 'vayada_next_hotel_setup_scope' &&
        parents[0].inherit_option && !parents[0].set_option && !parents[0].admin_option);
    }
    const assignments = [];
    for (const binding of BINDINGS) {
      const rows = (await client.query(`SELECT database_login,organization_id FROM platform.hotel_setup_creation_scopes
        WHERE database_login=$1 OR organization_id=$2::uuid ORDER BY database_login`,
      [binding.login, binding.organizationId])).rows;
      require(rows.length === 1 && rows[0].database_login === binding.login &&
        rows[0].organization_id === binding.organizationId);
      assignments.push(rows[0]);
    }
    const functions = (await client.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,
      p.proowner,p.prosecdef,p.provolatile,p.proparallel,p.prokind,p.proleakproof,p.proisstrict,
      p.pronargs,p.pronargdefaults,p.prorettype,p.proargtypes::oid[] AS argument_types,
      p.proretset,p.provariadic,p.proallargtypes,p.proargmodes,p.prosupport,p.proargnames,p.proconfig,
      pg_get_expr(p.proargdefaults,0) AS defaults,l.lanname,p.prosrc,pg_get_functiondef(p.oid) AS definition,
      p.proowner=$2::oid AS helper_owner_matches,p.proowner=$3::oid AS helper_property_owner_matches
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=ANY($1::regprocedure[]) ORDER BY signature`, [[...helpers.keys()],creationScopesTableOwnerOid,propertyScopesTableOwnerOid])).rows;
    require(functions.length === 2);
    for (const fn of functions) {
      require(helpers.get(fn.signature) === hash(fn.prosrc) && !fn.prosecdef &&
        fn.provolatile === 's' && fn.proparallel === 'u' && fn.prokind === 'f' && !fn.proleakproof &&
        !fn.proisstrict && fn.pronargs === 3 && fn.pronargdefaults === 1 && fn.prorettype === 16 &&
        !fn.proretset && fn.provariadic === 0 && fn.proallargtypes === null && fn.proargmodes === null &&
        fn.prosupport === '-' && same(fn.argument_types, [25,25,2950]) &&
        same(fn.proargnames, ['kind','resource','parent']) && same(fn.proconfig, ['search_path=pg_catalog']) &&
        fn.defaults === 'NULL::uuid' && fn.lanname === 'plpgsql');
      fn.bodyHash = hash(fn.prosrc); fn.definitionHash = hash(fn.definition);
      delete fn.prosrc; delete fn.definition;
      fn.acl = (await client.query(`SELECT grantor,grantee,privilege_type,is_grantable FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=$1 ORDER BY grantor,grantee,privilege_type,is_grantable`, [fn.oid])).rows;
      require(!fn.acl.some(e => e.grantee === 0 && e.privilege_type === 'EXECUTE'));
    }
    const permissions = (await client.query(`SELECT r.oid AS role_oid,p.oid AS function_oid,
      has_schema_privilege(r.oid,p.pronamespace,'USAGE') AS schema_usage,
      has_function_privilege(r.oid,p.oid,'EXECUTE') AS execute,
      has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable
      FROM pg_roles r CROSS JOIN pg_proc p WHERE r.oid=ANY($1::oid[]) AND p.oid=ANY($2::oid[])
      ORDER BY r.oid,p.oid`, [roles.map(r => r.oid),functions.map(fn => fn.oid)])).rows;
    require(permissions.length === 4 && permissions.every(p => !p.grantable));
    return { identity: identity[0], creationScopesTableOwnerOid, propertyScopesTableOwnerOid, roles, memberships, assignments, functions, permissions };
  } finally { await client.query('ROLLBACK'); }
}

function version(metadata, binding) {
  const name = secretName(binding),prefix = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`;
  const versions = Object.entries(metadata.VersionIdsToStages ?? {});
  require(metadata.Name === name && metadata.ARN?.startsWith(prefix) &&
    /^[A-Za-z0-9]{6}$/.test(metadata.ARN.slice(prefix.length)) && !metadata.DeletedDate &&
    versions.length === 1 && /^[A-Za-z0-9-]{32,64}$/.test(versions[0][0]) &&
    same(versions[0][1], ['AWSCURRENT']));
  return versions[0][0];
}

/** Fixed read-only inspection/proof; no grants, readiness, role or secret writes. */
export async function inspectLegacyHelpers({admin,mode,frozen,describe,read,connectNative,principal='vayada_admin'}) {
  require(['inspect','verify'].includes(mode) && (mode === 'inspect' ? frozen === undefined : /^[a-f0-9]{64}$/.test(frozen ?? '')));
  require((await admin.query('SELECT pg_try_advisory_lock(8734516) AS locked')).rows[0]?.locked === true);
  try {
    const before = await snapshot(admin,principal);
    const blocked = before.permissions.some(p => !p.schema_usage || !p.execute) ||
      before.functions.some(fn => !fn.helper_owner_matches || !fn.helper_property_owner_matches);
    const versions = [];
    if (!blocked)
      for (const binding of BINDINGS) versions.push(version(await describe(secretName(binding)),binding));
    require(same(before,await snapshot(admin,principal)));
    const assertCurrentVersions = async () => {
      for (const [i,binding] of BINDINGS.entries())
        require(version(await describe(secretName(binding)),binding) === versions[i]);
    };
    if (!blocked) await assertCurrentVersions();
    const fingerprint = hash(JSON.stringify({before,versions}));
    const receipt = { status:'PASS',scope:'hotel_setup_legacy_helper_inspection',mode,fingerprint,
      creationScopesTableOwnerOid:before.creationScopesTableOwnerOid,
      propertyScopesTableOwnerOid:before.propertyScopesTableOwnerOid,
      organizations:BINDINGS.map((b,i) => ({...b,roleOid:before.roles.find(r => r.rolname === b.login).oid,secretVersion:versions[i] ?? null})),
      functions:before.functions.map(fn => ({signature:fn.signature,oid:fn.oid,ownerOid:fn.proowner,
        helperOwnerMatches:fn.helper_owner_matches,
        helperPropertyOwnerMatches:fn.helper_property_owner_matches,
        bodyHash:fn.bodyHash,definitionHash:fn.definitionHash,acl:fn.acl})),permissions:before.permissions };
    if (mode === 'verify') require(frozen === fingerprint);
    if (blocked) return {...receipt,status:'BLOCKED'};
    if (mode === 'verify') {
      for (const [i,binding] of BINDINGS.entries()) {
        const payload = await read(secretName(binding),versions[i]);
        require(payload && same(Object.keys(payload).sort(),['password','username']) &&
          payload.username === binding.login && typeof payload.password === 'string' &&
          Buffer.byteLength(payload.password) >= 32);
        const native = await connectNative(binding.login,payload.password);
        try {
          await native.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const identity = (await native.query('SELECT current_user,session_user,session_user::regrole::oid AS oid')).rows[0];
          require(identity?.current_user === binding.login && identity.session_user === binding.login &&
            identity.oid === receipt.organizations[i].roleOid);
          const result = (await native.query(`SELECT
            platform.channex_management_worker_source('organization',$1::text,NULL::uuid) AS source,
            platform.channex_management_worker_scope('property',$1::text,NULL::uuid) AS scope`,[binding.organizationId])).rows[0];
          require(result?.source === true && result.scope === true);
          require((await native.query('SELECT id FROM identity.organizations WHERE id=$1::uuid',[binding.organizationId])).rows.length === 1);
        } finally {
          try { await native.query('ROLLBACK'); } finally { await native.end(); }
        }
      }
      require(same(before,await snapshot(admin,principal)));
      await assertCurrentVersions();
    }
    return receipt;
  } finally { await admin.query('SELECT pg_advisory_unlock(8734516)').catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let admin,sts,secrets;
  let failed=false;
  const timer=setTimeout(() => { console.error(JSON.stringify({status:'FAIL',code:'hotel_setup_legacy_helper_deadline'}));process.exit(1); },170000);
  try {
    const url=new URL(process.env.TARGET_DATABASE_ADMIN_URL ?? '');
    require(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF === 'refs/heads/main' &&
      url.protocol === 'postgresql:' && url.hostname === 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' &&
      url.port === '5432' && url.username === 'vayada_admin' && url.pathname === '/postgres' &&
      url.password && !url.hash && url.search === '?sslmode=require' && process.env.VAYADA_DB_RDS_CA_BUNDLE);
    const {default:pg}=await import('pg');
    const {STSClient,GetCallerIdentityCommand}=await import('@aws-sdk/client-sts');
    const {SecretsManagerClient,DescribeSecretCommand,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');
    sts=new STSClient({region:'eu-west-1',endpoint:'https://sts.eu-west-1.amazonaws.com',maxAttempts:1});
    const caller=await sts.send(new GetCallerIdentityCommand({}),{abortSignal:AbortSignal.timeout(15000)});
    require(caller.Account === '269416271598' &&
      /^arn:aws:sts::269416271598:assumed-role\/vayada-hotel-setup-creation-bootstrap\/[A-Za-z0-9+=,.@_-]{2,64}$/.test(caller.Arn ?? ''));
    secrets=new SecretsManagerClient({region:'eu-west-1',endpoint:'https://secretsmanager.eu-west-1.amazonaws.com',maxAttempts:1,
      credentials:await sts.config.credentials()});
    const connection=(user,password) => {
      const client=new pg.Client({host:url.hostname,port:5432,database:'vayada_target_prod',user,password,
        ssl:{ca:process.env.VAYADA_DB_RDS_CA_BUNDLE,rejectUnauthorized:true,servername:url.hostname},
        connectionTimeoutMillis:10000,query_timeout:15000,statement_timeout:15000,
        options:'-c default_transaction_read_only=on -c search_path=pg_catalog'});
      client.on('error',() => {failed=true;});return client;
    };
    admin=connection('vayada_admin',decodeURIComponent(url.password));await admin.connect();
    const receipt=await inspectLegacyHelpers({admin,mode:process.env.HOTEL_SETUP_LEGACY_HELPER_MODE,
      frozen:process.env.HOTEL_SETUP_LEGACY_HELPER_FROZEN,
      describe:name => secrets.send(new DescribeSecretCommand({SecretId:name}),{abortSignal:AbortSignal.timeout(15000)}),
      read:async (name,versionId) => {
        const value=await secrets.send(new GetSecretValueCommand({SecretId:name,VersionId:versionId}),{abortSignal:AbortSignal.timeout(15000)});
        const prefix=`arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`;
        require(value.Name === name && value.VersionId === versionId && value.ARN?.startsWith(prefix) &&
          /^[A-Za-z0-9]{6}$/.test(value.ARN.slice(prefix.length)) && value.SecretString && !value.SecretBinary);
        return JSON.parse(value.SecretString);
      },connectNative:async (login,password) => {const client=connection(login,password);try {await client.connect();return client;} catch(error) {await client.end().catch(() => {});throw error;}}});
    require(!failed && Buffer.byteLength(JSON.stringify(receipt)) <= 8192);
    console.log(JSON.stringify(receipt));process.exitCode=receipt.status === 'BLOCKED' ? 2 : 0;
  } catch {
    console.error(JSON.stringify({status:'FAIL',code:'hotel_setup_legacy_helper_inspection_unavailable'}));process.exitCode=1;
  } finally {clearTimeout(timer);await admin?.end().catch(() => {});sts?.destroy();secrets?.destroy();}
}
