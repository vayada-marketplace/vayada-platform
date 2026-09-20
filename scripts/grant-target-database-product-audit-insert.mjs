import pg from "pg";

const connectionString = process.env.TARGET_DATABASE_MIGRATION_URL;
if (!connectionString) throw new Error("migration_url_missing");

const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});

try {
  await client.connect();
  const role = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'vayada_next_api_runtime'",
  );
  if (role.rowCount !== 1) throw new Error("runtime_role_missing");
  const check = await client.query(`
    SELECT current_user = pg_get_userbyid(table_info.relowner) AS is_table_owner,
           has_table_privilege('vayada_next_api_runtime',
             'platform.product_audit_events', 'UPDATE') AS can_update,
           has_table_privilege('vayada_next_api_runtime',
             'platform.product_audit_events', 'DELETE') AS can_delete
      FROM pg_class AS table_info
     WHERE table_info.oid = to_regclass('platform.product_audit_events')
  `);
  if (check.rowCount !== 1 || !check.rows[0].is_table_owner)
    throw new Error("audit_table_owner_required");
  if (check.rows[0].can_update || check.rows[0].can_delete)
    throw new Error("audit_runtime_write_scope_too_broad");

  await client.query(
    "GRANT INSERT ON platform.product_audit_events TO vayada_next_api_runtime",
  );
  const granted = await client.query(`
    SELECT has_table_privilege('vayada_next_api_runtime',
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
  ]);
  const code = expected.has(error.message) ? error.message : error.code ?? "audit_grant_failed";
  console.error(JSON.stringify({ status: "FAIL", code }));
  process.exitCode = 1;
} finally {
  await client.end();
}
