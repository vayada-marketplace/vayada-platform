import pg from "pg";

const tables = [
  "finance.folios",
  "finance.folio_revisions",
  "finance.folio_lines",
  "finance.folio_payment_references",
];

async function assertOwner(client, table) {
  const result = await client.query(`
    SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = pg_catalog.to_regclass($1) AND relation.relkind IN ('r', 'p')
  `, [table]);
  if (result.rowCount !== 1 || !result.rows[0].is_table_owner)
    throw new Error("folio_command_table_owner_required");
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
  const role = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'vayada_next_api_runtime'",
  );
  if (role.rowCount !== 1) throw new Error("runtime_role_missing");
  const version = await client.query(
    "SELECT pg_catalog.current_setting('server_version_num')::integer AS value",
  );
  const prohibited = ["SELECT WITH GRANT OPTION", "INSERT WITH GRANT OPTION",
    "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES",
    ...(version.rows[0].value >= 170000 ? ["MAINTAIN"] : [])];

  for (const table of tables) await assertOwner(client, table);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(`LOCK TABLE ${tables.join(", ")} IN ACCESS EXCLUSIVE MODE`);
    for (const table of tables) {
      await assertOwner(client, table);
      const violations = await client.query(`
        SELECT privilege.name AS violation
          FROM unnest($2::text[]) AS privilege(name)
         WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, privilege.name)
        UNION ALL
        SELECT attribute.attname || ':' || privilege.name
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN (VALUES ('UPDATE'), ('REFERENCES'),
            ('SELECT WITH GRANT OPTION'), ('INSERT WITH GRANT OPTION'),
            ('UPDATE WITH GRANT OPTION')) AS privilege(name)
         WHERE attribute.attrelid = pg_catalog.to_regclass($1)
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
           AND NOT ($1 = 'finance.folios' AND attribute.attname = 'id' AND privilege.name = 'UPDATE')
           AND pg_catalog.has_column_privilege(
             'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
           )
      `, [table, prohibited]);
      if (violations.rowCount !== 0) throw new Error("folio_command_runtime_scope_too_broad");
    }
    await client.query(`GRANT INSERT ON ${tables.join(", ")} TO vayada_next_api_runtime`);
    await client.query("GRANT UPDATE (id) ON finance.folios TO vayada_next_api_runtime");
    for (const table of tables) {
      const granted = await client.query(`
        SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, 'INSERT') AS can_insert
      `, [table]);
      if (!granted.rows[0].can_insert) throw new Error("folio_command_runtime_insert_missing");
    }
    const lock = await client.query(`
      SELECT pg_catalog.has_column_privilege('vayada_next_api_runtime',
        'finance.folios', 'id', 'UPDATE') AS can_lock
    `);
    if (!lock.rows[0].can_lock) throw new Error("folio_command_runtime_lock_missing");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ status: "PASS", grant: "finance.folio_command:INSERT,folios.UPDATE(id)" }));
} catch (error) {
  const expected = new Set([
    "migration_url_missing", "unexpected_database_host", "rds_ssl_required",
    "unsupported_connection_parameters", "rds_ca_missing", "runtime_role_missing",
    "folio_command_table_owner_required", "folio_command_runtime_scope_too_broad",
    "folio_command_runtime_insert_missing", "folio_command_runtime_lock_missing",
  ]);
  const code = expected.has(error.message) ? error.message : error.code ?? "folio_command_grant_failed";
  console.error(JSON.stringify({ status: "FAIL", code }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
