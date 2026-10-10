// Runtime database role preflight for the ordinary API login (TARGET_DATABASE_URL).
// Accepts two postures (VAY-2054): the legacy allowlist, and product DML with a protected list.
import pg from "pg";

const expectedRole = "vayada_next_api_runtime";
const receipt = "platform.legacy_owner_bootstrap_receipts";
const productSchemas = ["hotel_catalog", "booking", "pms", "marketplace", "distribution", "finance", "platform"];

// Protected list: keep identical to scripts/grant-target-database-runtime-product-dml.mjs.
const noRead = [
  "platform.identity_migration_provenance",
  "platform.legacy_historical_binding_transitions", "platform.finance_expense_worker_properties",
  "platform.finance_export_worker_properties", "marketplace.affiliate_click_quota_windows",
  "pms.inventory_coverage_validation_queue",
];
const noReadPatterns = [
  "^platform\\.(identity_migration_|legacy_historical_binding_)",
  "^platform\\.finance_.*_worker_properties$",
];
const noWrite = [
  "platform.schema_migrations", "platform.pricing_runtime_property_scopes",
  "platform.channex_management_worker_properties", "platform.legacy_owner_approval_records",
  "platform.legacy_owner_approval_revocations",
  "booking.pricing_runtime_effective_property_scopes",
  "marketplace.affiliate_click_occurrences", "booking.affiliate_click_contexts",
  "booking.affiliate_click_admissions", "booking.affiliate_original_booking_bindings",
  "finance.expense_generation_dispatches", "pms.channex_room_availability_attempts",
  "pms.channex_room_availability_receipts", "pms.channex_room_availability_reconciliation_attestations",
  "pms.channex_ari_schedule_sources", "pms.channel_sync_status",
  "booking.affiliate_referral_production_preflight_revocations",
];
const noWritePatterns = [
  "^platform\\.(production_|source_extraction_|legacy_|channex_adoption_|channex_management_worker_|identity_migration_)",
  "^pms\\.channex_room_availability_", "^pms\\.channex_ari_schedule_",
  "^(marketplace|booking)\\.affiliate_click_", "^finance\\.expense_generation_",
];
const appendOnly = [
  "platform.product_audit_events", "platform.domain_events", "booking.addon_revenue_evidence",
  "pms.channex_offer_ari_receipts", "pms.channex_offer_create_receipts", "pms.channex_offer_target_versions",
  "finance.commission_rate_changes", "distribution.external_api_usage_events",
  "finance.affiliate_percentage_policy_approvals", "booking.pricing_quotes",
];
const noDelete = ["hotel_catalog.properties"];
// Trigger-invoked Channex helpers the Channex management worker provisioning revokes from
// PUBLIC; the API's product writes PERFORM them through triggers (VAY-2054 follow-up).
// Keep identical to scripts/grant-target-database-runtime-product-dml.mjs.
const runtimeExecutableFunctions = [
  "pms.enqueue_restriction_ari(uuid,text)", "pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)",
];
const identityLockOnly = [
  "identity.organizations", "identity.users", "identity.organization_memberships",
  "identity.role_permission_grants", "identity.membership_property_assignments", "identity.organization_roles",
];
const identityLockColumn = "created_at";
const identityColumns = {
  "identity.product_entitlements": {
    INSERT: ["organization_id", "product", "entitlement_key", "status", "starts_at", "expires_at", "metadata"],
    UPDATE: ["status", "starts_at", "expires_at", "updated_at"],
  },
  "identity.organization_resource_links": {
    INSERT: ["organization_id", "product", "resource_type", "resource_id", "relationship", "status"],
    UPDATE: ["id"],
  },
};
// Product DML posture: the product-link identity writes the ordinary API makes (VAY-2054 follow-up).
// Keep identical to scripts/grant-target-database-runtime-product-dml.mjs.
const productIdentityColumns = {
  "identity.product_entitlements": {
    INSERT: [...identityColumns["identity.product_entitlements"].INSERT, "resource_product", "resource_type", "resource_id"],
    UPDATE: [...identityColumns["identity.product_entitlements"].UPDATE, "metadata"],
  },
  "identity.organization_resource_links": {
    INSERT: identityColumns["identity.organization_resource_links"].INSERT,
    UPDATE: [...identityColumns["identity.organization_resource_links"].UPDATE, "status", "updated_at"],
  },
};
// Legacy allowlist posture (before the product DML grant). Removed by a follow-up once production
// has switched; until then plain preflight accepts both postures so tf-apply never breaks.
// One deliberate tightening applies to both postures: the no-read list, name patterns and the
// evidence schema are unreadable (pms.inventory_coverage_validation_queue was only read-exempt before).
const legacyRequiredRelations = {
  "booking.guest_bookings": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  "finance.payments": ["SELECT", "INSERT", "UPDATE"],
  "platform.external_webhook_events": ["SELECT", "INSERT", "UPDATE"],
  "platform.idempotency_keys": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  "platform.product_audit_events": ["SELECT", "INSERT"],
  "pms.channel_connections": ["SELECT", "INSERT", "UPDATE"],
};
const legacyStagedRelations = {
  "finance.folios": ["INSERT"], "finance.folio_revisions": ["INSERT"], "finance.folio_lines": ["INSERT"],
  "finance.folio_payment_references": ["INSERT"], "finance.expense_categories": ["INSERT"],
  "finance.expenses": ["INSERT"], "finance.recurring_expense_rules": ["INSERT"],
  "platform.domain_events": ["INSERT"], "platform.jobs": ["INSERT"],
};
const legacyRequiredColumns = { "hotel_catalog.properties": { UPDATE: ["id"] } };
const legacyStagedColumns = {
  ...identityColumns,
  "hotel_catalog.organization_setup_track_intents": {
    INSERT: ["organization_id", "selected_tracks", "revision"], UPDATE: ["selected_tracks", "revision", "updated_at"],
  },
  "finance.billing_entitlements": { UPDATE: ["id"] }, "booking.booking_settings": { INSERT: ["property_id"] },
  "marketplace.marketplace_hotel_profiles": {
    INSERT: ["property_id", "organization_id", "source_system", "source_hotel_profile_id"], UPDATE: ["property_id"],
  },
  "finance.folios": { UPDATE: ["id"] }, "pms.channel_operational_alerts": { UPDATE: ["resolved_at"] },
};
// Readable but not required by the legacy posture (granted after the split).
const legacyOptionalReads = ["platform.channex_management_worker_properties", "platform.pricing_runtime_property_scopes"];

