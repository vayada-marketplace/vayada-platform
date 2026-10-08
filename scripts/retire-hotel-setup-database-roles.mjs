// VAY-2056 decommission steps 6a and 6c: vayada_admin retires the native hotel-setup roles.
//   disable (6a, before app migration 0474): NOLOGIN on every hotel-setup login and reader,
//     revoke every grant vayada_admin gave any hotel-setup role, then end their sessions.
//   drop (6c, after 0474): drop the logins and readers, then the four scope parents.
// inspect is read-only and prints the fingerprint of everything it captured; apply recaptures
// under the same lock, refuses unless that fingerprint matches, and verifies after commit.
import { createHash } from "node:crypto";
import pg from "pg";

const scope = "hotel_setup_role_retirement";
const version = 1;
const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const localHost = "vayada-hotel-setup-roles-db";
const database = "vayada_target_prod";
const admin = "vayada_admin";
const lockKey = 20560602;
const prefix = "vayada_next_hotel_setup_";
const parents = ["scope", "property_scope", "logo_scope", "profile_scope"].map((name) => prefix + name);
const readers = ["reader", "creation_reader"].map((name) => prefix + name);
const login = /^vayada_next_hotel_setup_(org|property|logo|profile)_[a-z0-9_]{1,48}$/;
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code) => {
  const error = new Error(code);
  error.retirementCode = code;
  throw error;
};
const kindOf = (name) =>
  parents.includes(name) ? "parent" : readers.includes(name) ? "reader" : login.test(name) ? "login" : "unexpected";

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
    fail("hotel_setup_roles_identity_unexpected");
  const roles = (await client.query(`
    SELECT r.oid::text AS oid, r.rolname::text AS name, r.rolcanlogin AS "canLogin",
           r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS elevated,
           pg_has_role(current_user, r.oid, 'MEMBER WITH ADMIN OPTION') AS "adminOption",
           (SELECT count(*)::int FROM pg_stat_activity a WHERE a.usesysid = r.oid) AS sessions
      FROM pg_roles r WHERE starts_with(r.rolname, $1) ORDER BY r.rolname`, [prefix])).rows
    .map((role) => ({ ...role, kind: kindOf(role.name) }));
  const oids = roles.map((role) => role.oid);
  const memberships = (await client.query(`
    SELECT roleid::regrole::text AS role, member::regrole::text AS member, grantor::regrole::text AS grantor,
           admin_option AS admin, inherit_option AS inherit, set_option AS set
      FROM pg_auth_members WHERE roleid = ANY($1::oid[]) OR member = ANY($1::oid[]) OR grantor = ANY($1::oid[])
     ORDER BY 1, 2, 3`, [oids])).rows;
  const grants = (await client.query(`
    SELECT * FROM (
      SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'relation' END AS kind, c.oid::regclass::text AS object,
             '' AS "column", a.grantee::regrole::text AS grantee, a.grantor::regrole::text AS grantor, a.privilege_type AS privilege
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee = ANY($1::oid[])
      UNION ALL
      SELECT 'column', c.oid::regclass::text, t.attname::text, a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type
        FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid CROSS JOIN LATERAL aclexplode(t.attacl) a
       WHERE a.grantee = ANY($1::oid[])
      UNION ALL
      SELECT 'routine', p.oid::regprocedure::text, '', a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE a.grantee = ANY($1::oid[])
      UNION ALL
      SELECT 'schema', quote_ident(n.nspname), '', a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee = ANY($1::oid[])
      UNION ALL
      SELECT 'database', quote_ident(d.datname), '', a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type
        FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE a.grantee = ANY($1::oid[])
    ) entries ORDER BY 1, 2, 3, 4, 5, 6`, [oids])).rows;
  const dependencies = (await client.query(`
    SELECT r.rolname::text AS role, d.dbid::int AS dbid, d.classid::regclass::text AS class, d.deptype::text AS type,
           count(*)::int AS count
      FROM pg_shdepend d JOIN pg_roles r ON r.oid = d.refobjid
     WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = ANY($1::oid[])
     GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`, [oids])).rows;
  // Role names written as text (pg_has_role, session_user comparisons) are invisible to
  // pg_shdepend; dropping a role they name would break every login that evaluates them.
  const references = (await client.query(`
    SELECT (SELECT count(*)::int FROM pg_policy p
             WHERE concat(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) LIKE '%' || $1 || '%')
         + (SELECT count(*)::int FROM pg_proc p WHERE p.prosrc LIKE '%' || $1 || '%')
         + (SELECT count(*)::int FROM pg_class c WHERE c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) LIKE '%' || $1 || '%')
         AS count`, [prefix])).rows[0].count;
  const defaults = (await client.query(`
    SELECT count(*)::int AS count FROM pg_default_acl d
     WHERE d.defaclrole = ANY($1::oid[])
        OR EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = ANY($1::oid[]))`, [oids])).rows[0].count;
  return { identity, roles, memberships, grants, dependencies, references, defaults };
};

