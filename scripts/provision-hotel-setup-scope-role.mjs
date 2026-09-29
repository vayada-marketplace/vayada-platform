import pg from "pg";

const role = "vayada_next_hotel_setup_scope";
const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
let client;
try {
  const raw = process.env.TARGET_DATABASE_ADMIN_URL;
  const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
  if (!raw) throw new Error("hotel_setup_scope_admin_url_missing");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:")
    throw new Error("hotel_setup_scope_admin_endpoint_untrusted");
  const local = process.env.VAYADA_HOTEL_SETUP_SCOPE_LOCAL_FIXTURE === "1" &&
    ["vayada-db-preflight", "127.0.0.1"].includes(url.hostname) && url.pathname === "/postgres" &&
    ["postgres", "hotel_setup_provision_admin", "legacy_owner"].includes(url.username) &&
    url.search === "";
  if (!local && (url.hostname !== expectedHost ||
      url.port !== "5432" || url.pathname !== "/postgres" ||
      url.username !== "vayada_admin" || !url.password || url.hash ||
      url.search !== "?sslmode=require" || !ca))
    throw new Error("hotel_setup_scope_admin_endpoint_untrusted");
  if (local && (!url.password || url.port !== "5432" || url.hash))
    throw new Error("hotel_setup_scope_admin_endpoint_untrusted");
  const ssl = local ? undefined : { ca, rejectUnauthorized: true, servername: url.hostname };
  if (!local) url.pathname = "/vayada_target_prod";
  url.search = "";
  client = new pg.Client({ connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const admin = (await client.query(
    "SELECT rolcreaterole OR rolsuper AS can_create_role FROM pg_catalog.pg_roles WHERE rolname = current_user",
  )).rows[0];
  if (!admin?.can_create_role) throw new Error("hotel_setup_scope_admin_privilege_missing");
  await client.query("BEGIN");
  const existing = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role]);
  if (!existing.rowCount)
    await client.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const attributes = (await client.query(`
    SELECT oid, NOT (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR
      rolinherit OR rolbypassrls OR rolreplication) AS safe
    FROM pg_catalog.pg_roles WHERE rolname = $1`, [role])).rows[0];
  if (!attributes?.safe) throw new Error("hotel_setup_scope_role_unsafe");
  const unsafe = await client.query(`
    SELECT 1 FROM pg_catalog.pg_auth_members
    WHERE (member = $1 OR roleid = $1)
      AND NOT (roleid = $1 AND member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
        AND grantor = 10::oid AND admin_option AND NOT set_option AND NOT inherit_option)
    UNION ALL SELECT 1 FROM pg_catalog.pg_shdepend
      WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND refobjid = $1`, [attributes.oid]);
  if (unsafe.rowCount) throw new Error("hotel_setup_scope_role_unsafe");
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "PASS", role, created: !existing.rowCount }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const known = new Set(["hotel_setup_scope_admin_url_missing",
    "hotel_setup_scope_admin_endpoint_untrusted", "hotel_setup_scope_admin_privilege_missing",
    "hotel_setup_scope_role_unsafe"]);
  console.error(JSON.stringify({ status: "FAIL",
    code: known.has(error.message) ? error.message : error.code ?? "hotel_setup_scope_provision_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
