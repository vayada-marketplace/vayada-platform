import pg from "pg";

const expectedRole = "vayada_next_api_runtime";
const receipt = "platform.legacy_owner_bootstrap_receipts";
const requiredRelationPrivileges = {
  "booking.guest_bookings": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  "finance.payments": ["SELECT", "INSERT", "UPDATE"],
  "platform.external_webhook_events": ["SELECT", "INSERT", "UPDATE"],
  "platform.idempotency_keys": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  "platform.product_audit_events": ["SELECT", "INSERT"],
  "pms.channel_connections": ["SELECT", "INSERT", "UPDATE"],
};
// Permit reviewed grants before later releases require them.
const stagedRelationPrivileges = {
  "finance.expense_categories": ["INSERT"],
  "finance.expenses": ["INSERT"],
  "finance.recurring_expense_rules": ["INSERT"],
  "platform.domain_events": ["INSERT"],
  "platform.jobs": ["INSERT"],
};
const requiredColumnPrivileges = {
  "hotel_catalog.properties": { UPDATE: ["id"] },
};
const protectedRelations = [
  "platform.channex_adoption_approval_records",
  "platform.channex_adoption_approval_revocations",
  "platform.channex_adoption_manifest_consumptions",
  "platform.channex_adoption_rollback_approval_records",
  "platform.channex_adoption_rollback_approval_revocations",
  "platform.channex_adoption_rollbacks",
  "platform.legacy_owner_approval_records",
  "platform.legacy_owner_approval_revocations",
  "platform.production_booking_migration_inferences",
  "platform.production_booking_migration_quarantines",
  "platform.production_cutover_runs",
  "platform.production_cutover_steps",
  "platform.production_finance_migration_dispositions",
  "platform.production_marketplace_migration_quarantines",
  "platform.production_media_migration_items",
  "platform.production_media_migration_quarantines",
  "platform.production_media_migration_runs",
  "platform.production_migration_source_links",
  "platform.source_extraction_runs",
  "platform.source_extraction_sources",
  "platform.source_extraction_tables",
  "pms.inventory_coverage_validation_queue",
];
const applicationSchemas = `
  nspname NOT IN ('pg_catalog', 'information_schema')
  AND nspname NOT LIKE 'pg_toast%'
  AND nspname NOT LIKE 'pg_temp_%'
`;

function check(condition, code) {
  if (!condition) throw new Error(code);
}

