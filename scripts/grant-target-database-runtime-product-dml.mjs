// VAY-2054: one owner-checked, idempotent, transactional grant for the ordinary API login.
// Scope "product_dml" applies the reviewed grant set; "revoke_product_dml" restores the
// legacy allowlist. Both re-verify the protected list before committing.
import pg from "pg";

const role = "vayada_next_api_runtime";
const schemas = ["hotel_catalog", "booking", "pms", "marketplace", "distribution", "finance", "platform"];
const receipt = "platform.legacy_owner_bootstrap_receipts";
export const noRead = [
  "platform.hotel_setup_property_scopes", "platform.hotel_setup_creation_scopes",
  "platform.hotel_setup_linked_properties", "platform.hotel_setup_reconciliation_cursors",
  "hotel_catalog.hotel_setup_effective_creation_scopes", "platform.identity_migration_provenance",
  "platform.legacy_historical_binding_transitions", "platform.finance_expense_worker_properties",
  "platform.finance_export_worker_properties", "marketplace.affiliate_click_quota_windows",
  "pms.inventory_coverage_validation_queue",
];
export const noReadPatterns = [
  "^platform\\.(hotel_setup_|identity_migration_|legacy_historical_binding_)",
  "^platform\\..*_worker_properties$", "^hotel_catalog\\.hotel_setup_",
];
export const noWrite = [
  "platform.schema_migrations", "platform.pricing_runtime_property_scopes",
  "platform.channex_management_worker_properties", "platform.legacy_owner_approval_records",
  "platform.legacy_owner_approval_revocations", "booking.pricing_authority_heads",
  "booking.pricing_authority_revisions", "booking.pricing_quotes",
  "booking.pricing_runtime_effective_authority_scopes", "booking.pricing_runtime_effective_property_scopes",
  "marketplace.affiliate_click_occurrences", "booking.affiliate_click_contexts",
  "booking.affiliate_click_admissions", "booking.affiliate_original_booking_bindings",
  "finance.expense_generation_dispatches", "pms.channex_room_availability_attempts",
  "pms.channex_room_availability_receipts", "pms.channex_room_availability_reconciliation_attestations",
  "pms.channex_ari_schedule_sources",
];
export const noWritePatterns = [
  "^platform\\.(production_|source_extraction_|legacy_|channex_adoption_|hotel_setup_|identity_migration_)",
];
export const appendOnly = ["platform.product_audit_events", "platform.domain_events"];
export const noDelete = ["hotel_catalog.properties"];
export const identityLockOnly = [
  "identity.organizations", "identity.users", "identity.organization_memberships",
  "identity.role_permission_grants", "identity.membership_property_assignments", "identity.organization_roles",
];
// VAY-965 setup-track transaction: real column writes, so no lock-only denial.
export const identityColumns = {
  "identity.product_entitlements": {
    INSERT: ["organization_id", "product", "entitlement_key", "status", "starts_at", "expires_at", "metadata"],
    UPDATE: ["status", "starts_at", "expires_at", "updated_at"],
  },
  "identity.organization_resource_links": {
    INSERT: ["organization_id", "product", "resource_type", "resource_id", "relationship", "status"],
    UPDATE: ["id"],
  },
};
// Posture before VAY-2054; restored by the revoke scope.
export const legacyRelations = {
  "booking.guest_bookings": ["INSERT", "UPDATE", "DELETE"], "finance.payments": ["INSERT", "UPDATE"],
  "platform.external_webhook_events": ["INSERT", "UPDATE"], "platform.idempotency_keys": ["INSERT", "UPDATE", "DELETE"],
  "platform.product_audit_events": ["INSERT"], "pms.channel_connections": ["INSERT", "UPDATE"],
  "finance.folios": ["INSERT"], "finance.folio_revisions": ["INSERT"], "finance.folio_lines": ["INSERT"],
  "finance.folio_payment_references": ["INSERT"], "finance.expense_categories": ["INSERT"],
  "finance.expenses": ["INSERT"], "finance.recurring_expense_rules": ["INSERT"],
  "platform.domain_events": ["INSERT"], "platform.jobs": ["INSERT"],
};
export const legacyColumns = {
  ...identityColumns,
  "hotel_catalog.properties": { UPDATE: ["id"] },
  "hotel_catalog.organization_setup_track_intents": {
    INSERT: ["organization_id", "selected_tracks", "revision"], UPDATE: ["selected_tracks", "revision", "updated_at"],
  },
  "finance.billing_entitlements": { UPDATE: ["id"] }, "booking.booking_settings": { INSERT: ["property_id"] },
  "marketplace.marketplace_hotel_profiles": {
    INSERT: ["property_id", "organization_id", "source_system", "source_hotel_profile_id"], UPDATE: ["property_id"],
  },
  "finance.folios": { UPDATE: ["id"] }, "pms.channel_operational_alerts": { UPDATE: ["resolved_at"] },
};
const writePrivileges = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const relationKinds = "('r','p','v','m','f')";

