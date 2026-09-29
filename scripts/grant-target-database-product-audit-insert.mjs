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

const affiliateReadTables = [
  "marketplace.affiliate_links",
  "marketplace.affiliate_agreement_lifecycle_events",
  "marketplace.affiliate_click_occurrences",
  "booking.affiliate_click_contexts",
  "booking.affiliate_click_admissions",
  "booking.affiliate_original_booking_bindings",
];

const financeAffiliateReadTables = [
  "finance.affiliate_earning_reconciliation_revisions",
  "finance.affiliate_eligible_earning_revisions",
  "finance.affiliate_earning_allocations",
  "finance.affiliate_earning_allocation_items",
];

const platformRuntimeReadTables = [
  "platform.pricing_runtime_property_scopes",
  "platform.channex_management_worker_properties",
];

async function grantDomainEventAppend(client, supportsMaintain) {
  const table = "platform.domain_events";
  const ownership = await client.query(`
    SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = pg_catalog.to_regclass($1)
       AND relation.relkind IN ('r', 'p')
  `, [table]);
  if (ownership.rowCount !== 1 || !ownership.rows[0].is_table_owner)
    throw new Error("domain_events_table_owner_required");
  const prohibited = [
    "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES",
    ...(supportsMaintain ? ["MAINTAIN"] : []),
  ];
  const violations = await client.query(`
    SELECT privilege.name
      FROM unnest($2::text[]) AS privilege(name)
     WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, privilege.name)
    UNION ALL
    SELECT attribute.attname || ':' || privilege.name
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN (VALUES ('UPDATE'), ('REFERENCES')) AS privilege(name)
     WHERE attribute.attrelid = pg_catalog.to_regclass($1)
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
       AND pg_catalog.has_column_privilege(
         'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
       )
  `, [table, prohibited]);
  if (violations.rowCount !== 0) throw new Error("domain_events_runtime_write_scope_too_broad");
  await client.query("BEGIN");
  await client.query("GRANT SELECT, INSERT ON platform.domain_events TO vayada_next_api_runtime");
  const granted = await client.query(`
    SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, 'SELECT') AS can_select,
           pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, 'INSERT') AS can_insert
  `, [table]);
  if (!granted.rows[0].can_select || !granted.rows[0].can_insert)
    throw new Error("domain_events_runtime_grant_missing");
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "PASS", grant: "platform.domain_events:SELECT,INSERT" }));
}

async function grantJobsInsert(client, supportsMaintain) {
  const ownership = await client.query(`
    SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = pg_catalog.to_regclass('platform.jobs')
       AND relation.relkind IN ('r', 'p')
  `);
  if (ownership.rowCount !== 1 || !ownership.rows[0].is_table_owner)
    throw new Error("jobs_table_owner_required");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("LOCK TABLE platform.jobs IN ACCESS EXCLUSIVE MODE");
    const lockedOwnership = await client.query(`
      SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = pg_catalog.to_regclass('platform.jobs')
         AND relation.relkind IN ('r', 'p')
    `);
    if (lockedOwnership.rowCount !== 1 || !lockedOwnership.rows[0].is_table_owner)
      throw new Error("jobs_table_owner_required");
    const prohibited = [
      "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES",
      ...(supportsMaintain ? ["MAINTAIN"] : []),
    ];
    const checkScope = async () => client.query(`
      SELECT privilege.name
        FROM unnest($1::text[]) AS privilege(name)
       WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', 'platform.jobs', privilege.name)
      UNION ALL
      SELECT attribute.attname || ':' || privilege.name
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN (VALUES ('UPDATE'), ('REFERENCES')) AS privilege(name)
       WHERE attribute.attrelid = 'platform.jobs'::regclass
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
         AND pg_catalog.has_column_privilege(
           'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
         )
    `, [prohibited]);
    if ((await checkScope()).rowCount !== 0)
      throw new Error("jobs_runtime_write_scope_too_broad");
    await client.query("GRANT INSERT ON platform.jobs TO vayada_next_api_runtime");
    const granted = await client.query(`
      SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime', 'platform.jobs', 'INSERT') AS can_insert
    `);
    if (!granted.rows[0].can_insert) throw new Error("jobs_runtime_insert_missing");
    if ((await checkScope()).rowCount !== 0)
      throw new Error("jobs_runtime_write_scope_too_broad");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ status: "PASS", grant: "platform.jobs:INSERT" }));
}