const applicationSchemas = `
  nspname NOT IN ('pg_catalog', 'information_schema')
  AND nspname NOT LIKE 'pg_toast%'
  AND nspname NOT LIKE 'pg_temp_%'
`;
const relationKinds = "('r','p','v','m','f')";
// The receipt table keeps its own dedicated checks below.
const protectedWriteFilter = `(
  (namespace.nspname = 'vayada_migration_evidence'
   OR format('%I.%I', namespace.nspname, relation.relname) = ANY($1::text[])
   OR format('%I.%I', namespace.nspname, relation.relname) ~ ANY($2::text[]))
  AND format('%I.%I', namespace.nspname, relation.relname) <> 'platform.legacy_owner_bootstrap_receipts'
)`;
const protectedWriteParameters = [[...noRead, ...noWrite], [...noReadPatterns, ...noWritePatterns]];
const protectedReadFilter = `(
  namespace.nspname = 'vayada_migration_evidence'
  OR format('%I.%I', namespace.nspname, relation.relname) = ANY($1::text[])
  OR format('%I.%I', namespace.nspname, relation.relname) ~ ANY($2::text[])
)`;
const protectedReadParameters = [noRead, noReadPatterns];
const detailedCodes = new Set([
  "runtime_relation_read_missing", "runtime_security_definer_execute_forbidden",
  "runtime_protected_relation_read_forbidden", "runtime_product_dml_missing",
  "runtime_identity_write_scope_too_broad", "runtime_unapproved_relation_write_forbidden",
  "runtime_function_execute_missing",
]);

function check(condition, code) {
  if (!condition) throw new Error(code);
}

