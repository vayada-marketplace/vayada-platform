import pg from "pg";

async function assertAuditWriteScope(client, supportsMaintain) {
  const prohibitedTablePrivileges = [
    "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES",
    ...(supportsMaintain ? ["MAINTAIN"] : []),
  ];
  const violations = await client.query(`
    SELECT privilege.name
      FROM unnest($1::text[]) AS privilege(name)
     WHERE pg_catalog.has_table_privilege(
       'vayada_next_api_runtime', 'platform.product_audit_events', privilege.name
     )
    UNION ALL
    SELECT attribute.attname || ':' || privilege.name
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN (VALUES ('UPDATE'), ('REFERENCES')) AS privilege(name)
     WHERE attribute.attrelid = 'platform.product_audit_events'::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege(
         'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
       )
  `, [prohibitedTablePrivileges]);
  if (violations.rowCount !== 0) throw new Error("audit_runtime_write_scope_too_broad");
}

let client;
try {
  const connectionString = process.env.TARGET_DATABASE_MIGRATION_URL;
  if (!connectionString) throw new Error("migration_url_missing");
  const connectionUrl = new URL(connectionString);
  const parameters = [...connectionUrl.searchParams.entries()];
  const localFixture = process.env.VAYADA_AUDIT_GRANT_LOCAL_FIXTURE === "1" &&
    connectionUrl.hostname === "vayada-db-preflight" && parameters.length === 0;
  let ssl;
  if (!localFixture) {
    if (connectionUrl.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" ||
        connectionUrl.port !== "5432")
      throw new Error("unexpected_database_host");
    if (connectionUrl.searchParams.get("sslmode") !== "require")
      throw new Error("rds_ssl_required");
    if (parameters.length !== 1 || parameters[0][0] !== "sslmode")
      throw new Error("unsupported_connection_parameters");
    const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
    if (!ca) throw new Error("rds_ca_missing");
    connectionUrl.searchParams.delete("sslmode");
    ssl = { ca, rejectUnauthorized: true, servername: connectionUrl.hostname };
  }

  client = new pg.Client({
    connectionString: connectionUrl.toString(),
    ssl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });

  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const version = await client.query(
    "SELECT pg_catalog.current_setting('server_version_num')::integer AS value",
  );
  const supportsMaintain = version.rows[0].value >= 170000;
  const role = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'vayada_next_api_runtime'",
  );
  if (role.rowCount !== 1) throw new Error("runtime_role_missing");
  const check = await client.query(`
    SELECT current_user = pg_catalog.pg_get_userbyid(table_info.relowner) AS is_table_owner
      FROM pg_catalog.pg_class AS table_info
     WHERE table_info.oid = pg_catalog.to_regclass('platform.product_audit_events')
  `);
  if (check.rowCount !== 1 || !check.rows[0].is_table_owner)
    throw new Error("audit_table_owner_required");
  await assertAuditWriteScope(client, supportsMaintain);

  await client.query(
    "GRANT INSERT ON platform.product_audit_events TO vayada_next_api_runtime",
  );
  await assertAuditWriteScope(client, supportsMaintain);
  const granted = await client.query(`
    SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime',
      'platform.product_audit_events', 'INSERT') AS can_insert
  `);
  if (!granted.rows[0].can_insert) throw new Error("audit_runtime_insert_missing");
  console.log(JSON.stringify({ status: "PASS", grant: "platform.product_audit_events:INSERT" }));
} catch (error) {
  const expected = new Set([
    "audit_table_owner_required",
    "runtime_role_missing",
    "audit_runtime_write_scope_too_broad",
    "audit_runtime_insert_missing",
    "unexpected_database_host",
    "rds_ca_missing",
    "rds_ssl_required",
    "migration_url_missing",
    "unsupported_connection_parameters",
  ]);
  const code = expected.has(error.message) ? error.message : error.code ?? "audit_grant_failed";
  console.error(JSON.stringify({ status: "FAIL", code }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
