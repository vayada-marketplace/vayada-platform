// VAY-2272: vayada_admin drops vayada_next_affiliate_capture, the login of the affiliate click capture
// that never went live. App migration 0497 retired the policies and functions it was made for.
// inspect is read-only and prints the fingerprint of everything it captured; apply recaptures under
// the same lock, refuses unless that fingerprint matches, revokes what vayada_admin granted the login
// and drops it in one transaction, then verifies after commit.
import { createHash } from "node:crypto";
import pg from "pg";

const scope = "affiliate_capture_login_retirement";
const version = 1;
const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const localHost = "vayada-affiliate-capture-login-db";
const database = "vayada_target_prod";
const admin = "vayada_admin";
const lockKey = 22720497;
const login = "vayada_next_affiliate_capture";
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code) => {
  const error = new Error(code);
  error.retirementCode = code;
  throw error;
};

const capture = async (client) => {
  const identity = (await client.query(`
    SELECT current_user::text AS "currentUser", session_user::text AS "sessionUser",
           current_database()::text AS database, pg_is_in_recovery() AS replica,
           current_setting('server_version_num')::int AS server,
           r.rolsuper AS superuser, r.rolcreaterole AS createrole
      FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
  if (!identity || identity.currentUser !== admin || identity.sessionUser !== admin ||
      identity.database !== database || identity.replica || identity.superuser ||
      !identity.createrole || identity.server < 160000)
    fail("affiliate_capture_login_identity_unexpected");
  const roles = (await client.query(`
    SELECT r.oid::text AS oid, r.rolname::text AS name, r.rolcanlogin AS "canLogin",
           r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS elevated,
           pg_has_role(current_user, r.oid, 'MEMBER WITH ADMIN OPTION') AS "adminOption",
           (SELECT count(*)::int FROM pg_stat_activity a WHERE a.usesysid = r.oid) AS sessions
      FROM pg_roles r WHERE r.rolname = $1`, [login])).rows;
  const oids = roles.map((role) => role.oid);
  const memberships = (await client.query(`
    SELECT roleid::regrole::text AS role, member::regrole::text AS member, grantor::regrole::text AS grantor,
           admin_option AS admin, inherit_option AS inherit, set_option AS set
      FROM pg_auth_members WHERE roleid = ANY($1::oid[]) OR member = ANY($1::oid[]) OR grantor = ANY($1::oid[])
     ORDER BY 1, 2, 3`, [oids])).rows;
  // Grants to the login, and any it gave itself (those would block the drop).
  const grants = (await client.query(`
    SELECT * FROM (
      SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'relation' END AS kind, c.oid::regclass::text AS object,
             '' AS "column", a.grantee::regrole::text AS grantee, a.grantor::regrole::text AS grantor, a.privilege_type AS privilege,
             a.is_grantable AS grantable
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee = ANY($1::oid[]) OR a.grantor = ANY($1::oid[])
      UNION ALL
      SELECT 'column', c.oid::regclass::text, t.attname::text, a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type,
             a.is_grantable
        FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid CROSS JOIN LATERAL aclexplode(t.attacl) a
       WHERE a.grantee = ANY($1::oid[]) OR a.grantor = ANY($1::oid[])
      UNION ALL
      SELECT 'routine', p.oid::regprocedure::text, '', a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type,
             a.is_grantable
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE a.grantee = ANY($1::oid[]) OR a.grantor = ANY($1::oid[])
      UNION ALL
      SELECT 'schema', quote_ident(n.nspname), '', a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type,
             a.is_grantable
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee = ANY($1::oid[]) OR a.grantor = ANY($1::oid[])
      UNION ALL
      SELECT 'database', quote_ident(d.datname), '', a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type,
             a.is_grantable
        FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE a.grantee = ANY($1::oid[]) OR a.grantor = ANY($1::oid[])
    ) entries ORDER BY 1, 2, 3, 4, 5, 6`, [oids])).rows;
  // pg_shdepend covers every database of the cluster: grants made elsewhere, ownership, policy roles.
  const dependencies = (await client.query(`
    SELECT d.dbid::int AS dbid, (d.dbid = 0 OR d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())) AS here,
           d.classid::regclass::text AS class, d.deptype::text AS type, count(*)::int AS count
      FROM pg_shdepend d
     WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = ANY($1::oid[])
     GROUP BY 1, 2, 3, 4 ORDER BY 1, 3, 4`, [oids])).rows;
  // Text that names the login is invisible to pg_shdepend, and a pg_has_role on a dropped role
  // fails every caller. Until app migration 0497 has run, two 0416 policies still name it.
  const references = (await client.query(`
    SELECT (SELECT count(*)::int FROM pg_policy p
             WHERE concat(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) LIKE '%' || $1 || '%')
         + (SELECT count(*)::int FROM pg_proc p
             WHERE p.prosrc LIKE '%' || $1 || '%'
                OR (p.prokind IN ('f', 'p') AND p.prosqlbody IS NOT NULL AND pg_get_functiondef(p.oid) LIKE '%' || $1 || '%'))
         + (SELECT count(*)::int FROM pg_class c WHERE c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) LIKE '%' || $1 || '%')
         + (SELECT count(*)::int FROM pg_constraint k WHERE k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%' || $1 || '%')
         + (SELECT count(*)::int FROM pg_attrdef d WHERE pg_get_expr(d.adbin, d.adrelid) LIKE '%' || $1 || '%')
         + (SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) LIKE '%' || $1 || '%')
         AS count`, [login])).rows[0].count;
  const defaults = (await client.query(`
    SELECT count(*)::int AS count FROM pg_default_acl d
     WHERE d.defaclrole = ANY($1::oid[])
        OR EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = ANY($1::oid[]))`, [oids])).rows[0].count;
  return { identity, roles, memberships, grants, dependencies, references, defaults };
};

// The only dependencies apply removes: privileges on tables (and their columns), routines, schemas and
// databases, in this database or the shared catalog.
const revocable = new Set(["pg_class", "pg_proc", "pg_namespace", "pg_database"]);
const toLogin = (grant) => grant.grantee === login;
const blockersFor = (state) => {
  const blockers = [];
  const { roles, memberships, grants, dependencies, references, defaults } = state;
  const role = roles[0];
  if (!role) return ["affiliate_capture_login_already_retired"];
  if (role.elevated) blockers.push("affiliate_capture_login_attributes_unexpected");
  if (!role.adminOption) blockers.push("affiliate_capture_login_admin_option_missing");
  if (role.sessions > 0) blockers.push("affiliate_capture_login_sessions_active");
  if (memberships.some((edge) => edge.grantor === login)) blockers.push("affiliate_capture_login_grant_memberships");
  // A role that is a member of the login would silently lose its privileges (vayada_admin's own
  // creator grant goes with the drop).
  if (memberships.some((edge) => edge.role === login && edge.member !== admin))
    blockers.push("affiliate_capture_login_has_members");
  // Only vayada_admin's own grants can be revoked here; anything else needs its grantor first.
  if (grants.some((grant) => toLogin(grant) && grant.grantor !== admin)) blockers.push("affiliate_capture_login_foreign_grants");
  if (grants.some((grant) => grant.grantor === login)) blockers.push("affiliate_capture_login_grantor");
  if (dependencies.some((row) => !row.here || row.type !== "a" || !revocable.has(row.class)))
    blockers.push("affiliate_capture_login_dependencies_remaining");
  if (defaults) blockers.push("affiliate_capture_login_default_privileges");
  if (references) blockers.push("affiliate_capture_login_still_referenced");
  return blockers;
};

const summarize = (state) => ({
  login: state.roles[0]
    ? { name: login, canLogin: state.roles[0].canLogin, sessions: state.roles[0].sessions }
    : null,
  memberships: state.memberships.map(({ role, member, grantor }) => [role, member, grantor]),
  // The exact grants apply revokes before the drop, so an operator can see (and restore) them.
  adminGrantList: state.grants
    .filter((grant) => toLogin(grant) && grant.grantor === admin)
    .map(({ kind, object, column, privilege }) => [kind, object, column, privilege]),
  otherGrants: state.grants.filter((grant) => toLogin(grant) && grant.grantor !== admin).length,
  // What blocks the drop, in full, so its grantor can remove it first.
  otherGrantList: state.grants
    .filter((grant) => !toLogin(grant) || grant.grantor !== admin)
    .map(({ kind, object, column, grantee, grantor, privilege }) => [kind, object, column, grantee, grantor, privilege]),
  dependencies: state.dependencies.reduce((total, row) => total + row.count, 0),
  dependencyList: state.dependencies.map(({ dbid, class: kind, type, count }) => [dbid, kind, type, count]),
  references: state.references,
  blockers: blockersFor(state),
});

const revokeStatement = ({ kind, object, column }) => {
  if (kind === "relation") return `REVOKE ALL ON TABLE ${object} FROM ${quote(login)}`;
  if (kind === "sequence") return `REVOKE ALL ON SEQUENCE ${object} FROM ${quote(login)}`;
  if (kind === "column") return `REVOKE ALL (${quote(column)}) ON TABLE ${object} FROM ${quote(login)}`;
  if (kind === "routine") return `REVOKE ALL ON ROUTINE ${object} FROM ${quote(login)}`;
  if (kind === "schema") return `REVOKE ALL ON SCHEMA ${object} FROM ${quote(login)}`;
  return `REVOKE ALL ON DATABASE ${object} FROM ${quote(login)}`;
};

const phase = process.env.VAYADA_AFFILIATE_CAPTURE_LOGIN_PHASE;
const frozen = process.env.VAYADA_AFFILIATE_CAPTURE_LOGIN_FROZEN || undefined;
let client;
let locked = false;
let commitAttempted = false;
let committed = false;
let stage = "configuration";
try {
  if (!["inspect", "apply"].includes(phase) ||
      (phase === "inspect" ? frozen !== undefined : !/^[a-f0-9]{64}$/.test(frozen ?? "")))
    fail("affiliate_capture_login_arguments_invalid");
  const url = new URL(process.env.TARGET_DATABASE_ADMIN_URL ?? "");
  const local = process.env.VAYADA_AFFILIATE_CAPTURE_LOGIN_LOCAL_FIXTURE === "1" && url.hostname === localHost;
  if (local ? (url.protocol !== "postgresql:" || url.username !== admin || !url.password || url.hash || url.search)
      : (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main" ||
         url.protocol !== "postgresql:" || url.hostname !== expectedHost || url.port !== "5432" ||
         url.pathname !== "/postgres" || url.username !== admin || !url.password || url.hash ||
         url.search !== "?sslmode=require" || !process.env.VAYADA_DB_RDS_CA_BUNDLE))
    fail("affiliate_capture_login_endpoint_untrusted");
  client = new pg.Client({
    host: url.hostname, port: Number(url.port || 5432), database, user: admin,
    password: decodeURIComponent(url.password),
    ssl: local ? undefined : { ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname },
    connectionTimeoutMillis: 10_000, query_timeout: 20_000,
  });
  client.on("error", () => {});
  // PostgreSQL warns (01006, 01007) when a REVOKE or GRANT could not change what it was asked to:
  // a drifted plan, so refuse it.
  let drift = false;
  client.on("notice", (notice) => { if (["01006", "01007"].includes(notice.code)) drift = true; });
  stage = "connect";
  await client.connect();
  stage = "lock";
  if ((await client.query("SELECT pg_try_advisory_lock($1) AS held", [lockKey])).rows[0]?.held !== true)
    fail("affiliate_capture_login_busy");
  locked = true;
  await client.query(phase === "inspect" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
  await client.query("SET LOCAL search_path TO pg_catalog; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'");
  stage = "capture";
  const before = await capture(client);
  const fingerprint = hash({ scope, version, state: before });
  const plan = summarize(before);
  if (phase === "inspect") {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ status: "PLAN", scope, phase, fingerprint, ready: plan.blockers.length === 0, ...plan }));
  } else {
    if (frozen !== fingerprint) fail("affiliate_capture_login_plan_changed");
    if (plan.blockers.length) fail(plan.blockers[0]);
    stage = "revoke";
    // One REVOKE ALL per object; on a table it also clears that table's column privileges.
    for (const statement of new Set(before.grants.filter(toLogin).map(revokeStatement))) await client.query(statement);
    if (drift) fail("affiliate_capture_login_revoke_drift");
    stage = "drop";
    await client.query(`DROP ROLE ${quote(login)}`);
    stage = "commit";
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    stage = "verify";
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL search_path TO pg_catalog");
    const verified = await capture(client);
    await client.query("ROLLBACK");
    if (verified.roles.length !== 0) fail("affiliate_capture_login_verification_failed");
    console.log(JSON.stringify({ status: "PASS", scope, phase, fingerprint, ...summarize(verified) }));
  }
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  // 2BP01: DROP ROLE found a dependency the plan did not foresee; nothing changed.
  const code = error?.retirementCode ??
    (error?.code === "2BP01" ? "affiliate_capture_login_dependencies_remaining" : "affiliate_capture_login_unavailable");
  console.error(JSON.stringify({
    status: committed ? "COMMITTED_UNVERIFIED" : commitAttempted ? "UNCERTAIN" : "FAIL",
    scope, phase, code, stage, sqlState: /^[A-Z0-9]{5}$/.test(error?.code ?? "") ? error.code : null,
  }));
  process.exitCode = 1;
} finally {
  if (locked) await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => undefined);
  await client?.end().catch(() => undefined);
}