const blockersFor = (step, state) => {
  const blockers = [];
  const { roles, memberships, grants, dependencies, references, defaults } = state;
  if (roles.some((role) => role.kind === "unexpected")) blockers.push("hotel_setup_roles_unexpected_name");
  if (roles.some((role) => role.elevated || (role.kind === "parent" && role.canLogin)))
    blockers.push("hotel_setup_roles_attributes_unexpected");
  if (memberships.some((edge) => roles.some((role) => role.name === edge.grantor)))
    blockers.push("hotel_setup_roles_grant_memberships");
  if (step === "disable") {
    if (roles.some((role) => role.canLogin && !role.adminOption)) blockers.push("hotel_setup_roles_admin_option_missing");
  } else {
    if (roles.length === 0) blockers.push("hotel_setup_roles_already_retired");
    if (roles.some((role) => !role.adminOption)) blockers.push("hotel_setup_roles_admin_option_missing");
    if (roles.some((role) => role.canLogin)) blockers.push("hotel_setup_roles_still_login");
    if (roles.some((role) => role.sessions > 0)) blockers.push("hotel_setup_roles_sessions_active");
    if (grants.length || dependencies.length || defaults) blockers.push("hotel_setup_roles_dependencies_remaining");
    if (references) blockers.push("hotel_setup_roles_still_referenced");
  }
  return blockers;
};

const summarize = (step, state) => ({
  roles: state.roles.map(({ name, kind, canLogin, sessions }) => ({ name, kind, canLogin, sessions })),
  adminGrants: state.grants.filter((grant) => grant.grantor === admin).length,
  otherGrants: state.grants.filter((grant) => grant.grantor !== admin).length,
  dependencies: state.dependencies.reduce((total, row) => total + row.count, 0),
  references: state.references,
  blockers: blockersFor(step, state),
});

const revokeStatement = ({ kind, object, column, grantee }) => {
  if (kind === "relation") return `REVOKE ALL ON TABLE ${object} FROM ${quote(grantee)}`;
  if (kind === "sequence") return `REVOKE ALL ON SEQUENCE ${object} FROM ${quote(grantee)}`;
  if (kind === "column") return `REVOKE ALL (${quote(column)}) ON TABLE ${object} FROM ${quote(grantee)}`;
  if (kind === "routine") return `REVOKE ALL ON ROUTINE ${object} FROM ${quote(grantee)}`;
  if (kind === "schema") return `REVOKE ALL ON SCHEMA ${object} FROM ${quote(grantee)}`;
  return `REVOKE ALL ON DATABASE ${object} FROM ${quote(grantee)}`;
};

