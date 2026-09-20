import pg from "pg";

// VAY-2038: explicit auth-connection contract. A separate, password-provisioned
// LOGIN role must exist before this owner-only grant runner is invoked.
const role = "vayada_next_identity_runtime";
const privileges = new Map([
  ["identity.users", "SELECT, INSERT, UPDATE"],
  ["identity.external_identities", "SELECT, INSERT, UPDATE"],
  ["identity.organizations", "SELECT, INSERT, UPDATE"],
  ["identity.organization_memberships", "SELECT, INSERT, UPDATE"],
  ["identity.organization_resource_links", "SELECT, INSERT, UPDATE"],
  ["identity.role_permission_grants", "SELECT, INSERT"],
  ["identity.permission_catalog", "SELECT"],
  ["identity.product_entitlements", "SELECT"],
  ["identity.auth_reconciliation_events", "SELECT, INSERT"],
  ["identity.auth_session_handoffs", "SELECT, INSERT, UPDATE, DELETE"],
  ["identity.staff_invitations", "SELECT, INSERT, UPDATE"],
  ["identity.staff_invitation_property_assignments", "SELECT, INSERT"],
  ["identity.membership_property_assignments", "SELECT, INSERT, DELETE"],
  ["identity.membership_delegations", "SELECT, DELETE"],
  ["identity.organization_roles", "SELECT, INSERT, UPDATE, DELETE"],
  ["identity.account_admin_guards", "SELECT, INSERT"],
  ["identity.account_admin_transfer_proofs", "SELECT, INSERT, UPDATE"],
  ["identity.cookie_consents", "SELECT, INSERT, UPDATE"],
  ["identity.user_consent_status", "SELECT, INSERT, UPDATE"],
  ["identity.consent_history", "SELECT, INSERT"],
  ["identity.gdpr_requests", "SELECT, INSERT, UPDATE"],
  ["platform.external_webhook_events", "SELECT, INSERT, UPDATE"],
  ["platform.idempotency_keys", "SELECT, INSERT, UPDATE"],
  ["platform.jobs", "SELECT, INSERT, UPDATE"],
  ["platform.dead_letter_events", "SELECT, INSERT, UPDATE"],
  ["platform.product_audit_events", "SELECT, INSERT"],
]);
const sharedTables = [...privileges.keys()].filter((table) => table.startsWith("platform."));
const knownPrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
// Canonical pg_get_expr output from migration 0327 on PostgreSQL 16 and 17.
// A changed policy must be reviewed before the identity credential is mapped.
const ownerBypass = "(CURRENT_USER <> 'vayada_next_identity_runtime'::name)";
const expectedPolicies = new Map([
  ["platform.external_webhook_events", new Map([
    ["identity_runtime_scope:ALL", `(${ownerBypass} OR (provider = 'workos'::text))`],
  ])],
  ["platform.idempotency_keys", new Map([
    ["identity_runtime_scope:ALL", `(${ownerBypass} OR (operation_scope = 'identity'::text))`],
  ])],
  ["platform.jobs", new Map([
    ["identity_runtime_scope:ALL", `(${ownerBypass} OR ((queue_name = 'identity.webhooks'::text) AND (job_type = 'identity.workos_webhook.reconcile'::text) AND (resource_product = 'identity'::text)) OR ((queue_name = 'identity-provider'::text) AND (job_type = 'workos.organization-membership.delete'::text) AND (resource_product = 'identity'::text)) OR ((queue_name = 'identity-admin-transfer'::text) AND (job_type = 'identity.membership_role.reconcile'::text) AND (resource_product = 'identity'::text)))`],
    ["identity_runtime_pms_inbox_enqueue:INSERT", "((CURRENT_USER = 'vayada_next_identity_runtime'::name) AND (queue_name = 'pms-inbox'::text) AND (job_type = 'pms.inbox.assignment.reconcile'::text) AND (resource_product = 'pms'::text) AND (resource_type = 'inbox_assignment'::text))"],
  ])],
  ["platform.product_audit_events", new Map([
    ["identity_runtime_scope:ALL", `(${ownerBypass} OR (product = 'identity'::text))`],
  ])],
  ["platform.dead_letter_events", new Map([
    ["identity_runtime_scope:ALL", `(${ownerBypass} OR ((source_kind = 'webhook'::text) AND (resource_product = 'identity'::text) AND (resource_type = 'workos_webhook'::text) AND (EXISTS ( SELECT 1 FROM platform.external_webhook_events receipt WHERE ((receipt.id = dead_letter_events.webhook_event_id) AND (receipt.provider = 'workos'::text))))))`],
  ])],
]);
const canonical = (expression) => expression?.replace(/\s+/g, " ") ?? null;

