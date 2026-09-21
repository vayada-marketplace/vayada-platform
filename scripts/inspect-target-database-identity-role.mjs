import pg from "pg";

let client;
try {
  const raw = process.env.TARGET_DATABASE_MIGRATION_URL;
  const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
  if (!raw || !ca) throw new Error("identity_inspect_connection_missing");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" ||
      url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" ||
      url.port !== "5432" || url.search !== "?sslmode=require")
    throw new Error("identity_inspect_endpoint_untrusted");
  const ssl = { ca, rejectUnauthorized: true, servername: url.hostname };
  url.search = "";
  client = new pg.Client({ connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const result = await client.query(`
    SELECT (r.rolcreaterole OR r.rolsuper) AS can_create_role,
           pg_catalog.pg_get_userbyid(d.datdba) = current_user AS owns_database,
           pg_catalog.has_database_privilege(current_user, d.oid,
             'CONNECT WITH GRANT OPTION') AS can_grant_connect,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                    WHERE rolname = 'vayada_next_identity_runtime') AS identity_role_exists
      FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_database d ON d.datname = pg_catalog.current_database()
     WHERE r.rolname = current_user
  `);
  if (result.rowCount !== 1) throw new Error("identity_inspect_role_unavailable");
  console.log(JSON.stringify({ status: "PASS", ...result.rows[0] }));
} catch (error) {
  const known = new Set(["identity_inspect_connection_missing", "identity_inspect_endpoint_untrusted",
    "identity_inspect_role_unavailable"]);
  console.error(JSON.stringify({ status: "FAIL",
    code: known.has(error.message) ? error.message : error.code ?? "identity_inspect_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
