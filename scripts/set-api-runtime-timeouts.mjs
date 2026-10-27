// VAY-2247 incident follow-up (Flamur, 2026-10-21): vayada_admin sets two defaults for the API's runtime
// login in vayada_target_prod. lock_timeout 10s: a lock wait gives up and the API answers "busy, try
// again" instead of hanging. idle_in_transaction_session_timeout: a safety net for a connection stuck
// inside an open transaction; 10min at first, 2min since VAY-2297 (Flamur, 2026-10-27) once no app path
// idles in a transaction while it waits on Stripe, Resend or Channex. inspect is read-only and prints the fingerprint of what it captured;
// apply (SET both) and rollback (RESET both) recapture under the same lock, refuse unless that fingerprint
// matches, change the role in one transaction and verify after commit. New sessions pick the defaults up;
// open ones keep theirs until the API's pools reconnect.
import { createHash } from "node:crypto";
import pg from "pg";

const scope = "api_runtime_role_timeouts";
const version = 1;
const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const localHost = "vayada-api-runtime-timeouts-db";
const database = "vayada_target_prod";
const admin = "vayada_admin";
const lockKey = 22472021;
const login = "vayada_next_api_runtime";
const desired = { lock_timeout: "10s", idle_in_transaction_session_timeout: "2min" };
const names = Object.keys(desired);
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code) => {
  const error = new Error(code);
  error.timeoutsCode = code;
  throw error;
};

