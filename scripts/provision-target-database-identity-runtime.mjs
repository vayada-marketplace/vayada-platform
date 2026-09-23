import pg from "pg";
import { randomUUID } from "node:crypto";

const scope = process.env.VAYADA_DB_PROVISION_SCOPE ?? "";
const worker = new Map([
  ["finance_expense", {
    role: "vayada_next_finance_expense_worker",
    secret: "FINANCE_EXPENSE_WORKER_DATABASE_URL",
  }],
  ["finance_export", {
    role: "vayada_next_finance_export_worker",
    secret: "FINANCE_EXPORT_WORKER_DATABASE_URL",
  }],
  ["channex_management", {
    role: "vayada_next_channex_management_worker",
    secret: "PMS_CHANNEX_MANAGEMENT_DATABASE_URL",
  }],
]).get(scope);
const role = worker?.role ?? "vayada_next_identity_runtime";
const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
let client;
let provisionAttempted = false;
const provisionMarker = `vayada:identity-provision:${randomUUID()}`;
let adminConnectionString;
let adminSsl;
const safeCleanup = async () => {
  const account = await client.query(`
    SELECT oid, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit,
           rolbypassrls, rolreplication,
           pg_catalog.shobj_description(oid, 'pg_authid') AS marker
      FROM pg_catalog.pg_roles WHERE rolname = $1
  `, [role]);
  if (!account.rowCount) return;
  const attributes = account.rows[0];
  if (!attributes.rolcanlogin || attributes.rolsuper || attributes.rolcreaterole ||
      attributes.rolcreatedb || attributes.rolinherit || attributes.rolbypassrls ||
      attributes.rolreplication || attributes.marker !== provisionMarker)
    throw new Error("identity_provision_cleanup_unsafe");
  const dependencies = await client.query(`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
                    WHERE member = $1 OR roleid = $1) AS membership,
           EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
                    WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                      AND refobjid = $1 AND deptype = 'o') AS ownership
  `, [attributes.oid]);
  if (dependencies.rows[0].membership || dependencies.rows[0].ownership)
    throw new Error("identity_provision_cleanup_unsafe");
  await client.query("BEGIN");
  await client.query(`DO $cleanup$
    BEGIN
      EXECUTE pg_catalog.format('REVOKE CONNECT ON DATABASE %I FROM ${role}',
        pg_catalog.current_database());
      DROP ROLE ${role};
    END $cleanup$`);
  await client.query("COMMIT");
};
try {
  if (scope && !worker) throw new Error("identity_provision_scope_invalid");
  const ownerRaw = process.env.TARGET_DATABASE_ADMIN_URL;
  const identityRaw = process.env[worker?.secret ?? "IDENTITY_DATABASE_URL"];
  if (!ownerRaw || !identityRaw) throw new Error("identity_provision_secrets_missing");
  const owner = new URL(ownerRaw);
  const identity = new URL(identityRaw);
  const local = process.env.VAYADA_IDENTITY_PROVISION_LOCAL_FIXTURE === "1" &&
    owner.hostname === "vayada-identity-grant-db" && owner.search === "";
  if (!local && (owner.protocol !== "postgresql:" || owner.hostname !== expectedHost ||
      owner.port !== "5432" || owner.pathname !== "/postgres" ||
      owner.username !== "vayada_admin" || !owner.password || owner.hash ||
      owner.search !== "?sslmode=require" || !process.env.VAYADA_DB_RDS_CA_BUNDLE))
    throw new Error("identity_provision_owner_endpoint_untrusted");
  if (identity.hostname !== owner.hostname || identity.port !== owner.port ||
      (!local && identity.pathname !== "/vayada_target_prod") ||
      (local && identity.pathname !== owner.pathname) || identity.search !== owner.search ||
      identity.username !== role || !identity.password || identity.hash ||
      identity.protocol !== "postgresql:")
    throw new Error("identity_provision_url_untrusted");
  const ssl = local ? undefined : {
    ca: process.env.VAYADA_DB_RDS_CA_BUNDLE,
    rejectUnauthorized: true,
    servername: owner.hostname,
  };
  owner.pathname = identity.pathname;
  owner.search = "";
  identity.search = "";
  adminConnectionString = owner.toString();
  adminSsl = ssl;
  client = new pg.Client({ connectionString: adminConnectionString, ssl: adminSsl,
    connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const publicDatabaseAccess = await client.query(`
    SELECT d.datname, a.privilege_type
      FROM pg_catalog.pg_database d
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
     WHERE d.datallowconn AND a.grantee = 0
       AND ((d.datname = pg_catalog.current_database()
             AND a.privilege_type IN ('CREATE', 'TEMPORARY'))
         OR (d.datname <> pg_catalog.current_database()
             AND a.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')))
  `);
  if (publicDatabaseAccess.rowCount) throw new Error("identity_provision_cluster_database_acl_unsafe");
  await client.query("BEGIN");
  const existing = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role]);
  if (existing.rowCount) throw new Error("identity_provision_role_already_exists");
  // Parameter binding keeps the credential out of the SQL text and task logs.
  await client.query("SELECT pg_catalog.set_config('vayada.identity_password', $1, true)",
    [decodeURIComponent(identity.password)]);
  await client.query("SELECT pg_catalog.set_config('vayada.identity_provision_marker', $1, true)",
    [provisionMarker]);
  provisionAttempted = true;
  await client.query(`DO $provision$
    BEGIN
      EXECUTE pg_catalog.format(
        'CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        pg_catalog.current_setting('vayada.identity_password')
      );
      EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO ${role}',
        pg_catalog.current_database());
      EXECUTE pg_catalog.format('COMMENT ON ROLE ${role} IS %L',
        pg_catalog.current_setting('vayada.identity_provision_marker'));
    END $provision$`);
  await client.query("COMMIT");
  const login = new pg.Client({ connectionString: identity.toString(), ssl,
    connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  try {
    if (local && process.env.VAYADA_IDENTITY_PROVISION_FORCE_MARKER_MISMATCH === "1") {
      await client.query(`COMMENT ON ROLE ${role} IS 'different-invocation'`);
      throw new Error("identity_provision_login_unexpected");
    }
    if (local && process.env.VAYADA_IDENTITY_PROVISION_FORCE_LOGIN_FAILURE === "1")
      throw new Error("identity_provision_login_unexpected");
    await login.connect();
    const result = await login.query("SELECT current_user = $1 AS correct_role", [role]);
    if (!result.rows[0]?.correct_role) throw new Error("identity_provision_login_unexpected");
  } finally {
    await login.end().catch(() => undefined);
  }
  console.log(JSON.stringify({ status: "PASS", role }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  if (provisionAttempted) {
    try {
      await client?.end().catch(() => undefined);
      client = new pg.Client({ connectionString: adminConnectionString, ssl: adminSsl,
        connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
      await client.connect();
      await client.query("SET search_path TO pg_catalog");
      await safeCleanup();
    } catch {
      error = new Error("identity_provision_cleanup_failed");
    }
  }
  const expected = new Set([
    "identity_provision_scope_invalid", "identity_provision_secrets_missing", "identity_provision_owner_endpoint_untrusted",
    "identity_provision_url_untrusted", "identity_provision_role_already_exists",
    "identity_provision_login_unexpected", "identity_provision_cluster_database_acl_unsafe",
    "identity_provision_cleanup_failed",
  ]);
  console.error(JSON.stringify({ status: "FAIL",
    code: expected.has(error.message) ? error.message : error.code ?? "identity_provision_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
