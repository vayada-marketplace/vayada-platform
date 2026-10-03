import pg from "pg";

const role = "vayada_next_api_runtime";
const privileges = {
  "hotel_catalog.organization_setup_track_intents": {
    INSERT: ["organization_id", "selected_tracks", "revision"],
    UPDATE: ["selected_tracks", "revision", "updated_at"],
  },
  "identity.product_entitlements": {
    INSERT: ["organization_id", "product", "entitlement_key", "status", "starts_at", "expires_at", "metadata"],
    UPDATE: ["status", "starts_at", "expires_at", "updated_at"],
  },
  "identity.organization_resource_links": {
    INSERT: ["organization_id", "product", "resource_type", "resource_id", "relationship", "status"],
    UPDATE: ["id"],
  },
  "finance.billing_entitlements": { UPDATE: ["id"] },
  "booking.booking_settings": { INSERT: ["property_id"] },
  "marketplace.marketplace_hotel_profiles": {
    INSERT: ["property_id", "organization_id", "source_system", "source_hotel_profile_id"],
    UPDATE: ["property_id"],
  },
};
async function assertScope(client, table, grants, supportsMaintain) {
  const scope = await client.query(`SELECT a.attname, p.name
    FROM pg_attribute a CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) p(name)
    WHERE a.attrelid=to_regclass($2) AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege($1,a.attrelid,a.attname,p.name)`, [role,table]);
  if (scope.rows.some(({attname,name}) => !grants[name]?.includes(attname)))
    throw new Error("setup_runtime_scope_too_broad");
  const unsafe = await client.query(`SELECT name FROM unnest(ARRAY[
    'INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER',
    'SELECT WITH GRANT OPTION'] || $3::text[]) p(name)
    WHERE has_table_privilege($1,$2,name)`,[role,table,supportsMaintain ? ["MAINTAIN"] : []]);
  if (unsafe.rowCount) throw new Error("setup_runtime_scope_too_broad");
  const delegation = await client.query(`SELECT a.attname FROM pg_attribute a
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(name)
    WHERE a.attrelid=to_regclass($2) AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege($1,a.attrelid,a.attname,p.name || ' WITH GRANT OPTION')`,[role,table]);
  if (delegation.rowCount) throw new Error("setup_runtime_scope_too_broad");
}
let client;
try {
  const raw = process.env.TARGET_DATABASE_MIGRATION_URL;
  if (!raw) throw new Error("migration_url_missing");
  const url = new URL(raw);
  const local = process.env.VAYADA_AUDIT_GRANT_LOCAL_FIXTURE === "1" &&
    url.hostname === "vayada-db-preflight" && url.search === "";
  let ssl;
  if (!local) {
    if (url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" || url.port !== "5432")
      throw new Error("unexpected_database_host");
    if (url.search !== "?sslmode=require") throw new Error("rds_ssl_required");
    const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
    if (!ca) throw new Error("rds_ca_missing");
    url.search = "";
    ssl = { ca, rejectUnauthorized: true, servername: url.hostname };
  }
  client = new pg.Client({ connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 15_000 });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL search_path TO pg_catalog");
  await client.query("SET LOCAL lock_timeout = '2s'");
  const runtime = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1
    AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
    AND NOT rolbypassrls AND NOT rolreplication`, [role]);
  if (runtime.rowCount !== 1) throw new Error("setup_runtime_role_unsafe");
  const version = await client.query("SHOW server_version_num");
  const supportsMaintain = Number(version.rows[0].server_version_num) >= 170000;
  for (const [table, grants] of Object.entries(privileges)) {
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    const owner = await client.query(`SELECT current_user = pg_get_userbyid(relowner) AS owner
      FROM pg_class WHERE oid = to_regclass($1) AND relkind IN ('r','p')`, [table]);
    if (owner.rowCount !== 1 || !owner.rows[0].owner)
      throw new Error("setup_table_owner_required");
    await assertScope(client, table, grants, supportsMaintain);
    for (const [privilege, columns] of Object.entries(grants)) {
      await client.query(`GRANT ${privilege} (${columns.join(", ")}) ON ${table} TO ${role}`);
      for (const column of columns) {
        const check = await client.query(`SELECT has_column_privilege($1,$2,$3,$4) AS granted,
          has_column_privilege($1,$2,$3,$4 || ' WITH GRANT OPTION') AS delegated`,
          [role, table, column, privilege]);
        if (!check.rows[0].granted || check.rows[0].delegated)
          throw new Error("setup_column_grant_invalid");
      }
    }
    await assertScope(client, table, grants, supportsMaintain);
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "PASS", grant: "hotel_setup_tracks:columns" }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const expected = new Set(["migration_url_missing", "unexpected_database_host", "rds_ssl_required",
    "rds_ca_missing", "setup_runtime_role_unsafe", "setup_table_owner_required", "setup_column_grant_invalid", "setup_runtime_scope_too_broad"]);
  console.error(JSON.stringify({ status: "FAIL", code: expected.has(error.message) ? error.message : error.code ?? "setup_grant_failed" }));
  process.exitCode = 1;
} finally { await client?.end().catch(() => undefined); }