async function grantFinanceInsert(client, supportsMaintain, table, code) {
  const ownership = await client.query(`
    SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = pg_catalog.to_regclass($1)
       AND relation.relkind IN ('r', 'p')
  `, [table]);
  if (ownership.rowCount !== 1 || !ownership.rows[0].is_table_owner)
    throw new Error(`${code}_table_owner_required`);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    const lockedOwnership = await client.query(`
      SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = pg_catalog.to_regclass($1)
         AND relation.relkind IN ('r', 'p')
    `, [table]);
    if (lockedOwnership.rowCount !== 1 || !lockedOwnership.rows[0].is_table_owner)
      throw new Error(`${code}_table_owner_required`);
    const prohibited = [
      "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES",
      ...(supportsMaintain ? ["MAINTAIN"] : []),
    ];
    const checkScope = async () => client.query(`
      SELECT privilege.name
        FROM unnest($2::text[]) AS privilege(name)
       WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, privilege.name)
      UNION ALL
      SELECT attribute.attname || ':' || privilege.name
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN (VALUES ('UPDATE'), ('REFERENCES')) AS privilege(name)
       WHERE attribute.attrelid = pg_catalog.to_regclass($1)
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
         AND pg_catalog.has_column_privilege(
           'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
         )
    `, [table, prohibited]);
    if ((await checkScope()).rowCount !== 0)
      throw new Error(`${code}_runtime_write_scope_too_broad`);
    await client.query(`GRANT INSERT ON ${table} TO vayada_next_api_runtime`);
    const granted = await client.query(`
      SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, 'INSERT') AS can_insert
    `, [table]);
    if (!granted.rows[0].can_insert) throw new Error(`${code}_runtime_insert_missing`);
    if ((await checkScope()).rowCount !== 0)
      throw new Error(`${code}_runtime_write_scope_too_broad`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ status: "PASS", grant: `${table}:INSERT` }));
}

async function grantAffiliateRead(client, supportsMaintain) {
  for (const table of affiliateReadTables) {
    const ownership = await client.query(`
      SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
        FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = pg_catalog.to_regclass($1)
         AND relation.relkind IN ('r', 'p')
    `, [table]);
    if (ownership.rowCount !== 1 || !ownership.rows[0].is_table_owner)
      throw new Error("affiliate_table_owner_required");
    const prohibited = [
      "INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES",
      ...(supportsMaintain ? ["MAINTAIN"] : []),
    ];
    const violations = await client.query(`
      SELECT privilege.name
        FROM unnest($2::text[]) AS privilege(name)
       WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, privilege.name)
      UNION ALL
      SELECT attribute.attname || ':' || privilege.name
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS privilege(name)
       WHERE attribute.attrelid = pg_catalog.to_regclass($1)
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
         AND pg_catalog.has_column_privilege(
           'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
         )
    `, [table, prohibited]);
    if (violations.rowCount !== 0) throw new Error("affiliate_runtime_write_scope_too_broad");
  }
  await client.query(`GRANT SELECT ON ${affiliateReadTables.join(", ")} TO vayada_next_api_runtime`);
  for (const table of affiliateReadTables) {
    const result = await client.query(`
      SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, 'SELECT') AS can_select
    `, [table]);
    if (!result.rows[0].can_select) throw new Error("affiliate_runtime_select_missing");
  }
  console.log(JSON.stringify({ status: "PASS", grant: "affiliate_tables:SELECT" }));
}

async function grantFinanceAffiliateRead(client, supportsMaintain, localFixture) {
  const prohibitedTablePrivileges = [
    "SELECT WITH GRANT OPTION", "INSERT", "UPDATE", "DELETE", "TRUNCATE",
    "TRIGGER", "REFERENCES", ...(supportsMaintain ? ["MAINTAIN"] : []),
  ];
  const checkScope = async () => {
    for (const table of financeAffiliateReadTables) {
      const ownership = await client.query(`
        SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = pg_catalog.to_regclass($1)
           AND relation.relkind IN ('r', 'p')
      `, [table]);
      if (ownership.rowCount !== 1 || !ownership.rows[0].is_table_owner)
        throw new Error("finance_affiliate_table_owner_required");
      const violations = await client.query(`
        SELECT privilege.name
          FROM unnest($2::text[]) AS privilege(name)
         WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, privilege.name)
        UNION ALL
        SELECT attribute.attname || ':' || privilege.name
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN (VALUES ('SELECT WITH GRANT OPTION'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS privilege(name)
         WHERE attribute.attrelid = pg_catalog.to_regclass($1)
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
           AND pg_catalog.has_column_privilege(
             'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
           )
      `, [table, prohibitedTablePrivileges]);
      if (violations.rowCount !== 0)
        throw new Error("finance_affiliate_runtime_scope_too_broad");
    }
  };
  await checkScope();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(`LOCK TABLE ${financeAffiliateReadTables.join(", ")} IN ACCESS EXCLUSIVE MODE`);
    await checkScope();
    await client.query(`GRANT SELECT ON ${financeAffiliateReadTables.join(", ")} TO vayada_next_api_runtime`);
    if (localFixture && process.env.VAYADA_FINANCE_AFFILIATE_GRANT_FORCE_POST_GRANT_FAILURE === "1")
      throw new Error("finance_affiliate_forced_post_grant_failure");
    for (const table of financeAffiliateReadTables) {
      const result = await client.query(`
        SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, 'SELECT') AS can_select
      `, [table]);
      if (!result.rows[0].can_select)
        throw new Error("finance_affiliate_runtime_select_missing");
    }
    await checkScope();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ status: "PASS", grant: "finance_affiliate_tables:SELECT" }));
}

