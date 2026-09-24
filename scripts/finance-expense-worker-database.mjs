import pg from "pg";
import { assertFinanceExpenseWorkerBoundary, financeExpenseWorkerPrivileges, FINANCE_EXPENSE_WORKER_ROLE as role } from "/app/apps/api/dist/jobs/financeExpenseWorkerBoundary.js";

// The checked-in runner selects grant vs preflight; the matrix is shipped in the
// attested application image, shared with the worker startup check.
let client;
try {
  const grant = process.env.VAYADA_DB_GRANT_SCOPE === "finance_expense";
  const raw = grant ? process.env.TARGET_DATABASE_MIGRATION_URL : process.env.FINANCE_EXPENSE_WORKER_DATABASE_URL;
  if (!raw || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error("finance_worker_connection_missing");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" || url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" || url.port !== "5432" || url.pathname !== "/vayada_target_prod" || url.search !== "?sslmode=require" || url.hash || !url.password)
    throw new Error("finance_worker_endpoint_untrusted");
  if (!grant && decodeURIComponent(url.username) !== role) throw new Error("finance_worker_login_mismatch");
  url.search = "";
  client = new pg.Client({connectionString:url.toString(),ssl:{ca:process.env.VAYADA_DB_RDS_CA_BUNDLE,rejectUnauthorized:true,servername:url.hostname},connectionTimeoutMillis:10000,statement_timeout:15000});
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const propertyId = process.env.FINANCE_EXPENSE_WORKER_PROPERTY_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(propertyId??"")) throw new Error("finance_worker_property_required");
  await client.query("BEGIN");
  // The shared queue has a PUBLIC restrictive Channex policy. PostgreSQL checks
  // EXECUTE on its invoker helper even when this login takes the non-Channex arm.
  const channexScope = (await client.query(`SELECT p.oid,p.prosecdef,p.provolatile,p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
    FROM pg_proc p WHERE p.oid=to_regprocedure('platform.channex_management_worker_scope(text,text,uuid)')`)).rows[0];
  if (!channexScope || channexScope.prosecdef || channexScope.provolatile !== "s")
    throw new Error("finance_worker_shared_policy_helper_unsafe");
  const channexSource = (await client.query(`SELECT p.oid,p.prosecdef,p.provolatile,p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
    FROM pg_proc p WHERE p.oid=to_regprocedure('platform.channex_management_worker_source(text,text,uuid)')`)).rows[0];
  if (!channexSource || channexSource.prosecdef || channexSource.provolatile !== "s")
    throw new Error("finance_worker_shared_source_helper_unsafe");
  if (grant) {
    if (!channexScope.owned) throw new Error("finance_worker_shared_policy_helper_owner_required");
    if (!channexSource.owned) throw new Error("finance_worker_shared_source_helper_owner_required");
    const names = Object.keys(financeExpenseWorkerPrivileges);
    const owned = (await client.query("SELECT count(*)::int AS count FROM pg_class WHERE oid=ANY($1::regclass[]) AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)",[names])).rows[0];
    if (owned.count !== names.length) throw new Error("finance_worker_table_owner_required");
    await assertFinanceExpenseWorkerBoundary(client,{allowMissingGrants:true});
    await client.query("LOCK TABLE platform.finance_expense_worker_properties IN EXCLUSIVE MODE");
    const scope = (await client.query("SELECT property_id::text FROM platform.finance_expense_worker_properties")).rows;
    if (scope.some(row=>row.property_id!==propertyId)) throw new Error("finance_worker_property_scope_mismatch");
    await client.query("INSERT INTO platform.finance_expense_worker_properties(property_id) VALUES($1) ON CONFLICT DO NOTHING",[propertyId]);
    await client.query(`GRANT USAGE ON SCHEMA platform,finance,booking,identity,hotel_catalog,pms TO ${role}`);
    for (const [table,privileges] of Object.entries(financeExpenseWorkerPrivileges))
      for (const [kind,columns] of Object.entries(privileges))
        await client.query(`GRANT ${kind}${columns===true?"":`(${columns.join(",")})`} ON ${table} TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION platform.channex_management_worker_scope(text,text,uuid) TO ${role}`);
    await client.query(`GRANT EXECUTE ON FUNCTION platform.channex_management_worker_source(text,text,uuid) TO ${role}`);
  } else {
    const login = (await client.query("SELECT current_user,session_user")).rows[0];
    if (login.current_user !== role || login.session_user !== role) throw new Error("finance_worker_login_mismatch");
  }
  if (!(await client.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS allowed",[role,channexScope.oid])).rows[0]?.allowed)
    throw new Error("finance_worker_shared_policy_helper_grant_missing");
  if (!(await client.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS allowed",[role,channexSource.oid])).rows[0]?.allowed)
    throw new Error("finance_worker_shared_source_helper_grant_missing");
  await assertFinanceExpenseWorkerBoundary(client,{propertyId});
  await client.query("COMMIT");
  console.log(JSON.stringify({status:"PASS",role,mode:grant?"grant":"preflight"}));
} catch(error) {
  await client?.query("ROLLBACK").catch(()=>{});
  console.error(JSON.stringify({status:"FAIL",code:/^finance_worker_[a-z_]+$/.test(error.message)?error.message:error.code??"finance_worker_failed"}));
  process.exitCode=1;
} finally { await client?.end().catch(()=>{}); }