async function requireNoMissing(client, sql, parameters, code) {
  const result = await client.query(sql, parameters);
  if (code === "runtime_relation_read_missing" && result.rowCount > 0) {
    const relations = result.rows.map(({ nspname, relname }) => `${nspname}.${relname}`);
    throw new Error(`${code}:${result.rowCount}:${relations.join(",")}`);
  }
  if (code === "runtime_security_definer_execute_forbidden" && result.rowCount > 0) {
    const routines = result.rows.map(({ nspname, proname }) => `${nspname}.${proname}`);
    throw new Error(`${code}:${result.rowCount}:${routines.join(",")}`);
  }
  check(result.rowCount === 0, `${code}:${result.rowCount}`);
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
  const server = await client.query(
    `SELECT current_setting('server_version_num')::integer AS version`,
  );
  const supportsMaintain = server.rows[0].version >= 170000;
  const maintainPrivilegeValue = supportsMaintain ? ",('MAINTAIN')" : "";
  const maintainPrivilegeProjection = supportsMaintain
    ? ", has_table_privilege(current_user, $1, 'MAINTAIN') AS can_maintain"
    : ", false AS can_maintain";
  const role = await client.query(`
    SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb,
           rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = current_user
  `);
  check(role.rowCount === 1, "runtime_role_missing");
  check(role.rows[0].name === expectedRole, "runtime_role_identity_mismatch");
  for (const attribute of [
    "rolsuper",
    "rolcreaterole",
    "rolcreatedb",
    "rolreplication",
    "rolbypassrls",
  ]) {
    check(role.rows[0][attribute] === false, `runtime_role_${attribute}_forbidden`);
  }

  const ownership = await client.query(
    `SELECT pg_get_userbyid(relowner) AS owner,
            pg_has_role(current_user, pg_get_userbyid(relowner), 'MEMBER') AS owner_member
       FROM pg_class WHERE oid = $1::regclass`,
    [receipt],
  );
  check(ownership.rowCount === 1, "receipt_table_missing");
  check(ownership.rows[0].owner !== expectedRole, "runtime_owns_receipts");
  check(ownership.rows[0].owner_member === false, "runtime_inherits_receipt_owner");

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
    SELECT role.rolname
      FROM escalatable JOIN pg_roles AS role ON role.oid = escalatable.roleid
  `);
  check(
    escalatableMemberships.rowCount === 0,
    "runtime_has_settable_or_admin_role_membership",
  );

  const database = await client.query(`
    SELECT current_database() AS name,
           pg_get_userbyid(datdba) AS owner,
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
    `SELECT namespace.nspname
       FROM pg_namespace AS namespace
      WHERE ${applicationSchemas}
        AND NOT has_schema_privilege(current_user, namespace.oid, 'USAGE')`,
    [],
    "runtime_schema_usage_missing",
  );
  await requireNoMissing(
    client,
    `SELECT nspname FROM pg_namespace
      WHERE ${applicationSchemas}
        AND has_schema_privilege(current_user, oid, 'CREATE')`,
    [],
    "runtime_schema_create_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE ${applicationSchemas}
        AND relation.relkind IN ('r','p','v','m','f')
        AND relation.oid <> $1::regclass
        AND namespace.nspname <> 'vayada_migration_evidence'
        AND format('%I.%I', namespace.nspname, relation.relname) NOT IN (
          'marketplace.affiliate_click_quota_windows',
          'pms.inventory_coverage_validation_queue',
          'platform.channex_management_worker_properties',
          'platform.finance_export_worker_properties',
          'platform.finance_expense_worker_properties',
          'platform.pricing_runtime_property_scopes'
        )
        AND NOT has_table_privilege(current_user, relation.oid, 'SELECT')`,
    [receipt],
    "runtime_relation_read_missing",
  );
  // Quota state is private to the guarded affiliate command, not the API login.
  await requireNoMissing(
    client,
    `SELECT oid FROM pg_class
      WHERE oid=to_regclass('marketplace.affiliate_click_quota_windows')
        AND has_any_column_privilege(current_user, oid, 'SELECT')`,
    [],
    "runtime_affiliate_quota_read_forbidden",
  );
  // Owner-managed Finance allowlists are never part of the API read surface.
  await requireNoMissing(
    client,
    `SELECT relation.oid
       FROM pg_class AS relation
      WHERE relation.oid IN (
              to_regclass('platform.finance_expense_worker_properties'),
              to_regclass('platform.finance_export_worker_properties')
            )
        AND has_any_column_privilege(current_user, relation.oid, 'SELECT')`,
    [],
    "runtime_finance_worker_scope_read_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT requirement.relation, privilege.name
       FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
       CROSS JOIN LATERAL jsonb_array_elements_text(requirement.privileges) AS privilege(name)
       LEFT JOIN pg_class AS relation ON relation.oid = to_regclass(requirement.relation)
      WHERE relation.oid IS NULL
         OR NOT has_table_privilege(current_user, relation.oid, privilege.name)`,
    [JSON.stringify(requiredRelationPrivileges)],
    "runtime_relation_access_missing",
  );
  await requireNoMissing(
    client,
    `SELECT requirement.relation, privilege.name, column_name.name
       FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
       CROSS JOIN LATERAL jsonb_each(requirement.privileges) AS privilege(name, columns)
       CROSS JOIN LATERAL jsonb_array_elements_text(privilege.columns) AS column_name(name)
       LEFT JOIN pg_class AS relation ON relation.oid = to_regclass(requirement.relation)
      WHERE relation.oid IS NULL OR NOT has_column_privilege(
        current_user, relation.oid, column_name.name, privilege.name
      )`,
    [JSON.stringify(requiredColumnPrivileges)],
    "runtime_column_access_missing",
  );
  await requireNoMissing(
    client,
    `SELECT requirement.relation, privilege.name, column_name.name
       FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
       CROSS JOIN LATERAL jsonb_each(requirement.privileges) AS privilege(name, columns)
       CROSS JOIN LATERAL jsonb_array_elements_text(privilege.columns) AS column_name(name)
       LEFT JOIN pg_class AS relation ON relation.oid = to_regclass(requirement.relation)
      WHERE relation.oid IS NOT NULL AND has_column_privilege(
        current_user, relation.oid, column_name.name, privilege.name || ' WITH GRANT OPTION'
      )`,
    [JSON.stringify(requiredColumnPrivileges)],
    "runtime_column_grant_option_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname, privilege.name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN (VALUES ('TRUNCATE'),('REFERENCES'),('TRIGGER')
                          ${maintainPrivilegeValue}) AS privilege(name)
      WHERE ${applicationSchemas} AND relation.relkind IN ('r','p','v','m','f')
        AND relation.oid <> $1::regclass
        AND has_table_privilege(current_user, relation.oid, privilege.name)`,
    [receipt],
    "runtime_destructive_relation_access_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname, privilege.name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),
                          ('REFERENCES'),('TRIGGER')${maintainPrivilegeValue}) AS privilege(name)
      WHERE relation.relkind IN ('r','p','v','m','f')
        AND (
          namespace.nspname = 'vayada_migration_evidence'
          OR format('%I.%I', namespace.nspname, relation.relname) = ANY($1::text[])
        )
        AND has_table_privilege(current_user, relation.oid, privilege.name)`,
    [protectedRelations],
    "runtime_protected_relation_write_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, relation.relname, attribute.attname, privilege.name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
        AND (
          namespace.nspname = 'vayada_migration_evidence'
          OR format('%I.%I', namespace.nspname, relation.relname) = ANY($1::text[])
        )
        AND has_column_privilege(
          current_user, relation.oid, attribute.attname, privilege.name
        )`,
    [protectedRelations],
    "runtime_protected_relation_column_write_forbidden",
  );
  await requireNoMissing(
    client,
    `WITH allowed AS (
       SELECT requirement.relation, privilege.name
         FROM jsonb_each($1::jsonb) AS requirement(relation, privileges)
         CROSS JOIN LATERAL jsonb_array_elements_text(requirement.privileges) AS privilege(name)
        WHERE privilege.name IN ('INSERT','UPDATE','DELETE')
     )
     SELECT namespace.nspname, relation.relname, privilege.name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) AS privilege(name)
      WHERE ${applicationSchemas}
        AND relation.relkind IN ('r','p','v','m','f')
        AND relation.oid <> $2::regclass
        AND has_table_privilege(current_user, relation.oid, privilege.name)
        AND NOT EXISTS (
          SELECT 1 FROM allowed
           WHERE allowed.relation = format('%I.%I', namespace.nspname, relation.relname)
             AND allowed.name = privilege.name
        )`,
    [JSON.stringify({ ...requiredRelationPrivileges, ...stagedRelationPrivileges }), receipt],
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
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
      WHERE ${applicationSchemas}
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND relation.oid <> $2::regclass
        AND has_column_privilege(
          current_user, relation.oid, attribute.attname, privilege.name
        )
        AND NOT EXISTS (
          SELECT 1 FROM allowed
           WHERE allowed.relation = format('%I.%I', namespace.nspname, relation.relname)
             AND allowed.name = privilege.name
        )
        AND NOT EXISTS (
          SELECT 1 FROM allowed_columns
           WHERE allowed_columns.relation = format('%I.%I', namespace.nspname, relation.relname)
             AND allowed_columns.name = privilege.name
             AND allowed_columns.column_name = attribute.attname
        )`,
    [JSON.stringify({ ...requiredRelationPrivileges, ...stagedRelationPrivileges }), receipt,
      JSON.stringify(requiredColumnPrivileges)],
    "runtime_unapproved_relation_column_write_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, sequence.relname, privilege.name
       FROM pg_class AS sequence
       JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
       CROSS JOIN (VALUES ('USAGE'),('SELECT'),('UPDATE')) AS privilege(name)
      WHERE ${applicationSchemas}
        AND sequence.relkind = 'S'
        AND has_sequence_privilege(current_user, sequence.oid, privilege.name)`,
    [],
    "runtime_sequence_access_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, procedure.proname, procedure.prosecdef
       FROM pg_proc AS procedure
       JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE ${applicationSchemas}
        AND procedure.prosecdef
        AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')`,
    [],
    "runtime_security_definer_execute_forbidden",
  );
  await requireNoMissing(
    client,
    `SELECT namespace.nspname, type.typname
       FROM pg_type AS type
      JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE ${applicationSchemas}
        AND NOT has_type_privilege(current_user, type.oid, 'USAGE')`,
    [],
    "runtime_type_access_missing",
  );

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
  for (const privilege of [
    "table_select",
    "can_insert",
    "can_update",
    "can_delete",
    "can_truncate",
    "can_reference",
    "can_trigger",
    "can_maintain",
  ]) {
    check(privileges[privilege] === false, `receipt_${privilege}_must_be_denied`);
  }

  const leakedColumns = await client.query(
    `SELECT attname
       FROM pg_attribute
      WHERE attrelid = $1::regclass
        AND attnum > 0 AND NOT attisdropped AND attname <> 'owner_user_ids'
        AND has_column_privilege(current_user, $1, attname, 'SELECT')`,
    [receipt],
  );
  check(leakedColumns.rowCount === 0, "receipt_authority_columns_readable");
  const writableColumns = await client.query(
    `SELECT attribute.attname, privilege.name
       FROM pg_attribute AS attribute
       CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privilege(name)
      WHERE attribute.attrelid = $1::regclass
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND has_column_privilege(
          current_user, $1, attribute.attname, privilege.name
        )`,
    [receipt],
  );
  check(writableColumns.rowCount === 0, "receipt_columns_writable");
  await client.query(`SELECT owner_user_ids FROM ${receipt} LIMIT 0`);

  console.log(
    JSON.stringify({
      status: "PASS",
      runtimeRole: expectedRole,
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
