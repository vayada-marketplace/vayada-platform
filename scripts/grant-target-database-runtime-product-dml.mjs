// VAY-2054: one owner-checked, idempotent, transactional grant for the ordinary API login.
// Scope "product_dml" applies the reviewed grant set; "revoke_product_dml" restores the
// legacy allowlist. Both re-verify the protected list before committing.
import pg from "pg";

const role = "vayada_next_api_runtime";
const schemas = ["hotel_catalog", "booking", "pms", "marketplace", "distribution", "finance", "platform"];
const receipt = "platform.legacy_owner_bootstrap_receipts";
export const noRead = [
  "platform.identity_migration_provenance",
  "platform.legacy_historical_binding_transitions", "platform.finance_expense_worker_properties",
  "platform.finance_export_worker_properties", "marketplace.affiliate_click_quota_windows",
  "pms.inventory_coverage_validation_queue",
];
export const noReadPatterns = [
  "^platform\\.(identity_migration_|legacy_historical_binding_)",
  "^platform\\.finance_.*_worker_properties$",
];
export const noWrite = [
  "platform.schema_migrations", "platform.pricing_runtime_property_scopes",
  "platform.channex_management_worker_properties", "platform.legacy_owner_approval_records",
  "platform.legacy_owner_approval_revocations",
  "booking.pricing_runtime_effective_authority_scopes", "booking.pricing_runtime_effective_property_scopes",
  "marketplace.affiliate_click_occurrences", "booking.affiliate_click_contexts",
  "booking.affiliate_click_admissions", "booking.affiliate_original_booking_bindings",
  "finance.expense_generation_dispatches", "pms.channex_room_availability_attempts",
  "pms.channex_room_availability_receipts", "pms.channex_room_availability_reconciliation_attestations",
  "pms.channex_ari_schedule_sources", "pms.channel_sync_status",
  "booking.affiliate_referral_production_preflight_revocations",
];
export const noWritePatterns = [
  "^platform\\.(production_|source_extraction_|legacy_|channex_adoption_|channex_management_worker_|identity_migration_)",
  "^pms\\.channex_room_availability_", "^pms\\.channex_ari_schedule_",
  "^(marketplace|booking)\\.affiliate_click_", "^finance\\.expense_generation_",
];
// Insert-only evidence: the API never updates or deletes it (pricing quotes also have an append-only trigger).
export const appendOnly = [
  "platform.product_audit_events", "platform.domain_events", "booking.addon_revenue_evidence",
  "pms.channex_offer_ari_receipts", "pms.channex_offer_create_receipts", "pms.channex_offer_target_versions",
  "finance.commission_rate_changes", "distribution.external_api_usage_events",
  "finance.affiliate_percentage_policy_approvals", "booking.pricing_quotes",
];
// Pricing authority (VAY-2057): the revisions keep UPDATE only because the API locks them
// FOR SHARE together with the heads; the append-only trigger rejects real updates.
export const noDelete = [
  "hotel_catalog.properties", "booking.pricing_authority_heads", "booking.pricing_authority_revisions",
];
// Trigger-invoked Channex helpers (app migrations 0167 and 0314, invoker rights) that the
// Channex management worker provisioning revokes from PUBLIC: the API's writes to
// pms.rate_rules, pms.operating_calendar_revisions, platform.outbox_events and
// pms.channex_offer_create_attempts fire triggers that PERFORM them, so the login needs a
// direct EXECUTE. Keep identical to scripts/target-database-runtime-preflight.mjs.
export const runtimeExecutableFunctions = [
  "pms.enqueue_restriction_ari(uuid,text)", "pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)",
];
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
// Product DML posture (VAY-2054 follow-up, human decision 2026-10-07): the three identity
// writes the ordinary API makes on product-link tables (Financials module activation,
// new-hotel Financials default, marketplace offer operator grant/archive) also work.
// Keep identical to scripts/target-database-runtime-preflight.mjs.
export const productIdentityColumns = {
  "identity.product_entitlements": {
    INSERT: [...identityColumns["identity.product_entitlements"].INSERT, "resource_product", "resource_type", "resource_id"],
    UPDATE: [...identityColumns["identity.product_entitlements"].UPDATE, "metadata"],
  },
  "identity.organization_resource_links": {
    INSERT: identityColumns["identity.organization_resource_links"].INSERT,
    UPDATE: [...identityColumns["identity.organization_resource_links"].UPDATE, "status", "updated_at"],
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

// Row locks need UPDATE on one column (platform #240 precedent). The hotel-setup native
// preflights pin the policy and trigger posture of these tables, so the lock column is the
// audit timestamp rather than a lock-only RLS policy: no authorization column becomes writable.
const identityLockColumn = "created_at";
async function lockColumns(client) {
  const result = await client.query(`
    SELECT relation.name FROM unnest($1::text[]) AS relation(name)
      JOIN pg_attribute AS attribute ON attribute.attrelid = to_regclass(relation.name)
       AND attribute.attname = $2 AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
    [identityLockOnly, identityLockColumn]);
  if (result.rowCount !== identityLockOnly.length) fail("runtime_identity_lock_column_missing");
  return Object.fromEntries(identityLockOnly.map((name) => [name, identityLockColumn]));
}

// The listed functions must exist, be owned by the migration owner and keep invoker rights:
// a SECURITY DEFINER helper would run as the owner and the posture check would reject it anyway.
async function executableFunctions(client) {
  const result = await client.query(`
    SELECT fn.name, procedure.oid, procedure.prosecdef AS definer,
           procedure.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned
      FROM unnest($1::text[]) AS fn(name) LEFT JOIN pg_proc AS procedure ON procedure.oid = to_regprocedure(fn.name)`,
    [runtimeExecutableFunctions]);
  if (result.rows.some((row) => row.oid === null)) fail("runtime_function_missing");
  if (result.rows.some((row) => row.definer)) fail("runtime_function_security_definer");
  if (result.rows.some((row) => !row.owned)) fail("runtime_function_owner_required");
  return result.rows;
}
async function directExecuteGrants(client) {
  const result = await client.query(`
    SELECT procedure.oid FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL aclexplode(procedure.proacl) AS entry
     WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
       AND entry.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1) AND entry.privilege_type = 'EXECUTE'`, [role]);
  return new Set(result.rows.map((row) => row.oid));
}

async function applyProductDml(client, supportsMaintain) {
  const functions = await executableFunctions(client);
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
  const present = new Set(product.map(({ name }) => name));
  for (const name of appendOnly.filter((name) => present.has(name))) {
    await client.query(`REVOKE UPDATE, DELETE ON ${ident(name)} FROM ${role}`);
    await revokeAllColumns(client, name, "UPDATE");
  }
  for (const name of noDelete.filter((name) => present.has(name)))
    await client.query(`REVOKE DELETE ON ${ident(name)} FROM ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA identity TO ${role}`);
  for (const [name, column] of Object.entries(await lockColumns(client)))
    await client.query(`GRANT SELECT, UPDATE ("${column}") ON ${ident(name)} TO ${role}`);
  for (const [name, grants] of Object.entries(productIdentityColumns))
    for (const [privilege, columns] of Object.entries(grants))
      await client.query(`GRANT ${privilege} (${columns.join(", ")}) ON ${ident(name)} TO ${role}`);
  for (const { name } of functions) await client.query(`GRANT EXECUTE ON FUNCTION ${name} TO ${role}`);
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
  // Back to the VAY-965 matrix: drop the product-posture identity columns.
  for (const [name, grants] of Object.entries(productIdentityColumns))
    for (const [privilege, columns] of Object.entries(grants)) {
      const extra = columns.filter((column) => !identityColumns[name][privilege].includes(column));
      if (extra.length) await client.query(`REVOKE ${privilege} (${extra.join(", ")}) ON ${ident(name)} FROM ${role}`);
    }
  for (const name of runtimeExecutableFunctions)
    if ((await client.query(`SELECT to_regprocedure($1) IS NOT NULL AS present`, [name])).rows[0].present)
      await client.query(`REVOKE EXECUTE ON FUNCTION ${name} FROM ${role}`);
  return product.length;
}

async function verify(client, supportsMaintain, scope, executeBefore) {
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
      ? { ...productIdentityColumns, ...Object.fromEntries(Object.entries(await lockColumns(client)).map(([name, column]) => [name, { UPDATE: [column] }])) }
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
  const functions = await executableFunctions(client);
  const executable = await client.query(
    `SELECT bool_and(has_function_privilege($1, oid, 'EXECUTE')) AS all FROM unnest($2::oid[]) AS fn(oid)`,
    [role, functions.map((row) => row.oid)]);
  if (executable.rows[0].all !== true) fail("runtime_function_execute_missing");
  const listed = new Set(functions.map((row) => row.oid));
  for (const oid of await directExecuteGrants(client))
    if (!listed.has(oid) && !executeBefore.has(oid)) fail("runtime_function_execute_scope_too_broad");
}

// Global posture checks the tf-apply preflight also makes; run before COMMIT so pre-existing
// drift is never committed together with the grant. PUBLIC grants count: has_*_privilege(role)
// includes PUBLIC and inherited privileges.
async function verifyGlobalPosture(client, supportsMaintain) {
  const destructive = ["TRUNCATE", "REFERENCES", "TRIGGER", ...(supportsMaintain ? ["MAINTAIN"] : [])];
  const destructiveGrants = await client.query(`
    SELECT namespace.nspname || '.' || relation.relname AS name
      FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN unnest($2::text[]) AS privilege(name)
     WHERE relation.relkind IN ${relationKinds} AND namespace.nspname NOT IN ('pg_catalog','information_schema')
       AND relation.oid <> to_regclass($3) AND has_table_privilege($1, relation.oid, privilege.name)`,
    [role, destructive, receipt]);
  if (destructiveGrants.rowCount !== 0) fail("runtime_destructive_privilege_forbidden");
  const foreignDefaults = await client.query(`
    SELECT acl.oid FROM pg_default_acl AS acl
      LEFT JOIN pg_namespace AS namespace ON namespace.oid = acl.defaclnamespace
      CROSS JOIN LATERAL aclexplode(acl.defaclacl) AS entry
     WHERE entry.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
       AND (acl.defaclrole <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
            OR namespace.nspname IS NULL OR NOT namespace.nspname = ANY($2::text[]))`,
    [role, schemas]);
  if (foreignDefaults.rowCount !== 0) fail("runtime_foreign_default_privileges_forbidden");
  const definers = await client.query(`
    SELECT procedure.oid FROM pg_proc AS procedure JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND procedure.prosecdef
       AND has_function_privilege($1, procedure.oid, 'EXECUTE')`, [role]);
  if (definers.rowCount !== 0) fail("runtime_security_definer_execute_forbidden");
  const owned = await client.query(`
    SELECT relation.oid FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname NOT LIKE 'pg_%'
       AND relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
    UNION ALL SELECT oid FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`, [role]);
  if (owned.rowCount !== 0) fail("runtime_object_ownership_forbidden");
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
  if (!["product_dml", "revoke_product_dml", "inspect_product_dml"].includes(scope)) fail("unknown_grant_scope");
  if (localFixture && url.username === "vayada_target_prod_user") fail("unexpected_database_host");
  client = new pg.Client({ connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 60_000 });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL search_path TO pg_catalog");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const version = await client.query("SELECT current_setting('server_version_num')::integer AS value");
  const supportsMaintain = version.rows[0].value >= 170000;
  await assertPosture(client);
  const executeBefore = await directExecuteGrants(client);
  const count = scope === "revoke_product_dml"
    ? await revokeProductDml(client)
    : await applyProductDml(client, supportsMaintain);
  await verify(client, supportsMaintain, scope === "revoke_product_dml" ? scope : "product_dml", executeBefore);
  await verifyGlobalPosture(client, supportsMaintain);
  // The inspect scope proves the grant would commit, then leaves the database untouched.
  await client.query(scope === "inspect_product_dml" ? "ROLLBACK" : "COMMIT");
  console.log(JSON.stringify({ status: "PASS", grant: scope, relations: count, schemas, committed: scope !== "inspect_product_dml" }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const code = error instanceof Failure ? error.message : error.code ?? "runtime_product_dml_failed";
  console.error(JSON.stringify({ status: "FAIL", code }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
