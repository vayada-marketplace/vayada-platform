// VAY-2259: proves the protected RDS administrator URL logs in, in place of the retired
// legacy Marketplace API's /health/db. Read-only: one connection, one SELECT.
import pg from "pg";

let client;
try {
  const raw = process.env.TARGET_DATABASE_ADMIN_URL;
  const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
  if (!raw || !ca) throw new Error("rds_admin_login_connection_missing");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" || url.username !== "vayada_admin" ||
      url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" ||
      url.port !== "5432" || url.pathname !== "/postgres" || url.search !== "?sslmode=require")
    throw new Error("rds_admin_login_endpoint_untrusted");
  const ssl = { ca, rejectUnauthorized: true, servername: url.hostname };
  url.search = "";
  client = new pg.Client({ connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  await client.connect();
  const result = await client.query("SELECT current_user::text AS user, pg_catalog.pg_is_in_recovery() AS replica");
  if (result.rowCount !== 1 || result.rows[0].user !== "vayada_admin" || result.rows[0].replica)
    throw new Error("rds_admin_login_identity_unexpected");
  console.log(JSON.stringify({ status: "PASS", user: result.rows[0].user }));
} catch (error) {
  const known = new Set(["rds_admin_login_connection_missing", "rds_admin_login_endpoint_untrusted",
    "rds_admin_login_identity_unexpected"]);
  console.error(JSON.stringify({ status: "FAIL",
    code: known.has(error.message) ? error.message : error.code ?? "rds_admin_login_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
