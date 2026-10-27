import pg from "pg";
import { assertChannexManagementWorkerBoundary, channexManagementWorkerFunctions } from "/app/apps/api/dist/jobs/channexManagementWorkerBoundary.js";

import * as privileges from "/app/apps/api/dist/jobs/channexManagementWorkerPrivileges.js";
const { channexManagementWorkerPrivileges, CHANNEX_MANAGEMENT_WORKER_ROLE: role } = privileges;
// VAY-2108 D3: delivery relations wait for their own grant mode (absent on earlier images).
const deliveryRelations = privileges.optionalChannexDeliveryRelations ?? new Set();
import { policyConsumerRoleCandidates, selectPolicyConsumerRoles } from "./channex-policy-consumer-roles.mjs";
const policyConsumerFunctions = channexManagementWorkerFunctions.filter(name =>
  name.startsWith("platform."),
);

// The checked-in runner selects grant vs preflight; the matrix is shipped in the
// attested application image, shared with the worker startup check.
// VAYADA_DB_CHANNEX_SCOPE=connection (VAY-2055) admits the 'enable' operation for
// unbound hotels instead of one canary property; the allowlist is left untouched.
// VAYADA_DB_CHANNEX_SCOPE=claimed (VAY-2108, app 0519) adds, on top of the connection scope, the
// worker's SELECT on the owner table platform.channex_management_worker_claimed_operations and
// its two rows (sync_ari, provision); claimed_revoke takes both back. The claimed table is not
// in the privilege matrix on purpose: the matrix gates every next-api start.
// VAYADA_DB_CHANNEX_SCOPE=delivery (VAY-2108 D3, app 0520/0521) grants the matrix entries of the
// optional delivery relations on top of the claimed scope; delivery_revoke takes them back.
let client;
try {
  const grant = process.env.VAYADA_DB_GRANT_SCOPE === "channex_management";
  const channexScope = process.env.VAYADA_DB_CHANNEX_SCOPE;
  const claimed = channexScope === "claimed" || channexScope === "claimed_revoke";
  const delivery = channexScope === "delivery" || channexScope === "delivery_revoke";
  const revoke = channexScope === "claimed_revoke" || channexScope === "delivery_revoke";
  const connection = channexScope === "connection" || claimed || delivery;
  if ((revoke && !grant) || (channexScope !== undefined && !connection)) throw new Error("channex_worker_scope_mismatch");
  const deliveryTables = ["pms.channex_offer_ari_deliveries","pms.channex_offer_ari_delivery_dates","pms.channex_offer_ari_delivery_receipts"];
  if (delivery && (deliveryRelations.size !== 3 || !deliveryTables.every(table=>deliveryRelations.has(table)&&channexManagementWorkerPrivileges[table]))) throw new Error("channex_worker_delivery_scope_unsupported");
  const raw = grant ? process.env.TARGET_DATABASE_MIGRATION_URL : process.env.PMS_CHANNEX_MANAGEMENT_DATABASE_URL;
  if (!raw || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error("channex_worker_connection_missing");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" || url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" || url.port !== "5432" || url.pathname !== "/vayada_target_prod" || url.search !== "?sslmode=require" || url.hash || !url.password)
    throw new Error("channex_worker_endpoint_untrusted");
  if (!grant && decodeURIComponent(url.username) !== role) throw new Error("channex_worker_login_mismatch");
  url.search = "";
  client = new pg.Client({connectionString:url.toString(),ssl:{ca:process.env.VAYADA_DB_RDS_CA_BUNDLE,rejectUnauthorized:true,servername:url.hostname},connectionTimeoutMillis:10000,statement_timeout:15000});
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const propertyId = process.env.PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID;
  if (connection ? propertyId !== undefined : !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(propertyId??"")) throw new Error("channex_worker_property_required");
  const scope = connection ? {connectionScope:true,claimedScope:(claimed&&!revoke)||delivery,offerDelivery:delivery&&!revoke} : {propertyId};
  const claimedTable = "platform.channex_management_worker_claimed_operations";
  await client.query("BEGIN");
  const existingPolicyConsumerRoles = (await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname",
    [policyConsumerRoleCandidates],
  )).rows.map(row=>row.rolname);
  const policyConsumerRoles = selectPolicyConsumerRoles(existingPolicyConsumerRoles);
  if (grant) {
    const names = Object.keys(channexManagementWorkerPrivileges);
    const owned = (await client.query("SELECT count(*)::int AS count FROM pg_class WHERE oid=ANY($1::regclass[]) AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)",[names])).rows[0];
    if (owned.count !== names.length) throw new Error("channex_worker_table_owner_required");
    const ownedFunctions = (await client.query("SELECT count(*)::int AS count FROM pg_proc WHERE oid=ANY($1::regprocedure[]) AND proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)",[channexManagementWorkerFunctions])).rows[0];
    if (ownedFunctions.count !== channexManagementWorkerFunctions.length) throw new Error("channex_worker_function_owner_required");
    for (const functionName of channexManagementWorkerFunctions) {
      await client.query(`REVOKE EXECUTE ON FUNCTION ${functionName} FROM PUBLIC`);
      await client.query(`GRANT EXECUTE ON FUNCTION ${functionName} TO ${role}`);
    }
    for (const functionName of policyConsumerFunctions)
      await client.query(`GRANT EXECUTE ON FUNCTION ${functionName} TO ${policyConsumerRoles.join(",")}`);
    await assertChannexManagementWorkerBoundary(client,{allowMissingGrants:true});
    if (connection) {
      await client.query("LOCK TABLE platform.channex_management_worker_operations IN EXCLUSIVE MODE");
      const operations = (await client.query("SELECT operation_type FROM platform.channex_management_worker_operations")).rows;
      if (operations.some(row=>row.operation_type!=="enable")) throw new Error("channex_worker_operation_scope_mismatch");
      await client.query("INSERT INTO platform.channex_management_worker_operations(operation_type) VALUES('enable') ON CONFLICT DO NOTHING");
      if (claimed) {
        const ownedClaimed = (await client.query("SELECT count(*)::int AS count FROM pg_class WHERE oid=$1::regclass AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)",[claimedTable])).rows[0];
        if (ownedClaimed.count !== 1) throw new Error("channex_worker_table_owner_required");
        await client.query(`LOCK TABLE ${claimedTable} IN EXCLUSIVE MODE`);
        if (revoke) {
          await client.query(`DELETE FROM ${claimedTable}`);
          await client.query(`REVOKE SELECT ON ${claimedTable} FROM ${role}`);
        } else {
          const claimedOperations = (await client.query(`SELECT operation_type FROM ${claimedTable}`)).rows;
          if (claimedOperations.some(row=>row.operation_type!=="sync_ari"&&row.operation_type!=="provision")) throw new Error("channex_worker_claimed_scope_mismatch");
          await client.query(`GRANT SELECT ON ${claimedTable} TO ${role}`);
          await client.query(`INSERT INTO ${claimedTable}(operation_type) VALUES('sync_ari'),('provision') ON CONFLICT DO NOTHING`);
        }
      }
      if (delivery && revoke) for (const table of deliveryTables) await client.query(`REVOKE ALL ON ${table} FROM ${role}`);
    } else {
      await client.query("LOCK TABLE platform.channex_management_worker_properties IN EXCLUSIVE MODE");
      const scope = (await client.query("SELECT property_id::text FROM platform.channex_management_worker_properties")).rows;
      if (scope.some(row=>row.property_id!==propertyId)) throw new Error("channex_worker_property_scope_mismatch");
      await client.query("INSERT INTO platform.channex_management_worker_properties(property_id) VALUES($1) ON CONFLICT DO NOTHING",[propertyId]);
    }
    await client.query(`GRANT USAGE ON SCHEMA platform,finance,booking,identity,hotel_catalog,pms TO ${role}`);
    for (const [table,grants] of Object.entries(channexManagementWorkerPrivileges))
      if (!deliveryRelations.has(table) || (delivery && !revoke)) for (const [kind,columns] of Object.entries(grants))
        await client.query(`GRANT ${kind}${columns===true?"":`(${columns.join(",")})`} ON ${table} TO ${role}`);
  } else {
    const login = (await client.query("SELECT current_user,session_user")).rows[0];
    if (login.current_user !== role || login.session_user !== role) throw new Error("channex_worker_login_mismatch");
  }
  await assertChannexManagementWorkerBoundary(client,scope);
  const consumerAccess = await client.query(
    `WITH required_roles(name) AS (SELECT unnest($1::text[])),
      required_functions(name) AS (SELECT unnest($2::text[]))
     SELECT required_roles.name AS role, required_functions.name AS function
     FROM required_roles CROSS JOIN required_functions
     LEFT JOIN pg_roles account ON account.rolname=required_roles.name
     LEFT JOIN pg_proc procedure ON procedure.oid=to_regprocedure(required_functions.name)
     WHERE account.oid IS NULL OR procedure.oid IS NULL OR NOT EXISTS (
       SELECT 1 FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) acl
       WHERE acl.grantee=account.oid AND acl.privilege_type='EXECUTE')`,
    [policyConsumerRoles,policyConsumerFunctions],
  );
  if (consumerAccess.rowCount) throw new Error("channex_worker_policy_consumer_function_access_missing");
  await client.query("COMMIT");
  console.log(JSON.stringify({status:"PASS",role,mode:grant?"grant":"preflight",scope:channexScope??"canary"}));
} catch(error) {
  await client?.query("ROLLBACK").catch(()=>{});
  console.error(JSON.stringify({status:"FAIL",code:/^channex_worker_[a-z_]+$/.test(error.message)?error.message:error.code??"channex_worker_failed"}));
  process.exitCode=1;
} finally { await client?.end().catch(()=>{}); }