class Failure extends Error {}
const fail = (code) => { throw new Failure(code); };
const ident = (relation) => relation.split(".").map((part) => `"${part.replaceAll('"', '""')}"`).join(".");

async function relations(client, where, parameters = []) {
  const result = await client.query(`
    SELECT namespace.nspname || '.' || relation.relname AS name, relation.relkind AS kind
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE ${where} ORDER BY 1`, parameters);
  return result.rows;
}
const matches = (name, list, patterns) => list.includes(name) || patterns.some((pattern) => new RegExp(pattern).test(name));

async function columnsOf(client, relation) {
  const result = await client.query(
    `SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`, [relation]);
  return result.rows.map((row) => `"${row.attname.replaceAll('"', '""')}"`);
}
async function revokeAllColumns(client, relation, privileges) {
  const columns = await columnsOf(client, relation);
  if (columns.length) await client.query(`REVOKE ${privileges} (${columns.join(",")}) ON ${ident(relation)} FROM ${role}`);
}

async function assertPosture(client) {
  const posture = await client.query(`
    SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication,
           (SELECT count(*) FROM pg_auth_members WHERE member = r.oid) AS memberships
      FROM pg_roles AS r WHERE rolname = $1`, [role]);
  if (posture.rowCount !== 1) fail("runtime_role_missing");
  const r = posture.rows[0];
  if (!r.rolcanlogin || r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolbypassrls || r.rolreplication)
    fail("runtime_role_unsafe");
  if (Number(r.memberships) !== 0) fail("runtime_role_membership_forbidden");
  const owned = await client.query(`
    SELECT 1 FROM pg_namespace WHERE nspname = ANY($1::text[]) AND nspowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
    UNION ALL
    SELECT 1 FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE (namespace.nspname = ANY($1::text[]) OR namespace.nspname || '.' || relation.relname = ANY($2::text[]))
       AND relation.relkind IN ('r','p','v','m','f','S')
       AND relation.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
    [schemas, [...identityLockOnly, ...Object.keys(identityColumns)]]);
  if (owned.rowCount !== 0) fail("runtime_dml_owner_required");
  const found = await client.query(`SELECT count(*) AS n FROM pg_namespace WHERE nspname = ANY($1::text[])`, [schemas]);
  if (Number(found.rows[0].n) !== schemas.length) fail("runtime_dml_schema_missing");
}

// Row locks need UPDATE on one column; use the first primary-key column of each lock table.
async function lockColumns(client) {
  const result = await client.query(`
    SELECT relation.name, attribute.attname
      FROM unnest($1::text[]) AS relation(name)
      JOIN pg_index AS index ON index.indrelid = to_regclass(relation.name) AND index.indisprimary
      JOIN pg_attribute AS attribute ON attribute.attrelid = index.indrelid AND attribute.attnum = index.indkey[0]`,
    [identityLockOnly]);
  if (result.rowCount !== identityLockOnly.length) fail("runtime_identity_lock_column_missing");
  return Object.fromEntries(result.rows.map((row) => [row.name, row.attname]));
}

async function assertIdentityLockOnlyPolicies(client) {
  const missing = await client.query(`
    SELECT relation.name FROM unnest($1::text[]) AS relation(name)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_policy AS policy JOIN pg_class AS table_info ON table_info.oid = policy.polrelid
        WHERE policy.polrelid = to_regclass(relation.name) AND table_info.relrowsecurity
          AND policy.polname = 'api_runtime_lock_only' AND NOT policy.polpermissive AND policy.polcmd = 'w'
          AND pg_get_expr(policy.polwithcheck, policy.polrelid) LIKE '%' || $2 || '%')`,
    [identityLockOnly, role]);
  if (missing.rowCount !== 0) fail("runtime_identity_lock_only_policy_missing");
}

async function applyProductDml(client, supportsMaintain) {
  await assertIdentityLockOnlyPolicies(client);
  const destructive = [...writePrivileges, ...(supportsMaintain ? ["MAINTAIN"] : [])].join(", ");
  for (const schema of schemas) {
    await client.query(`GRANT USAGE ON SCHEMA ${ident(schema)} TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${ident(schema)} TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
  }
  const product = await relations(client, `namespace.nspname = ANY($1::text[]) AND relation.relkind IN ${relationKinds}`, [schemas]);
  for (const { name } of product) {
    const unreadable = matches(name, noRead, noReadPatterns);
    if (unreadable || name === receipt) {
      await client.query(`REVOKE ALL ON ${ident(name)} FROM ${role}`);
      await revokeAllColumns(client, name, "ALL");
    } else if (matches(name, noWrite, noWritePatterns)) {
      await client.query(`REVOKE ${destructive} ON ${ident(name)} FROM ${role}`);
      await revokeAllColumns(client, name, "INSERT, UPDATE, REFERENCES");
    }
  }
  await client.query(`GRANT SELECT (owner_user_ids) ON ${ident(receipt)} TO ${role}`);
  for (const name of appendOnly) {
    await client.query(`REVOKE UPDATE, DELETE ON ${ident(name)} FROM ${role}`);
    await revokeAllColumns(client, name, "UPDATE");
  }
  for (const name of noDelete) await client.query(`REVOKE DELETE ON ${ident(name)} FROM ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA identity TO ${role}`);
  for (const [name, column] of Object.entries(await lockColumns(client)))
    await client.query(`GRANT SELECT, UPDATE ("${column}") ON ${ident(name)} TO ${role}`);
  for (const [name, grants] of Object.entries(identityColumns))
    for (const [privilege, columns] of Object.entries(grants))
      await client.query(`GRANT ${privilege} (${columns.join(", ")}) ON ${ident(name)} TO ${role}`);
  return product.length;
}