// "name=value" pairs of pg_db_role_setting, as an object.
const settingsOf = (config) =>
  Object.fromEntries((config ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

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
    fail("api_runtime_timeouts_identity_unexpected");
  const role = (await client.query(`
    SELECT r.rolname::text AS name, r.rolcanlogin AS "canLogin",
           r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS elevated,
           pg_has_role(current_user, r.oid, 'MEMBER WITH ADMIN OPTION') AS "adminOption"
      FROM pg_roles r WHERE r.rolname = $1`, [login])).rows[0] ?? null;
  // This database's defaults win over the role's defaults for every database.
  const rows = (await client.query(`
    SELECT s.setdatabase <> 0 AS here, s.setconfig AS config
      FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
     WHERE r.rolname = $1 AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))`,
    [login])).rows;
  const here = settingsOf(rows.find((row) => row.here)?.config);
  const everywhere = settingsOf(rows.find((row) => !row.here)?.config);
  return { identity, role, here, everywhere };
};

const blockersFor = (state, action) => {
  const { role, here } = state;
  if (!role) return ["api_runtime_timeouts_login_missing"];
  const blockers = [];
  if (role.elevated) blockers.push("api_runtime_timeouts_login_attributes_unexpected");
  if (!role.canLogin) blockers.push("api_runtime_timeouts_login_disabled");
  if (!role.adminOption) blockers.push("api_runtime_timeouts_admin_option_missing");
  if (action === "apply" && names.every((name) => here[name] === desired[name]))
    blockers.push("api_runtime_timeouts_already_applied");
  if (action === "rollback" && names.every((name) => here[name] === undefined))
    blockers.push("api_runtime_timeouts_not_applied");
  return blockers;
};

const summarize = (state, sessions) => ({
  login: state.role ? { name: login, canLogin: state.role.canLogin, adminOption: state.role.adminOption } : null,
  // What this database's defaults are for the two settings now, and what apply would set.
  current: Object.fromEntries(names.map((name) => [name, state.here[name] ?? null])),
  desired,
  // Role-wide defaults for the same settings, which this database's defaults override.
  roleWide: Object.fromEntries(names.map((name) => [name, state.everywhere[name] ?? null])),
  otherDatabaseDefaults: Object.keys(state.here).filter((name) => !names.includes(name)).sort(),
  sessions,
  applyBlockers: blockersFor(state, "apply"),
  rollbackBlockers: blockersFor(state, "rollback"),
});

const phase = process.env.VAYADA_API_RUNTIME_TIMEOUTS_PHASE;
const frozen = process.env.VAYADA_API_RUNTIME_TIMEOUTS_FROZEN || undefined;
let client;
let locked = false;
let commitAttempted = false;
let committed = false;
let stage = "configuration";
try {
  if (!["inspect", "apply", "rollback"].includes(phase) ||
      (phase === "inspect" ? frozen !== undefined : !/^[a-f0-9]{64}$/.test(frozen ?? "")))
    fail("api_runtime_timeouts_arguments_invalid");
  const url = new URL(process.env.TARGET_DATABASE_ADMIN_URL ?? "");
  const local = process.env.VAYADA_API_RUNTIME_TIMEOUTS_LOCAL_FIXTURE === "1" && url.hostname === localHost;
  if (local ? (url.protocol !== "postgresql:" || url.username !== admin || !url.password || url.hash || url.search)
      : (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main" ||
         url.protocol !== "postgresql:" || url.hostname !== expectedHost || url.port !== "5432" ||
         url.pathname !== "/postgres" || url.username !== admin || !url.password || url.hash ||
         url.search !== "?sslmode=require" || !process.env.VAYADA_DB_RDS_CA_BUNDLE))
    fail("api_runtime_timeouts_endpoint_untrusted");
  client = new pg.Client({
    host: url.hostname, port: Number(url.port || 5432), database, user: admin,
    password: decodeURIComponent(url.password),
    ssl: local ? undefined : { ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname },
    connectionTimeoutMillis: 10_000, query_timeout: 20_000,
  });
  client.on("error", () => {});
  stage = "connect";
  await client.connect();
  stage = "lock";
  if ((await client.query("SELECT pg_try_advisory_lock($1) AS held", [lockKey])).rows[0]?.held !== true)
    fail("api_runtime_timeouts_busy");
  locked = true;
  await client.query(phase === "inspect" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
  await client.query("SET LOCAL search_path TO pg_catalog; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'");
  stage = "capture";
  const before = await capture(client);
  // Live sessions change all the time; they are shown, not fingerprinted.
  const sessions = (await client.query(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = $1 AND datname = current_database()",
    [login])).rows[0].count;
  const fingerprint = hash({ scope, version, state: before });
  const plan = summarize(before, sessions);
  if (phase === "inspect") {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({
      status: "PLAN", scope, phase, fingerprint,
      readyToApply: plan.applyBlockers.length === 0, readyToRollback: plan.rollbackBlockers.length === 0, ...plan,
    }));
  } else {
    if (frozen !== fingerprint) fail("api_runtime_timeouts_plan_changed");
    const blockers = phase === "apply" ? plan.applyBlockers : plan.rollbackBlockers;
    if (blockers.length) fail(blockers[0]);
    stage = phase;
    const target = `ALTER ROLE ${quote(login)} IN DATABASE ${quote(database)}`;
    for (const name of names)
      await client.query(phase === "apply" ? `${target} SET ${name} = '${desired[name]}'` : `${target} RESET ${name}`);
    stage = "commit";
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    stage = "verify";
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL search_path TO pg_catalog");
    const verified = await capture(client);
    await client.query("ROLLBACK");
    const ok = names.every((name) =>
      phase === "apply" ? verified.here[name] === desired[name] : verified.here[name] === undefined);
    if (!ok) fail("api_runtime_timeouts_verification_failed");
    console.log(JSON.stringify({ status: "PASS", scope, phase, fingerprint, ...summarize(verified, sessions),
      note: "New sessions of the login use these defaults; open ones keep theirs until they reconnect." }));
  }
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const code = error?.timeoutsCode ??
    (error?.code === "42501" ? "api_runtime_timeouts_permission_denied" : "api_runtime_timeouts_unavailable");
  console.error(JSON.stringify({
    status: committed ? "COMMITTED_UNVERIFIED" : commitAttempted ? "UNCERTAIN" : "FAIL",
    scope, phase, code, stage, sqlState: /^[A-Z0-9]{5}$/.test(error?.code ?? "") ? error.code : null,
  }));
  process.exitCode = 1;
} finally {
  if (locked) await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => undefined);
  await client?.end().catch(() => undefined);
}
