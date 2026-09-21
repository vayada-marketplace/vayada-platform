import pg from "pg";

const role = "vayada_next_identity_runtime";
const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
let client;
try {
  const ownerRaw = process.env.TARGET_DATABASE_MIGRATION_URL;
  const identityRaw = process.env.IDENTITY_DATABASE_URL;
  if (!ownerRaw || !identityRaw) throw new Error("identity_provision_secrets_missing");
  const owner = new URL(ownerRaw);
  const identity = new URL(identityRaw);
  const local = process.env.VAYADA_IDENTITY_PROVISION_LOCAL_FIXTURE === "1" &&
    owner.hostname === "vayada-identity-grant-db" && owner.search === "";
  if (!local && (owner.hostname !== expectedHost || owner.port !== "5432" ||
      owner.search !== "?sslmode=require" || !process.env.VAYADA_DB_RDS_CA_BUNDLE))
    throw new Error("identity_provision_owner_endpoint_untrusted");
  if (identity.hostname !== owner.hostname || identity.port !== owner.port ||
      identity.pathname !== owner.pathname || identity.search !== owner.search ||
      identity.username !== role || !identity.password || identity.hash ||
      identity.protocol !== "postgresql:")
    throw new Error("identity_provision_url_untrusted");
  const ssl = local ? undefined : {
    ca: process.env.VAYADA_DB_RDS_CA_BUNDLE,
    rejectUnauthorized: true,
    servername: owner.hostname,
  };
  owner.search = "";
  identity.search = "";
  client = new pg.Client({ connectionString: owner.toString(), ssl,
    connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  await client.query("BEGIN");
  const existing = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role]);
  if (existing.rowCount) throw new Error("identity_provision_role_already_exists");
  // Parameter binding keeps the credential out of the SQL text and task logs.
  await client.query("SELECT pg_catalog.set_config('vayada.identity_password', $1, true)",
    [decodeURIComponent(identity.password)]);
  await client.query(`DO $provision$
    BEGIN
      EXECUTE pg_catalog.format(
        'CREATE ROLE vayada_next_identity_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        pg_catalog.current_setting('vayada.identity_password')
      );
      EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO vayada_next_identity_runtime',
        pg_catalog.current_database());
    END $provision$`);
  await client.query("COMMIT");
  const login = new pg.Client({ connectionString: identity.toString(), ssl,
    connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  try {
    await login.connect();
    const result = await login.query("SELECT current_user = $1 AS correct_role", [role]);
    if (!result.rows[0]?.correct_role) throw new Error("identity_provision_login_unexpected");
  } finally {
    await login.end().catch(() => undefined);
  }
  console.log(JSON.stringify({ status: "PASS", role }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const expected = new Set([
    "identity_provision_secrets_missing", "identity_provision_owner_endpoint_untrusted",
    "identity_provision_url_untrusted", "identity_provision_role_already_exists",
    "identity_provision_login_unexpected",
  ]);
  console.error(JSON.stringify({ status: "FAIL",
    code: expected.has(error.message) ? error.message : error.code ?? "identity_provision_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