const step = process.env.VAYADA_HOTEL_SETUP_ROLES_STEP;
const phase = process.env.VAYADA_HOTEL_SETUP_ROLES_PHASE;
const frozen = process.env.VAYADA_HOTEL_SETUP_ROLES_FROZEN || undefined;
let client;
let locked = false;
let commitAttempted = false;
let committed = false;
let stage = "configuration";
try {
  if (!["disable", "drop"].includes(step) || !["inspect", "apply"].includes(phase) ||
      (phase === "inspect" ? frozen !== undefined : !/^[a-f0-9]{64}$/.test(frozen ?? "")))
    fail("hotel_setup_roles_arguments_invalid");
  const url = new URL(process.env.TARGET_DATABASE_ADMIN_URL ?? "");
  const local = process.env.VAYADA_HOTEL_SETUP_ROLES_LOCAL_FIXTURE === "1" && url.hostname === localHost;
  if (local ? (url.protocol !== "postgresql:" || url.username !== admin || !url.password || url.hash || url.search)
      : (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main" ||
         url.protocol !== "postgresql:" || url.hostname !== expectedHost || url.port !== "5432" ||
         url.pathname !== "/postgres" || url.username !== admin || !url.password || url.hash ||
         url.search !== "?sslmode=require" || !process.env.VAYADA_DB_RDS_CA_BUNDLE))
    fail("hotel_setup_roles_endpoint_untrusted");
  client = new pg.Client({
    host: url.hostname, port: Number(url.port || 5432), database, user: admin,
    password: decodeURIComponent(url.password),
    ssl: local ? undefined : { ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname },
    connectionTimeoutMillis: 10_000, query_timeout: 20_000,
  });
  client.on("error", () => {});
  // A REVOKE that revokes nothing, or a GRANT that grants nothing, is a drifted plan: refuse it.
  let drift = false;
  client.on("notice", (notice) => { if (["01006", "01007"].includes(notice.code)) drift = true; });
  stage = "connect";
  await client.connect();
  stage = "lock";
  if ((await client.query("SELECT pg_try_advisory_lock($1) AS held", [lockKey])).rows[0]?.held !== true)
    fail("hotel_setup_roles_busy");
  locked = true;
  await client.query(phase === "inspect" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
  await client.query("SET LOCAL search_path TO pg_catalog; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'");
  stage = "capture";
  const before = await capture(client);
  const fingerprint = hash({ scope, version, step, state: before });
  const plan = summarize(step, before);
  if (phase === "inspect") {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ status: "PLAN", scope, step, phase, fingerprint, ready: plan.blockers.length === 0, ...plan }));
  } else {
    if (frozen !== fingerprint) fail("hotel_setup_roles_plan_changed");
    if (plan.blockers.length) fail(plan.blockers[0]);
    if (step === "disable") {
      stage = "nologin";
      for (const role of before.roles.filter((role) => role.canLogin))
        await client.query(`ALTER ROLE ${quote(role.name)} NOLOGIN`);
      stage = "revoke";
      for (const grant of before.grants.filter((grant) => grant.grantor === admin))
        await client.query(revokeStatement(grant));
      if (drift) fail("hotel_setup_roles_revoke_drift");
      stage = "readback";
      const after = await capture(client);
      if (after.roles.length !== before.roles.length || after.roles.some((role) => role.canLogin) ||
          after.grants.some((grant) => grant.grantor === admin) ||
          JSON.stringify(after.memberships) !== JSON.stringify(before.memberships))
        fail("hotel_setup_roles_readback_failed");
    } else {
      stage = "drop";
      for (const kind of ["login", "reader", "parent"])
        for (const role of before.roles.filter((role) => role.kind === kind))
          await client.query(`DROP ROLE ${quote(role.name)}`);
    }
    stage = "commit";
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    if (step === "disable") {
      // NOLOGIN only stops new sessions; end the existing ones after the commit.
      stage = "terminate";
      const oids = before.roles.map((role) => role.oid);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const remaining = (await client.query(
          "SELECT pid FROM pg_stat_activity WHERE usesysid = ANY($1::oid[])", [oids])).rows;
        if (remaining.length === 0) break;
        for (const { pid } of remaining) await client.query("SELECT pg_terminate_backend($1, 5000)", [pid]);
      }
    }
    stage = "verify";
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL search_path TO pg_catalog");
    const verified = await capture(client);
    await client.query("ROLLBACK");
    if (step === "disable"
      ? verified.roles.some((role) => role.canLogin || role.sessions > 0) ||
        verified.grants.some((grant) => grant.grantor === admin)
      : verified.roles.length !== 0)
      fail("hotel_setup_roles_verification_failed");
    console.log(JSON.stringify({ status: "PASS", scope, step, phase, fingerprint, ...summarize(step, verified) }));
  }
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const code = error?.retirementCode ?? "hotel_setup_roles_unavailable";
  console.error(JSON.stringify({
    status: committed ? "COMMITTED_UNVERIFIED" : commitAttempted ? "UNCERTAIN" : "FAIL",
    scope, step, phase, code, stage, sqlState: /^[A-Z0-9]{5}$/.test(error?.code ?? "") ? error.code : null,
  }));
  process.exitCode = 1;
} finally {
  if (locked) await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => undefined);
  await client?.end().catch(() => undefined);
}
