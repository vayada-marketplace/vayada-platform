import pg from "pg";
import * as exportBoundary from "/app/apps/api/dist/jobs/financeExportWorkerBoundary.js";
const {
  assertFinanceExportWorkerBoundary,
  financeExportWorkerPrivileges,
  FINANCE_EXPORT_WORKER_ROLE: role,
} = exportBoundary;
const policyConsumerFunctions = [
  "platform.channex_management_worker_scope(text,text,uuid)",
  "platform.tenant_scope_key(text,uuid,uuid)",
  "platform.valid_tenant_scope(text,uuid,uuid)",
];

let client;
try {
  const grant = process.env.VAYADA_DB_GRANT_SCOPE === "finance_export";
  const ongoing = process.env.FINANCE_EXPORT_WORKER_ONGOING === "true";
  if (ongoing && exportBoundary.FINANCE_EXPORT_ONGOING_CONTRACT !== "finance-ongoing-exports.v1")
    throw new Error("finance_export_worker_ongoing_image_unsupported");
  if (ongoing && grant) throw new Error("finance_export_worker_ongoing_grant_forbidden");
  const raw = grant
    ? process.env.TARGET_DATABASE_MIGRATION_URL
    : process.env.FINANCE_EXPORT_WORKER_DATABASE_URL;
  if (!raw || !process.env.VAYADA_DB_RDS_CA_BUNDLE)
    throw new Error("finance_export_worker_connection_missing");
  const url = new URL(raw);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" ||
    url.port !== "5432" ||
    url.pathname !== "/vayada_target_prod" ||
    url.search !== "?sslmode=require" ||
    url.hash ||
    !url.password
  )
    throw new Error("finance_export_worker_endpoint_untrusted");
  if (!grant && decodeURIComponent(url.username) !== role)
    throw new Error("finance_export_worker_login_mismatch");
  url.search = "";
  client = new pg.Client({
    connectionString: url.toString(),
    ssl: {
      ca: process.env.VAYADA_DB_RDS_CA_BUNDLE,
      rejectUnauthorized: true,
      servername: url.hostname,
    },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const propertyId = process.env.FINANCE_EXPORT_WORKER_PROPERTY_ID;
  if (!ongoing && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(propertyId ?? ""))
    throw new Error("finance_export_worker_property_required");
  const exportId = process.env.FINANCE_EXPORT_WORKER_EXPORT_ID;
  if (!ongoing && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(exportId ?? ""))
    throw new Error("finance_export_worker_export_required");
  await client.query("BEGIN");
  if (grant) {
    const names = Object.keys(financeExportWorkerPrivileges);
    const owned = (
      await client.query(
        "SELECT count(*)::int AS count FROM pg_class WHERE oid=ANY($1::regclass[]) AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)",
        [names],
      )
    ).rows[0];
    if (owned.count !== names.length) throw new Error("finance_export_worker_table_owner_required");
    await assertFinanceExportWorkerBoundary(client, { allowMissingGrants: true });
    await client.query("LOCK TABLE platform.finance_export_worker_properties IN EXCLUSIVE MODE");
    const scope = (
      await client.query("SELECT property_id::text FROM platform.finance_export_worker_properties")
    ).rows;
    if (scope.some((row) => row.property_id !== propertyId))
      throw new Error("finance_export_worker_property_scope_mismatch");
    await client.query(
      "INSERT INTO platform.finance_export_worker_properties(property_id) VALUES($1) ON CONFLICT DO NOTHING",
      [propertyId],
    );
    await client.query(`GRANT USAGE ON SCHEMA platform,finance,hotel_catalog,pms TO ${role}`);
    for (const functionName of policyConsumerFunctions) {
      await client.query(`REVOKE EXECUTE ON FUNCTION ${functionName} FROM PUBLIC`);
      await client.query(`REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${functionName} FROM ${role}`);
      await client.query(`GRANT EXECUTE ON FUNCTION ${functionName} TO ${role}`);
    }
    for (const [table, privileges] of Object.entries(financeExportWorkerPrivileges))
      for (const [kind, columns] of Object.entries(privileges))
        await client.query(
          `GRANT ${kind}${columns === true ? "" : `(${columns.join(",")})`} ON ${table} TO ${role}`,
        );
  } else {
    const login = (await client.query("SELECT current_user,session_user")).rows[0];
    if (login.current_user !== role || login.session_user !== role)
      throw new Error("finance_export_worker_login_mismatch");
  }
  const consumerAccess = await client.query(
    `WITH required_functions(name) AS (SELECT unnest($1::text[]))
     SELECT required_functions.name AS function
     FROM required_functions
     LEFT JOIN pg_proc procedure ON procedure.oid=to_regprocedure(required_functions.name)
     LEFT JOIN pg_roles account ON account.rolname=$2
     WHERE procedure.oid IS NULL OR procedure.prosecdef OR account.oid IS NULL
       OR EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) acl
         WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
       OR NOT EXISTS (
       SELECT 1 FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) acl
       WHERE acl.grantee=account.oid AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable)
       OR EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) acl
         WHERE acl.grantee=account.oid AND acl.privilege_type='EXECUTE' AND acl.is_grantable)`,
    [policyConsumerFunctions, role],
  );
  if (consumerAccess.rowCount)
    throw new Error("finance_export_worker_policy_consumer_function_access_missing");
  const directFunctionAccess = await client.query(
    `SELECT procedure.oid::regprocedure::text AS function, acl.is_grantable AS delegate
     FROM pg_proc procedure
     JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
     CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) acl
     JOIN pg_roles account ON account.oid=acl.grantee
     WHERE account.rolname=$1 AND acl.privilege_type='EXECUTE'
       AND namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema'
     ORDER BY function`,
    [role],
  );
  if (
    directFunctionAccess.rows.length !== policyConsumerFunctions.length ||
    directFunctionAccess.rows.some(
      (row) => row.delegate || !policyConsumerFunctions.includes(row.function),
    )
  )
    throw new Error("finance_export_worker_function_scope_too_broad");
  await assertFinanceExportWorkerBoundary(client, ongoing ? { ongoing: true } : { propertyId, exportId });
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "PASS", role, mode: grant ? "grant" : "preflight" }));
} catch (error) {
  await client?.query("ROLLBACK").catch(() => {});
  console.error(
    JSON.stringify({
      status: "FAIL",
      code: /^finance_export_worker_[a-z_]+$/.test(error.message)
        ? error.message
        : error.code ?? "finance_export_worker_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