async function revokeProductDml(client) {
  for (const schema of schemas) {
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} REVOKE ALL ON TABLES FROM ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} REVOKE ALL ON SEQUENCES FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${ident(schema)} FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${ident(schema)} FROM ${role}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${role}`);
  }
  const product = await relations(client, `namespace.nspname = ANY($1::text[]) AND relation.relkind IN ${relationKinds}`, [schemas]);
  for (const { name } of product) {
    if (matches(name, noRead, noReadPatterns) || name === receipt) {
      await client.query(`REVOKE ALL ON ${ident(name)} FROM ${role}`);
      await revokeAllColumns(client, name, "ALL");
    }
  }
  await client.query(`GRANT SELECT (owner_user_ids) ON ${ident(receipt)} TO ${role}`);
  for (const [name, privileges] of Object.entries(legacyRelations))
    if ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [name])).rows[0].present)
      await client.query(`GRANT ${privileges.join(", ")} ON ${ident(name)} TO ${role}`);
  for (const [name, grants] of Object.entries(legacyColumns))
    if ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [name])).rows[0].present)
      for (const [privilege, columns] of Object.entries(grants))
        await client.query(`GRANT ${privilege} (${columns.join(", ")}) ON ${ident(name)} TO ${role}`);
  for (const [name, column] of Object.entries(await lockColumns(client)))
    await client.query(`REVOKE UPDATE ("${column}") ON ${ident(name)} FROM ${role}`);
  return product.length;
}

async function verify(client, supportsMaintain, scope) {
  const destructive = [...writePrivileges, ...(supportsMaintain ? ["MAINTAIN"] : [])];
  const protectedWrites = await client.query(`
    SELECT namespace.nspname || '.' || relation.relname AS name, privilege.name AS privilege
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest($3::text[]) AS privilege(name)
     WHERE relation.relkind IN ${relationKinds}
       AND (namespace.nspname = ANY($1::text[]) OR namespace.nspname = 'vayada_migration_evidence')
       AND (namespace.nspname || '.' || relation.relname = ANY($2::text[]) OR namespace.nspname = 'vayada_migration_evidence'
            OR namespace.nspname || '.' || relation.relname ~ ANY($4::text[]))
       AND (has_table_privilege($5, relation.oid, privilege.name)
            OR (privilege.name IN ('INSERT','UPDATE','REFERENCES') AND has_any_column_privilege($5, relation.oid, privilege.name)))`,
    [schemas, [...noRead, ...noWrite, receipt], destructive, [...noReadPatterns, ...noWritePatterns], role]);
  if (protectedWrites.rowCount !== 0) fail("runtime_protected_relation_writable");
  const protectedReads = await client.query(`
    SELECT namespace.nspname || '.' || relation.relname AS name
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE relation.relkind IN ${relationKinds}
       AND (namespace.nspname || '.' || relation.relname = ANY($1::text[]) OR namespace.nspname = 'vayada_migration_evidence'
            OR namespace.nspname || '.' || relation.relname ~ ANY($2::text[]))
       AND has_any_column_privilege($3, relation.oid, 'SELECT')`, [noRead, noReadPatterns, role]);
  if (protectedReads.rowCount !== 0) fail("runtime_protected_relation_readable");
  const receiptColumns = await client.query(`
    SELECT attname FROM pg_attribute CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS privilege(name)
     WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped
       AND NOT (attname = 'owner_user_ids' AND privilege.name = 'SELECT')
       AND has_column_privilege($2, attrelid, attname, privilege.name)
    UNION ALL SELECT 'table' WHERE has_table_privilege($2, to_regclass($1), 'SELECT')
    UNION ALL SELECT 'owner_user_ids' WHERE NOT has_column_privilege($2, to_regclass($1), 'owner_user_ids', 'SELECT')`,
    [receipt, role]);
  if (receiptColumns.rowCount !== 0) fail("runtime_receipt_scope_invalid");
  const grantOptions = await client.query(`
    SELECT namespace.nspname || '.' || relation.relname AS name
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege(name)
     WHERE relation.relkind IN ${relationKinds} AND namespace.nspname NOT IN ('pg_catalog','information_schema')
       AND (has_table_privilege($1, relation.oid, privilege.name || ' WITH GRANT OPTION')
            OR (privilege.name <> 'DELETE' AND has_any_column_privilege($1, relation.oid, privilege.name || ' WITH GRANT OPTION')))`, [role]);
  if (grantOptions.rowCount !== 0) fail("runtime_grant_option_forbidden");
  const identityWrites = await client.query(`
    SELECT relation.relname, attribute.attname, privilege.name
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
      CROSS JOIN unnest(ARRAY['INSERT','UPDATE','REFERENCES']) AS privilege(name)
      LEFT JOIN jsonb_each($2::jsonb) AS allowed(relation, privileges) ON allowed.relation = 'identity.' || relation.relname
     WHERE namespace.nspname = 'identity' AND relation.relkind IN ${relationKinds}
       AND has_column_privilege($1, relation.oid, attribute.attname, privilege.name)
       AND NOT coalesce(allowed.privileges -> privilege.name ? attribute.attname, false)
    UNION ALL
    SELECT relation.relname, NULL, privilege.name
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest($3::text[]) AS privilege(name)
     WHERE namespace.nspname = 'identity' AND relation.relkind IN ${relationKinds}
       AND has_table_privilege($1, relation.oid, privilege.name)`,
    [role, JSON.stringify(scope === "product_dml"
      ? { ...identityColumns, ...Object.fromEntries(Object.entries(await lockColumns(client)).map(([name, column]) => [name, { UPDATE: [column] }])) }
      : identityColumns), destructive]);
  if (identityWrites.rowCount !== 0) fail("runtime_identity_write_scope_too_broad");
  const sequences = await client.query(`
    SELECT relation.relname FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE relation.relkind = 'S' AND namespace.nspname NOT IN ('pg_catalog','information_schema')
       AND (has_sequence_privilege($1, relation.oid, 'UPDATE')
            OR (NOT namespace.nspname = ANY($2::text[]) AND has_sequence_privilege($1, relation.oid, 'USAGE')))`, [role, schemas]);
  if (sequences.rowCount !== 0) fail("runtime_sequence_scope_too_broad");
  if (scope !== "product_dml") return;
  const missing = await client.query(`
    SELECT namespace.nspname || '.' || relation.relname AS name, privilege.name AS privilege
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege(name)
     WHERE namespace.nspname = ANY($1::text[]) AND relation.relkind IN ${relationKinds}
       AND NOT (namespace.nspname || '.' || relation.relname = ANY($2::text[]) OR namespace.nspname || '.' || relation.relname ~ ANY($3::text[]))
       AND NOT (privilege.name IN ('UPDATE','DELETE') AND namespace.nspname || '.' || relation.relname = ANY($5::text[]))
       AND NOT (privilege.name = 'DELETE' AND namespace.nspname || '.' || relation.relname = ANY($6::text[]))
       AND NOT has_table_privilege($4, relation.oid, privilege.name)`,
    [schemas, [...noRead, ...noWrite, receipt], [...noReadPatterns, ...noWritePatterns], role, appendOnly, noDelete]);
  if (missing.rowCount !== 0) fail(`runtime_product_dml_missing:${missing.rowCount}`);
  const narrowed = await client.query(`
    SELECT name FROM unnest($1::text[]) AS relation(name)
     WHERE has_table_privilege($3, to_regclass(name), 'UPDATE') OR has_table_privilege($3, to_regclass(name), 'DELETE')
        OR has_any_column_privilege($3, to_regclass(name), 'UPDATE')
    UNION ALL SELECT name FROM unnest($2::text[]) AS relation(name) WHERE has_table_privilege($3, to_regclass(name), 'DELETE')`,
    [appendOnly, noDelete, role]);
  if (narrowed.rowCount !== 0) fail("runtime_narrowed_relation_writable");
  const defaults = await client.query(`
    SELECT namespace.nspname, acl.defaclobjtype FROM pg_default_acl AS acl JOIN pg_namespace AS namespace ON namespace.oid = acl.defaclnamespace
      CROSS JOIN LATERAL aclexplode(acl.defaclacl) AS entry
     WHERE namespace.nspname = ANY($1::text[]) AND acl.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND entry.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
       AND ((acl.defaclobjtype = 'r' AND entry.privilege_type = 'INSERT') OR (acl.defaclobjtype = 'S' AND entry.privilege_type = 'USAGE'))
     GROUP BY 1, 2`, [schemas, role]);
  if (defaults.rowCount !== schemas.length * 2) fail("runtime_default_privileges_missing");
}

let client;
try {
  const raw = process.env.TARGET_DATABASE_MIGRATION_URL;
  if (!raw) fail("migration_url_missing");
  const url = new URL(raw);
  const parameters = [...url.searchParams.entries()];
  const localFixture = process.env.VAYADA_AUDIT_GRANT_LOCAL_FIXTURE === "1" &&
    ["vayada-db-preflight", "127.0.0.1", "localhost"].includes(url.hostname) && parameters.length === 0;
  let ssl;
  if (!localFixture) {
    if (url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" || url.port !== "5432")
      fail("unexpected_database_host");
    if (url.searchParams.get("sslmode") !== "require") fail("rds_ssl_required");
    if (parameters.length !== 1) fail("unsupported_connection_parameters");
    const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
    if (!ca) fail("rds_ca_missing");
    url.search = "";
    ssl = { ca, rejectUnauthorized: true, servername: url.hostname };
  }
  const scope = process.env.VAYADA_DB_GRANT_SCOPE;
  if (!["product_dml", "revoke_product_dml"].includes(scope)) fail("unknown_grant_scope");
  client = new pg.Client({ connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 60_000 });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL search_path TO pg_catalog");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const version = await client.query("SELECT current_setting('server_version_num')::integer AS value");
  const supportsMaintain = version.rows[0].value >= 170000;
  await assertPosture(client);
  const count = scope === "product_dml"
    ? await applyProductDml(client, supportsMaintain)
    : await revokeProductDml(client);
  await verify(client, supportsMaintain, scope);
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "PASS", grant: scope, relations: count, schemas }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const code = error instanceof Failure ? error.message : error.code ?? "runtime_product_dml_failed";
  console.error(JSON.stringify({ status: "FAIL", code }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