let client;
try {
  const raw = process.env.TARGET_DATABASE_MIGRATION_URL;
  if (!raw) throw new Error("migration_url_missing");
  const url = new URL(raw);
  const local = process.env.VAYADA_IDENTITY_GRANT_LOCAL_FIXTURE === "1" &&
    url.hostname === "vayada-identity-grant-db" && url.search === "";
  let ssl;
  if (!local) {
    if (url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" ||
        url.port !== "5432") throw new Error("unexpected_database_host");
    if (url.search !== "?sslmode=require") throw new Error("rds_ssl_required");
    const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
    if (!ca) throw new Error("rds_ca_missing");
    url.search = "";
    ssl = { ca, rejectUnauthorized: true, servername: url.hostname };
  }
  client = new pg.Client({
    connectionString: url.toString(), ssl, connectionTimeoutMillis: 10_000,
    query_timeout: 15_000, statement_timeout: 15_000,
  });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const version = await client.query("SHOW server_version_num");
  if (Number(version.rows[0].server_version_num) >= 170000) knownPrivileges.push("MAINTAIN");

  const account = await client.query(`
    SELECT oid, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit,
           rolbypassrls, rolreplication
      FROM pg_catalog.pg_roles WHERE rolname = $1
  `, [role]);
  if (account.rowCount !== 1) throw new Error("identity_role_missing");
  const attributes = account.rows[0];
  if (!attributes.rolcanlogin || attributes.rolsuper || attributes.rolcreaterole ||
      attributes.rolcreatedb || attributes.rolinherit || attributes.rolbypassrls ||
      attributes.rolreplication) throw new Error("identity_role_unsafe_attributes");
  const memberships = await client.query(
    "SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = $1 OR roleid = $1 LIMIT 1", [attributes.oid],
  );
  if (memberships.rowCount) throw new Error("identity_role_inherits_membership");
  const owned = await client.query(`
    SELECT 1 FROM pg_catalog.pg_shdepend
     WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
       AND refobjid = $1 AND deptype = 'o'
     LIMIT 1
  `, [attributes.oid]);
  if (owned.rowCount) throw new Error("identity_role_owns_objects");
  const databaseAccess = await client.query(`
    SELECT pg_catalog.has_database_privilege($1, current_database(), 'CONNECT') AS can_connect,
           pg_catalog.has_database_privilege($1, current_database(), 'CREATE') AS can_create,
           pg_catalog.has_database_privilege($1, current_database(), 'TEMP') AS can_temp
  `, [role]);
  if (!databaseAccess.rows[0].can_connect) throw new Error("identity_role_connect_missing");
  if (databaseAccess.rows[0].can_create || databaseAccess.rows[0].can_temp)
    throw new Error("identity_role_database_ddl_privilege");
  const databaseOwner = await client.query(`
    SELECT 1 FROM pg_catalog.pg_database
     WHERE datname = current_database() AND datdba = $1
  `, [attributes.oid]);
  if (databaseOwner.rowCount) throw new Error("identity_role_owns_database");
  const unsafeSchemas = await client.query(`
    SELECT nspname FROM pg_catalog.pg_namespace
     WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
       AND pg_catalog.has_schema_privilege($1, oid, 'CREATE')
  `, [role]);
  if (unsafeSchemas.rowCount) throw new Error("identity_role_schema_create_privilege");
  const definers = await client.query(`
    SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%'
       AND n.nspname <> 'information_schema'
       AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
     LIMIT 1
  `, [role]);
  if (definers.rowCount) throw new Error("identity_role_callable_definer");

  for (const table of privileges.keys()) {
    const relation = await client.query(`
      SELECT current_user = pg_catalog.pg_get_userbyid(c.relowner) AS owned,
             c.relrowsecurity AS rls
        FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass($1)
          AND c.relkind IN ('r', 'p')
    `, [table]);
    if (relation.rowCount !== 1 || !relation.rows[0].owned)
      throw new Error("identity_grant_table_owner_required");
    if (sharedTables.includes(table)) {
      if (!relation.rows[0].rls) throw new Error("identity_shared_rls_missing");
      const policies = await client.query(`
        SELECT policyname, cmd, permissive, roles, qual, with_check
          FROM pg_catalog.pg_policies
         WHERE schemaname = 'platform' AND tablename = $1
      `, [table.split(".")[1]]);
      const expected = expectedPolicies.get(table);
      if (policies.rowCount !== expected.size || policies.rows.some((policy) => {
        const key = `${policy.policyname}:${policy.cmd}`;
        const isInsertOnly = key === "identity_runtime_pms_inbox_enqueue:INSERT";
        return policy.permissive !== "PERMISSIVE" || policy.roles !== "{public}" ||
          canonical(isInsertOnly ? policy.with_check : policy.qual) !== expected.get(key) ||
          (isInsertOnly ? policy.qual !== null : policy.with_check !== null);
      }))
        throw new Error("identity_shared_rls_policy_unexpected");
    }
  }

  // Refuse an existing write privilege outside the reviewed matrix, including
  // privileges inherited through PUBLIC and column-level grants.
  const excess = await client.query(`
    SELECT n.nspname || '.' || c.relname AS relation, p.name AS privilege,
           pg_catalog.has_table_privilege($1, c.oid, p.name || ' WITH GRANT OPTION') AS can_delegate
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest($2::text[]) AS p(name)
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT LIKE 'pg_%'
       AND n.nspname <> 'information_schema'
       AND pg_catalog.has_table_privilege($1, c.oid, p.name)
  `, [role, knownPrivileges]);
  for (const row of excess.rows) {
    const allowed = privileges.get(row.relation)?.split(", ") ?? [];
    if (!allowed.includes(row.privilege) || row.can_delegate)
      throw new Error("identity_role_existing_privilege_too_broad");
  }
  const columnExcess = await client.query(`
    SELECT n.nspname || '.' || c.relname AS relation, a.attname, p.name AS privilege,
           pg_catalog.has_column_privilege($1, c.oid, a.attname, p.name || ' WITH GRANT OPTION') AS can_delegate
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(name)
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT LIKE 'pg_%'
       AND n.nspname <> 'information_schema' AND a.attnum > 0 AND NOT a.attisdropped
       AND pg_catalog.has_column_privilege($1, c.oid, a.attname, p.name)
  `, [role]);
  for (const row of columnExcess.rows) {
    const allowed = privileges.get(row.relation)?.split(", ") ?? [];
    if (!allowed.includes(row.privilege) || row.can_delegate)
      throw new Error("identity_role_existing_column_privilege_too_broad");
  }
  const sequenceExcess = await client.query(`
    SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S' AND n.nspname NOT LIKE 'pg_%'
       AND n.nspname <> 'information_schema'
       AND (pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE')
         OR pg_catalog.has_sequence_privilege($1, c.oid, 'SELECT')
         OR pg_catalog.has_sequence_privilege($1, c.oid, 'UPDATE'))
     LIMIT 1
  `, [role]);
  if (sequenceExcess.rowCount) throw new Error("identity_role_existing_sequence_privilege");

  await client.query("BEGIN");
  await client.query("GRANT USAGE ON SCHEMA identity, platform TO vayada_next_identity_runtime");
  for (const [table, grants] of privileges) {
    await client.query(`GRANT ${grants} ON ${table} TO vayada_next_identity_runtime`);
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "PASS", role, tables: privileges.size }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const expected = new Set([
    "migration_url_missing", "unexpected_database_host", "rds_ssl_required", "rds_ca_missing",
    "identity_role_missing", "identity_role_unsafe_attributes", "identity_role_inherits_membership",
    "identity_role_owns_objects", "identity_role_database_ddl_privilege",
    "identity_role_connect_missing", "identity_role_owns_database",
    "identity_role_schema_create_privilege", "identity_role_callable_definer",
    "identity_grant_table_owner_required", "identity_shared_rls_missing",
    "identity_shared_rls_policy_unexpected", "identity_role_existing_privilege_too_broad",
    "identity_role_existing_column_privilege_too_broad",
    "identity_role_existing_sequence_privilege",
  ]);
  console.error(JSON.stringify({ status: "FAIL", code: expected.has(error.message) ? error.message : error.code ?? "identity_runtime_grant_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
