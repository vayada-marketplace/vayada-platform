import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const roles = ['vayada_next_hotel_setup_creation_reader', 'vayada_next_hotel_setup_reader'];
const helpers = new Map([
  ['platform.channex_management_worker_scope(text,text,uuid)', '3962821606acc183a80d7cdeba3e264c6e957b97de8ac021c32b84ad1a7ea13c'],
  ['platform.channex_management_worker_source(text,text,uuid)', '81ad6522ed4c24661b0fd47dcc301799adc25b833c5aa313a506ade413ee5dd7'],
]);
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const require = value => { if (!value) throw new Error('hotel_setup_reader_rls_permission_unavailable'); };

const step = (diagnostic, stage) => {
  if (diagnostic) Object.assign(diagnostic, { stage, predicate: null, checks: {}, subject: null,
    oid: null, bodyHash: null, definitionHash: null });
};
const check = (checks, diagnostic) => {
  if (diagnostic) Object.assign(diagnostic, { checks,
    predicate: Object.keys(checks).find(key => checks[key] !== true) ?? null });
  require(Object.values(checks).every(value => value === true));
};
export const readerInspectionDiagnostic = () => ({ stage: 'environment', predicate: null,
  checks: {}, subject: null, oid: null, bodyHash: null, definitionHash: null,
  lockAcquired: null, sqlState: null });
export function readerInspectionFailure(error, diagnostic) {
  return { status: 'FAIL', scope: 'hotel_setup_reader_rls_permissions', mode: 'inspect',
    code: 'hotel_setup_reader_rls_permission_unavailable', diagnostic: { ...diagnostic,
      predicate: diagnostic.predicate ?? (/^[A-Z0-9]{5}$/.test(error?.code ?? '') ? 'sql_error' : 'unexpected'),
      sqlState: /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null } };
}