async function grantPlatformRuntimeRead(client, supportsMaintain, localFixture) {
  const prohibitedTablePrivileges = [
    "SELECT WITH GRANT OPTION", "INSERT", "UPDATE", "DELETE", "TRUNCATE",
    "TRIGGER", "REFERENCES", ...(supportsMaintain ? ["MAINTAIN"] : []),
  ];
  const checkScope = async () => {
    for (const table of platformRuntimeReadTables) {
      const ownership = await client.query(`
        SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = pg_catalog.to_regclass($1)
           AND relation.relkind IN ('r', 'p')
      `, [table]);
      if (ownership.rowCount !== 1 || !ownership.rows[0].is_table_owner)
        throw new Error("platform_runtime_table_owner_required");
      const violations = await client.query(`
        SELECT privilege.name
          FROM unnest($2::text[]) AS privilege(name)
         WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, privilege.name)
        UNION ALL
        SELECT attribute.attname || ':' || privilege.name
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN (VALUES ('SELECT WITH GRANT OPTION'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS privilege(name)
         WHERE attribute.attrelid = pg_catalog.to_regclass($1)
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
           AND pg_catalog.has_column_privilege(
             'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
           )
      `, [table, prohibitedTablePrivileges]);
      if (violations.rowCount !== 0)
        throw new Error("platform_runtime_scope_too_broad");
    }
  };
  await checkScope();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(`LOCK TABLE ${platformRuntimeReadTables.join(", ")} IN ACCESS EXCLUSIVE MODE`);
    await checkScope();
    await client.query(`GRANT SELECT ON ${platformRuntimeReadTables.join(", ")} TO vayada_next_api_runtime`);
    if (localFixture && process.env.VAYADA_PLATFORM_RUNTIME_GRANT_FORCE_POST_GRANT_FAILURE === "1")
      throw new Error("platform_runtime_forced_post_grant_failure");
    for (const table of platformRuntimeReadTables) {
      const result = await client.query(`
        SELECT pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, 'SELECT') AS can_select
      `, [table]);
      if (!result.rows[0].can_select)
        throw new Error("platform_runtime_select_missing");
    }
    await checkScope();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ status: "PASS", grant: "platform_runtime_tables:SELECT" }));
}