async function requireNoMissing(client, sql, parameters, code) {
  const result = await client.query(sql, parameters);
  if (result.rowCount === 0) return;
  if (detailedCodes.has(code)) {
    const names = result.rows.map((row) => Object.values(row).filter((value) => value !== null).join("."));
    throw new Error(`${code}:${result.rowCount}:${[...new Set(names)].join(",")}`);
  }
  throw new Error(`${code}:${result.rowCount}`);
}

const connectionString = process.env.TARGET_DATABASE_URL;
check(connectionString, "runtime_url_missing");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});

try {
  await client.connect();
  const server = await client.query(`SELECT current_setting('server_version_num')::integer AS version`);
  const supportsMaintain = server.rows[0].version >= 170000;
  const maintainPrivilegeValue = supportsMaintain ? ",('MAINTAIN')" : "";
  const maintainPrivilegeProjection = supportsMaintain
    ? ", has_table_privilege(current_user, $1, 'MAINTAIN') AS can_maintain"
    : ", false AS can_maintain";

  // Role identity and attributes.
  const role = await client.query(`
    SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
           (SELECT count(*) FROM pg_auth_members WHERE member = r.oid) AS memberships
      FROM pg_roles AS r WHERE rolname = current_user
  `);
  check(role.rowCount === 1, "runtime_role_missing");
  check(role.rows[0].name === expectedRole, "runtime_role_identity_mismatch");
  for (const attribute of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"]) {
    check(role.rows[0][attribute] === false, `runtime_role_${attribute}_forbidden`);
  }

  // Receipt ownership separation and role escalation.
  const ownership = await client.query(
    `SELECT pg_get_userbyid(relowner) AS owner, relowner,
            pg_has_role(current_user, pg_get_userbyid(relowner), 'MEMBER') AS owner_member
       FROM pg_class WHERE oid = $1::regclass`,
    [receipt],
  );
  check(ownership.rowCount === 1, "receipt_table_missing");
  check(ownership.rows[0].owner !== expectedRole, "runtime_owns_receipts");
  check(ownership.rows[0].owner_member === false, "runtime_inherits_receipt_owner");
  const migrationOwner = ownership.rows[0].relowner;
  const escalatableMemberships = await client.query(`
    WITH RECURSIVE escalatable(roleid, path) AS (
      SELECT roleid, ARRAY[member, roleid]
        FROM pg_auth_members
       WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         AND (set_option OR admin_option)
      UNION ALL
      SELECT membership.roleid, escalatable.path || membership.roleid
        FROM pg_auth_members AS membership
        JOIN escalatable ON membership.member = escalatable.roleid
       WHERE (membership.set_option OR membership.admin_option)
         AND NOT membership.roleid = ANY(escalatable.path)
    )
    SELECT role.rolname FROM escalatable JOIN pg_roles AS role ON role.oid = escalatable.roleid
  `);
  check(escalatableMemberships.rowCount === 0, "runtime_has_settable_or_admin_role_membership");

  // Database, schema and object ownership posture.
  const database = await client.query(`
    SELECT pg_get_userbyid(datdba) AS owner,
           has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
           has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp
      FROM pg_database WHERE datname = current_database()
  `);
  check(database.rows[0].owner !== expectedRole, "runtime_owns_database");
  check(database.rows[0].can_create === false, "runtime_database_create_forbidden");
  check(database.rows[0].can_temp === false, "runtime_database_temp_forbidden");
  await requireNoMissing(
    client,
    `SELECT object_type, object_name FROM (
       SELECT 'schema' AS object_type, nspname AS object_name
         FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname=current_user)
       UNION ALL
       SELECT 'relation', namespace.nspname||'.'||relation.relname
         FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        WHERE relation.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND ${applicationSchemas}
       UNION ALL
       SELECT 'function', namespace.nspname||'.'||procedure.proname
         FROM pg_proc AS procedure JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
        WHERE procedure.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND ${applicationSchemas}
       UNION ALL
       SELECT 'type', namespace.nspname||'.'||type.typname
         FROM pg_type AS type JOIN pg_namespace AS namespace ON namespace.oid=type.typnamespace
        WHERE type.typowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND ${applicationSchemas}
     ) AS owned`,
    [],
    "runtime_application_object_ownership_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname FROM pg_namespace AS namespace
      WHERE ${applicationSchemas} AND NOT has_schema_privilege(current_user, namespace.oid, 'USAGE')`,
    [],
    "runtime_schema_usage_missing",
  );
  await requireNoMissing(
    client,
    `SELECT nspname FROM pg_namespace
      WHERE ${applicationSchemas} AND has_schema_privilege(current_user, oid, 'CREATE')`,
    [],
    "runtime_schema_create_forbidden",
  );

  // Posture detection from the migration owner's default privileges in the product schemas.
  const defaults = await client.query(
    `SELECT count(DISTINCT namespace.nspname) AS schemas
       FROM pg_default_acl AS acl
       JOIN pg_namespace AS namespace ON namespace.oid = acl.defaclnamespace
       CROSS JOIN LATERAL aclexplode(acl.defaclacl) AS entry
      WHERE namespace.nspname = ANY($1::text[]) AND acl.defaclobjtype = 'r' AND acl.defaclrole = $2
        AND entry.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND entry.privilege_type = 'INSERT'`,
    [productSchemas, migrationOwner],
  );
  const coveredSchemas = Number(defaults.rows[0].schemas);
  check(
    coveredSchemas === 0 || coveredSchemas === productSchemas.length,
    `runtime_product_dml_posture_partial:${coveredSchemas}`,
  );
  const posture = coveredSchemas === 0 ? "legacy" : "product_dml";
  check(
    process.env.VAYADA_DB_REQUIRE_PRODUCT_DML !== "1" || posture === "product_dml",
    "runtime_product_dml_required",
  );

  // Protected list: never readable (table or column, including PUBLIC or inherited grants).
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ${relationKinds} AND ${protectedReadFilter}
        AND has_any_column_privilege(current_user, relation.oid, 'SELECT')`,
    protectedReadParameters,
    "runtime_protected_relation_read_forbidden",
  );
  // Protected list: never writable (table or column).
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname, privilege.name
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')${maintainPrivilegeValue}) AS privilege(name)
      WHERE relation.relkind IN ${relationKinds} AND ${protectedWriteFilter}
        AND has_table_privilege(current_user, relation.oid, privilege.name)`,
    protectedWriteParameters,
    "runtime_protected_relation_write_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname, attribute.attname, privilege.name
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped AND ${protectedWriteFilter}
        AND has_column_privilege(current_user, relation.oid, attribute.attname, privilege.name)`,
    protectedWriteParameters,
    "runtime_protected_relation_column_write_forbidden",
  );
  // Destructive privileges and grant options are forbidden everywhere.
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname, privilege.name
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN (VALUES ('TRUNCATE'),('REFERENCES'),('TRIGGER')${maintainPrivilegeValue}) AS privilege(name)
      WHERE ${applicationSchemas} AND relation.relkind IN ${relationKinds} AND relation.oid <> $1::regclass
        AND has_table_privilege(current_user, relation.oid, privilege.name)`,
    [receipt],
    "runtime_destructive_relation_access_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname, privilege.name
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('REFERENCES')) AS privilege(name)
      WHERE ${applicationSchemas} AND relation.relkind IN ${relationKinds}
        AND (has_table_privilege(current_user, relation.oid, privilege.name || ' WITH GRANT OPTION')
             OR (privilege.name <> 'DELETE'
                 AND has_any_column_privilege(current_user, relation.oid, privilege.name || ' WITH GRANT OPTION')))`,
    [],
    "runtime_column_grant_option_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, sequence.relname, privilege.name
       FROM pg_class AS sequence JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
       CROSS JOIN (VALUES ('USAGE'),('SELECT'),('UPDATE')) AS privilege(name)
      WHERE ${applicationSchemas} AND sequence.relkind = 'S'
        AND has_sequence_privilege(current_user, sequence.oid, privilege.name)
        AND NOT ($1 AND privilege.name <> 'UPDATE' AND namespace.nspname = ANY($2::text[]))`,
    [posture === "product_dml", productSchemas],
    "runtime_sequence_access_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, procedure.proname
       FROM pg_proc AS procedure JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE ${applicationSchemas} AND procedure.prosecdef
        AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')`,
    [],
    "runtime_security_definer_execute_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, type.typname
       FROM pg_type AS type JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE ${applicationSchemas} AND NOT has_type_privilege(current_user, type.oid, 'USAGE')`,
    [],
    "runtime_type_access_missing",
  );

  if (posture === "legacy") {
    await requireNoMissing(
      client,
      `SELECT requirement.relation, privilege.name
         FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
         CROSS JOIN LATERAL jsonb_array_elements_text(requirement.privileges) AS privilege(name)
         LEFT JOIN pg_class AS relation ON relation.oid = to_regclass(requirement.relation)
        WHERE relation.oid IS NULL OR NOT has_table_privilege(current_user, relation.oid, privilege.name)`,
      [JSON.stringify(legacyRequiredRelations)],
      "runtime_relation_access_missing",
    );
    await requireNoMissing(
      client,
      `SELECT requirement.relation, privilege.name, column_name.name
         FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
         CROSS JOIN LATERAL jsonb_each(requirement.privileges) AS privilege(name, columns)
         CROSS JOIN LATERAL jsonb_array_elements_text(privilege.columns) AS column_name(name)
         LEFT JOIN pg_class AS relation ON relation.oid = to_regclass(requirement.relation)
        WHERE relation.oid IS NULL
           OR NOT has_column_privilege(current_user, relation.oid, column_name.name, privilege.name)`,
      [JSON.stringify(legacyRequiredColumns)],
      "runtime_column_access_missing",
    );
    const allowedRelations = JSON.stringify({ ...legacyRequiredRelations, ...legacyStagedRelations });
    const allowedColumns = JSON.stringify({ ...legacyRequiredColumns, ...legacyStagedColumns });
    await requireNoMissing(
      client,
      `WITH allowed AS (
         SELECT requirement.relation, privilege.name
           FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
           CROSS JOIN LATERAL jsonb_array_elements_text(requirement.privileges) AS privilege(name)
          WHERE privilege.name IN ('INSERT','UPDATE','DELETE')
       )
       SELECT namespace.nspname, relation.relname, privilege.name
         FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) AS privilege(name)
        WHERE ${applicationSchemas} AND relation.relkind IN ${relationKinds} AND relation.oid <> $2::regclass
          AND has_table_privilege(current_user, relation.oid, privilege.name)
          AND NOT EXISTS (
            SELECT 1 FROM allowed
             WHERE allowed.relation = format('%I.%I', namespace.nspname, relation.relname)
               AND allowed.name = privilege.name)`,
      [allowedRelations, receipt],
      "runtime_unapproved_relation_write_forbidden",
    );
    await requireNoMissing(
      client,
      `WITH allowed AS (
         SELECT requirement.relation, privilege.name
           FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
           CROSS JOIN LATERAL jsonb_array_elements_text(requirement.privileges) AS privilege(name)
          WHERE privilege.name IN ('INSERT','UPDATE','REFERENCES')
       ), allowed_columns AS (
         SELECT requirement.relation, privilege.name, column_name.name AS column_name
           FROM jsonb_each($3::jsonb) AS requirement(relation, privileges)
           CROSS JOIN LATERAL jsonb_each(requirement.privileges) AS privilege(name, columns)
           CROSS JOIN LATERAL jsonb_array_elements_text(privilege.columns) AS column_name(name)
       )
       SELECT namespace.nspname, relation.relname, attribute.attname, privilege.name
         FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
         CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
        WHERE ${applicationSchemas} AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND relation.oid <> $2::regclass
          AND has_column_privilege(current_user, relation.oid, attribute.attname, privilege.name)
          AND NOT EXISTS (
            SELECT 1 FROM allowed
             WHERE allowed.relation = format('%I.%I', namespace.nspname, relation.relname)
               AND allowed.name = privilege.name)
          AND NOT EXISTS (
            SELECT 1 FROM allowed_columns
             WHERE allowed_columns.relation = format('%I.%I', namespace.nspname, relation.relname)
               AND allowed_columns.name = privilege.name
               AND allowed_columns.column_name = attribute.attname)`,
      [allowedRelations, receipt, allowedColumns],
      "runtime_unapproved_relation_column_write_forbidden",
    );
  } else {
    // Product DML posture (VAY-2054).
    check(Number(role.rows[0].memberships) === 0, "runtime_role_membership_forbidden");
    // Row locks need UPDATE on one column (platform #240 precedent): the audit timestamp,
    // because the hotel-setup native preflights pin the policy and trigger posture of these tables.
    const lockColumns = await client.query(
      `SELECT relation.name, attribute.attname
         FROM unnest($1::text[]) AS relation(name)
         JOIN pg_attribute AS attribute ON attribute.attrelid = to_regclass(relation.name)
          AND attribute.attname = $2 AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
      [identityLockOnly, identityLockColumn],
    );
    check(lockColumns.rowCount === identityLockOnly.length, "runtime_identity_lock_column_missing");
    await requireNoMissing(
      client,
      `SELECT relation.relname, attribute.attname, privilege.name
         FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
         CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
         LEFT JOIN jsonb_each($1::jsonb) AS allowed(relation, privileges) ON allowed.relation = 'identity.' || relation.relname
        WHERE namespace.nspname = 'identity' AND relation.relkind IN ${relationKinds}
          AND has_column_privilege(current_user, relation.oid, attribute.attname, privilege.name)
          AND NOT coalesce(allowed.privileges -> privilege.name ? attribute.attname, false)
       UNION ALL
       SELECT relation.relname, NULL, privilege.name
         FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) AS privilege(name)
        WHERE namespace.nspname = 'identity' AND relation.relkind IN ${relationKinds}
          AND has_table_privilege(current_user, relation.oid, privilege.name)`,
      [JSON.stringify({ ...productIdentityColumns, ...Object.fromEntries(lockColumns.rows.map((row) => [row.name, { UPDATE: [row.attname] }])) })],
      "runtime_identity_write_scope_too_broad",
    );
    await requireNoMissing(
      client,
      `SELECT namespace.nspname, relation.relname, privilege.name
         FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('REFERENCES')) AS privilege(name)
        WHERE ${applicationSchemas} AND relation.relkind IN ${relationKinds}
          AND NOT namespace.nspname = ANY($1::text[]) AND namespace.nspname <> 'identity'
          AND (has_table_privilege(current_user, relation.oid, privilege.name)
               OR (privilege.name <> 'DELETE' AND has_any_column_privilege(current_user, relation.oid, privilege.name)))`,
      [productSchemas],
      "runtime_unapproved_relation_write_forbidden",
    );
    await requireNoMissing(
      client,
      `SELECT namespace.nspname, relation.relname, privilege.name
         FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS privilege(name)
        WHERE namespace.nspname = ANY($3::text[]) AND relation.relkind IN ${relationKinds}
          AND relation.oid <> $6::regclass AND NOT ${protectedWriteFilter}
          AND NOT (privilege.name IN ('UPDATE','DELETE') AND format('%I.%I', namespace.nspname, relation.relname) = ANY($4::text[]))
          AND NOT (privilege.name = 'DELETE' AND format('%I.%I', namespace.nspname, relation.relname) = ANY($5::text[]))
          AND NOT has_table_privilege(current_user, relation.oid, privilege.name)`,
      [...protectedWriteParameters, productSchemas, appendOnly, noDelete, receipt],
      "runtime_product_dml_missing",
    );
    await requireNoMissing(
      client,
      `SELECT relation.name FROM unnest($1::text[]) AS relation(name)
        WHERE has_table_privilege(current_user, to_regclass(relation.name), 'UPDATE')
           OR has_table_privilege(current_user, to_regclass(relation.name), 'DELETE')
           OR has_any_column_privilege(current_user, to_regclass(relation.name), 'UPDATE')
       UNION ALL
       SELECT relation.name FROM unnest($2::text[]) AS relation(name)
        WHERE has_table_privilege(current_user, to_regclass(relation.name), 'DELETE')`,
      [appendOnly, noDelete],
      "runtime_narrowed_relation_writable",
    );
    const sequenceDefaults = await client.query(
      `SELECT count(DISTINCT namespace.nspname) AS schemas
         FROM pg_default_acl AS acl
         JOIN pg_namespace AS namespace ON namespace.oid = acl.defaclnamespace
         CROSS JOIN LATERAL aclexplode(acl.defaclacl) AS entry
        WHERE namespace.nspname = ANY($1::text[]) AND acl.defaclobjtype = 'S' AND acl.defaclrole = $2
          AND entry.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND entry.privilege_type = 'USAGE'`,
      [productSchemas, migrationOwner],
    );
    check(Number(sequenceDefaults.rows[0].schemas) === productSchemas.length, "runtime_default_privileges_missing");
    // The trigger-invoked Channex helpers stay executable (directly, or through PUBLIC where the
    // worker provisioning has not run yet); SECURITY DEFINER EXECUTE was already rejected above.
    await requireNoMissing(
      client,
      `SELECT fn.name FROM unnest($1::text[]) AS fn(name)
         LEFT JOIN pg_proc AS procedure ON procedure.oid = to_regprocedure(fn.name)
        WHERE procedure.oid IS NULL OR NOT has_function_privilege(current_user, procedure.oid, 'EXECUTE')`,
      [runtimeExecutableFunctions],
      "runtime_function_execute_missing",
    );
  }

  // Receipt table: the API reads only owner_user_ids.
  const tablePrivileges = await client.query(
    `SELECT has_table_privilege(current_user, $1, 'SELECT') AS table_select,
            has_table_privilege(current_user, $1, 'INSERT') AS can_insert,
            has_table_privilege(current_user, $1, 'UPDATE') AS can_update,
            has_table_privilege(current_user, $1, 'DELETE') AS can_delete,
            has_table_privilege(current_user, $1, 'TRUNCATE') AS can_truncate,
            has_table_privilege(current_user, $1, 'REFERENCES') AS can_reference,
            has_table_privilege(current_user, $1, 'TRIGGER') AS can_trigger
            ${maintainPrivilegeProjection},
            has_column_privilege(current_user, $1, 'owner_user_ids', 'SELECT') AS owner_ids_select`,
    [receipt],
  );
  const privileges = tablePrivileges.rows[0];
  check(privileges.owner_ids_select === true, "receipt_owner_ids_select_missing");
  for (const privilege of ["table_select", "can_insert", "can_update", "can_delete", "can_truncate", "can_reference", "can_trigger", "can_maintain"]) {
    check(privileges[privilege] === false, `receipt_${privilege}_must_be_denied`);
  }
  const leakedColumns = await client.query(
    `SELECT attname FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'owner_user_ids'
        AND has_column_privilege(current_user, $1, attname, 'SELECT')`,
    [receipt],
  );
  check(leakedColumns.rowCount === 0, "receipt_authority_columns_readable");
  const writableColumns = await client.query(
    `SELECT attribute.attname, privilege.name
       FROM pg_attribute AS attribute CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
      WHERE attribute.attrelid = $1::regclass AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND has_column_privilege(current_user, $1, attribute.attname, privilege.name)`,
    [receipt],
  );
  check(writableColumns.rowCount === 0, "receipt_columns_writable");
  await client.query(`SELECT owner_user_ids FROM ${receipt} LIMIT 0`);

  // Report missing reads only after checking the entire security boundary.
  // The bounded repair lane must not mistake a masked violation for a read-only gap.
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname
       FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE ${applicationSchemas} AND relation.relkind IN ${relationKinds}
        AND relation.oid <> $3::regclass AND NOT ${protectedReadFilter}
        AND NOT ($4 AND format('%I.%I', namespace.nspname, relation.relname) = ANY($5::text[]))
        AND NOT has_table_privilege(current_user, relation.oid, 'SELECT')`,
    [...protectedReadParameters, receipt, posture === "legacy", legacyOptionalReads],
    "runtime_relation_read_missing",
  );

  console.log(
    JSON.stringify({
      status: "PASS",
      runtimeRole: expectedRole,
      posture,
      receiptOwnerSeparated: true,
      runtimePrivilegeMatrixChecked: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: "FAIL",
      code: error instanceof Error ? error.message : "runtime_preflight_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