async function inspect(client, principal, diagnostic) {
  step(diagnostic, 'identity');
  const identity = (await client.query(`SELECT current_database() AS database, current_user AS principal,
    session_user AS session, pg_is_in_recovery() AS replica,
    (SELECT oid FROM pg_roles WHERE rolname=current_user) AS oid`)).rows;
  check({ identityCount: identity.length === 1, principalMatches: identity[0]?.principal === principal,
    sessionMatches: identity[0]?.session === principal, primary: identity[0]?.replica === false }, diagnostic);
  step(diagnostic, 'readers');
  const readers = (await client.query(`SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,
    rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolconnlimit,
    rolvaliduntil::text,rolconfig FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [roles])).rows;
  check({ readerCount: readers.length === 2 }, diagnostic);
  for (const row of readers) {
    if (diagnostic) Object.assign(diagnostic, { subject: row.rolname, oid: row.oid });
    check({ login: row.rolcanlogin, noInherit: !row.rolinherit, noSuperuser: !row.rolsuper,
      noCreateRole: !row.rolcreaterole, noCreateDatabase: !row.rolcreatedb,
      noReplication: !row.rolreplication, noBypassRls: !row.rolbypassrls }, diagnostic);
  }
  step(diagnostic, 'memberships');
  const memberships = (await client.query(`SELECT roleid,member,grantor,admin_option,inherit_option,set_option
    FROM pg_auth_members WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[])
    ORDER BY roleid,member,grantor`, [readers.map(row => row.oid)])).rows;
  // CREATEROLE creators can retain incoming ADMIN membership; readers inherit no parent role.
  check({ noReaderParentMembership: !memberships.some(row => readers.some(reader => reader.oid === row.member)) }, diagnostic);
  step(diagnostic, 'functions');
  const functions = (await client.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,
    p.proowner,p.prosecdef,p.provolatile,p.proparallel,p.prokind,p.proleakproof,p.proisstrict,
    p.pronargs,p.pronargdefaults,p.prorettype,p.proargtypes::oid[] AS argument_types,
    p.proretset,p.provariadic,p.proallargtypes,p.proargmodes,p.prosupport,
    p.proargnames,p.proconfig,pg_get_expr(p.proargdefaults,0) AS defaults,l.lanname,
    p.prosrc,pg_get_functiondef(p.oid) AS definition,
    (pg_has_role(current_user,p.proowner,'USAGE') OR
      has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')) AS can_grant
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid=ANY(ARRAY(SELECT to_regprocedure(unnest($1::text[])))) ORDER BY signature`,
  [[...helpers.keys()]])).rows;
  check({ helperCount: functions.length === 2 }, diagnostic);
  for (const row of functions) {
    step(diagnostic, 'helper');
    if (diagnostic) Object.assign(diagnostic, { subject: helpers.has(row.signature) ? row.signature : null,
      oid: row.oid, bodyHash: hash(row.prosrc), definitionHash: hash(row.definition) });
    check({ signatureMatches: helpers.has(row.signature), bodyMatches: helpers.get(row.signature) === hash(row.prosrc),
      invoker: !row.prosecdef, stable: row.provolatile === 's',
      ownerNotReader: !readers.some(reader => reader.oid === row.proowner), parallelUnsafe: row.proparallel === 'u',
      functionKind: row.prokind === 'f', notLeakproof: !row.proleakproof, notStrict: !row.proisstrict,
      argumentCount: row.pronargs === 3, defaultCount: row.pronargdefaults === 1, booleanResult: row.prorettype === 16,
      notSetReturning: !row.proretset, notVariadic: row.provariadic === 0, noAllArgTypes: row.proallargtypes === null,
      noArgModes: row.proargmodes === null, noSupportFunction: row.prosupport === '-',
      argumentTypes: same(row.argument_types, [25, 25, 2950]), argumentNames: same(row.proargnames, ['kind', 'resource', 'parent']),
      searchPath: same(row.proconfig, ['search_path=pg_catalog']), defaultExpression: row.defaults === 'NULL::uuid',
      language: row.lanname === 'plpgsql', grantAuthority: row.can_grant === true }, diagnostic);
    row.bodyHash = hash(row.prosrc);
    row.definitionHash = hash(row.definition);
    delete row.prosrc;
    delete row.definition;
    if (diagnostic) diagnostic.stage = 'acl';
    row.acl = (await client.query(`SELECT grantor,grantee,privilege_type,is_grantable FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=$1 ORDER BY grantor,grantee,privilege_type,is_grantable`, [row.oid])).rows;
    check({ noPublicExecute: !row.acl.some(edge => edge.grantee === 0 && edge.privilege_type === 'EXECUTE'),
      noReaderGrantOption: !row.acl.some(edge => readers.some(reader => reader.oid === edge.grantee) && edge.is_grantable) }, diagnostic);
  }
  return { identity: identity[0], readers, memberships, functions };
}