async function grantPropertyProfileLock(client, supportsMaintain) {
  const table = "hotel_catalog.properties";
  const ownership = await client.query(`
    SELECT current_user = pg_catalog.pg_get_userbyid(relation.relowner) AS is_table_owner
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = pg_catalog.to_regclass($1)
       AND relation.relkind IN ('r', 'p')
  `, [table]);
  if (ownership.rowCount !== 1 || !ownership.rows[0].is_table_owner)
    throw new Error("property_profile_table_owner_required");
  const prohibitedTablePrivileges = [
    "INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "REFERENCES",
    ...(supportsMaintain ? ["MAINTAIN"] : []),
  ];
  const checkScope = async () => client.query(`
    SELECT 'table:' || privilege.name AS violation
      FROM unnest($2::text[]) AS privilege(name)
     WHERE pg_catalog.has_table_privilege('vayada_next_api_runtime', $1, privilege.name)
    UNION ALL
    SELECT attribute.attname || ':' || privilege.name
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN (VALUES ('UPDATE'), ('REFERENCES')) AS privilege(name)
     WHERE attribute.attrelid = pg_catalog.to_regclass($1)
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
       AND NOT (attribute.attname = 'id' AND privilege.name = 'UPDATE')
       AND pg_catalog.has_column_privilege(
         'vayada_next_api_runtime', attribute.attrelid, attribute.attname, privilege.name
       )
    UNION ALL
    SELECT 'id:UPDATE WITH GRANT OPTION'
     WHERE pg_catalog.has_column_privilege(
       'vayada_next_api_runtime', $1, 'id', 'UPDATE WITH GRANT OPTION'
     )
  `, [table, prohibitedTablePrivileges]);
  if ((await checkScope()).rowCount !== 0)
    throw new Error("property_profile_runtime_lock_scope_too_broad");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    if ((await checkScope()).rowCount !== 0)
      throw new Error("property_profile_runtime_lock_scope_too_broad");
    await client.query(`GRANT UPDATE (id) ON ${table} TO vayada_next_api_runtime`);
    const granted = await client.query(`
      SELECT pg_catalog.has_column_privilege(
        'vayada_next_api_runtime', $1, 'id', 'UPDATE'
      ) AS can_lock
    `, [table]);
    if (!granted.rows[0].can_lock)
      throw new Error("property_profile_runtime_lock_missing");
    if ((await checkScope()).rowCount !== 0)
      throw new Error("property_profile_runtime_lock_scope_too_broad");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ status: "PASS", grant: `${table}:UPDATE(id)` }));
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
  const scope = process.env.VAYADA_DB_GRANT_SCOPE ?? "audit_insert";
  if (!["audit_insert", "affiliate_read", "finance_affiliate_read", "platform_runtime_read", "property_profile_lock", "domain_events_append", "jobs_insert", "expense_category_insert", "expense_insert", "recurring_expense_insert"].includes(scope))
    throw new Error("unknown_grant_scope");
  const role = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'vayada_next_api_runtime'",
  );
  if (role.rowCount !== 1) throw new Error("runtime_role_missing");
  if (scope === "affiliate_read") {
    await grantAffiliateRead(client, supportsMaintain);
  } else if (scope === "finance_affiliate_read") {
    await grantFinanceAffiliateRead(client, supportsMaintain, localFixture);
  } else if (scope === "platform_runtime_read") {
    await grantPlatformRuntimeRead(client, supportsMaintain, localFixture);
  } else if (scope === "property_profile_lock") {
    await grantPropertyProfileLock(client, supportsMaintain);
  } else if (scope === "domain_events_append") {
    await grantDomainEventAppend(client, supportsMaintain);
  } else if (scope === "jobs_insert") {
    await grantJobsInsert(client, supportsMaintain);
  } else if (scope === "expense_category_insert") {
    await grantFinanceInsert(client, supportsMaintain, "finance.expense_categories", "expense_categories");
  } else if (scope === "expense_insert") {
    await grantFinanceInsert(client, supportsMaintain, "finance.expenses", "expenses");
  } else if (scope === "recurring_expense_insert") {
    await grantFinanceInsert(client, supportsMaintain, "finance.recurring_expense_rules", "recurring_expense_rules");
  } else {
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
  }
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
    "affiliate_table_owner_required",
    "affiliate_runtime_write_scope_too_broad",
    "affiliate_runtime_select_missing",
    "finance_affiliate_table_owner_required",
    "finance_affiliate_runtime_scope_too_broad",
    "finance_affiliate_runtime_select_missing",
    "finance_affiliate_forced_post_grant_failure",
    "platform_runtime_table_owner_required",
    "platform_runtime_scope_too_broad",
    "platform_runtime_select_missing",
    "platform_runtime_forced_post_grant_failure",
    "property_profile_table_owner_required",
    "property_profile_runtime_lock_scope_too_broad",
    "property_profile_runtime_lock_missing",
    "domain_events_table_owner_required",
    "domain_events_runtime_write_scope_too_broad",
    "domain_events_runtime_grant_missing",
    "jobs_table_owner_required",
    "jobs_runtime_write_scope_too_broad",
    "jobs_runtime_insert_missing",
    "expense_categories_table_owner_required",
    "expense_categories_runtime_write_scope_too_broad",
    "expense_categories_runtime_insert_missing",
    "expenses_table_owner_required",
    "expenses_runtime_write_scope_too_broad",
    "expenses_runtime_insert_missing",
    "recurring_expense_rules_table_owner_required",
    "recurring_expense_rules_runtime_write_scope_too_broad",
    "recurring_expense_rules_runtime_insert_missing",
    "unknown_grant_scope",
  ]);
  const code = expected.has(error.message) ? error.message : error.code ?? "runtime_grant_failed";
  console.error(JSON.stringify({ status: "FAIL", code }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