// The shared migration lock is acquired before any snapshot and held through readback/COMMIT.
export async function runReaderRlsPermissionCheck(client, mode, frozen, principal = 'vayada_admin', diagnostic) {
  if (mode !== 'inspect') diagnostic = undefined;
  step(diagnostic, 'mode');
  require(['inspect', 'apply'].includes(mode) && (mode === 'inspect' ? frozen === undefined : /^[a-f0-9]{64}$/.test(frozen ?? '')));
  step(diagnostic, 'lock');
  const locked = (await client.query('SELECT pg_try_advisory_lock(8734516) AS locked')).rows[0]?.locked === true;
  if (diagnostic) diagnostic.lockAcquired = locked;
  check({ lockAcquired: locked }, diagnostic);
  try {
    step(diagnostic, 'transaction');
    await client.query(mode === 'inspect' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
    const before = await inspect(client, principal, diagnostic);
    const fingerprint = hash(JSON.stringify(before));
    const missing = before.functions.flatMap(fn => before.readers.filter(reader =>
      !fn.acl.some(edge => edge.grantee === reader.oid && edge.privilege_type === 'EXECUTE'))
      .map(reader => ({ signature: fn.signature, role: reader.rolname, oid: reader.oid })));
    if (mode === 'apply') {
      require(frozen === fingerprint);
      for (const edge of missing)
        await client.query(`GRANT EXECUTE ON FUNCTION ${edge.signature} TO ${edge.role}`);
      const after = await inspect(client, principal);
      require(same(before.identity, after.identity) && same(before.readers, after.readers) &&
        same(before.memberships, after.memberships));
      for (let index = 0; index < before.functions.length; index++) {
        const old = before.functions[index], current = after.functions[index];
        const additions = current.acl.filter(edge => !old.acl.some(prior => same(prior, edge)));
        const expected = missing.filter(edge => edge.signature === old.signature);
        require(additions.length === expected.length && additions.every(edge =>
          expected.some(item => item.oid === edge.grantee) && edge.privilege_type === 'EXECUTE' &&
          !edge.is_grantable && [old.proowner, before.identity.oid].includes(edge.grantor)) &&
          old.acl.every(edge => current.acl.some(next => same(next, edge))));
        require(same({ ...old, acl: [] }, { ...current, acl: [] }));
        require(after.readers.every(reader => current.acl.some(edge => edge.grantee === reader.oid &&
          edge.privilege_type === 'EXECUTE' && !edge.is_grantable)));
      }
      await client.query('COMMIT');
    } else { step(diagnostic, 'rollback'); await client.query('ROLLBACK'); }
    return { status: 'PASS', scope: 'hotel_setup_reader_rls_permissions', mode, fingerprint,
      readers: before.readers.map(row => ({ role: row.rolname, oid: row.oid })),
      functions: before.functions.map(row => ({ signature: row.signature, oid: row.oid,
        ownerOid: row.proowner, bodyHash: row.bodyHash, definitionHash: row.definitionHash, acl: row.acl })),
      missingEdges: missing.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.query('SELECT pg_advisory_unlock(8734516)').catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  let invalid = false;
  const diagnostic = process.env.HOTEL_SETUP_READER_RLS_MODE === 'inspect' ? readerInspectionDiagnostic() : undefined;
  try {
    let url;
    try { url = new URL(process.env.TARGET_DATABASE_ADMIN_URL ?? ''); } catch {}
    check({ urlParsed: !!url, githubActions: process.env.GITHUB_ACTIONS === 'true',
      main: process.env.GITHUB_REF === 'refs/heads/main', protocol: url?.protocol === 'postgresql:',
      host: url?.hostname === 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com',
      port: url?.port === '5432', username: url?.username === 'vayada_admin', database: url?.pathname === '/postgres',
      passwordPresent: !!url?.password, noFragment: !!url && !url.hash,
      sslQuery: url?.search === '?sslmode=require', caPresent: !!process.env.VAYADA_DB_RDS_CA_BUNDLE }, diagnostic);
    step(diagnostic, 'connect');
    const { default: pg } = await import('pg');
    client = new pg.Client({ host: url.hostname, port: 5432, database: 'vayada_target_prod',
      user: 'vayada_admin', password: decodeURIComponent(url.password),
      ssl: { ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname },
      connectionTimeoutMillis: 10000, query_timeout: 15000, statement_timeout: 15000,
      options: '-c search_path=pg_catalog' });
    client.on('error', () => { invalid = true; });
    client.on('notice', notice => { if (notice.code === '01007') invalid = true; });
    await client.connect();
    const receipt = await runReaderRlsPermissionCheck(client,
      process.env.HOTEL_SETUP_READER_RLS_MODE, process.env.HOTEL_SETUP_READER_RLS_FROZEN, 'vayada_admin', diagnostic);
    step(diagnostic, 'completion');
    check({ connectionValid: !invalid }, diagnostic);
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(JSON.stringify(diagnostic ? readerInspectionFailure(error, diagnostic) :
      { status: 'FAIL', code: 'hotel_setup_reader_rls_permission_unavailable' }));
    process.exitCode = 1;
  } finally { await client?.end().catch(() => {}); }
}
