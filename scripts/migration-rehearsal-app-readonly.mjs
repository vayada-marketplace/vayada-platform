// VAY-1361 phase 1: boot/denials/row preservation, not authenticated smoke.
import { spawn } from "node:child_process";
import { createHash as appHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  binding, guardedConnection, verifyTarget, requireTrue,
  pgSettingsSql, verifyPgSettings, unsafePrivilegesSql,
} from "./migration-rehearsal-reader-contract.mjs";

const evidence = "90fb12e32a1d26b535b836782a5ef93ed4be9788b575bbd6aaa33afb3c53e3ee";
const recipient = "arn:aws:kms:eu-west-1:269416271598:key/d621e8eb-c269-4176-8cf6-34d9b0d2835a";
const fingerprint = "arn:aws:kms:eu-west-1:269416271598:key/a3a7deaf-e158-48d1-9fa8-7967743856b1";
const domains = ["identity", "hotel_catalog", "booking", "pms", "finance", "marketplace", "distribution", "platform", "vayada_migration_evidence"];
const digest = (value) => appHash("sha256").update(JSON.stringify(value)).digest("hex");

export function applicationEnvironment(env) {
  const connection = guardedConnection(env.REHEARSAL_READER_DATABASE_URL, "reader");
  connection.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=3000");
  const jwks = new URL(env.WORKOS_JWKS_URL);
  const issuer = new URL(env.WORKOS_ISSUER);
  requireTrue(jwks.protocol === "https:" && jwks.hostname === "api.workos.com" && !jwks.username && !jwks.password,
    "PUBLIC_JWKS_SCOPE");
  requireTrue(issuer.protocol === "https:" && issuer.hostname === "api.workos.com" && !issuer.username && !issuer.password,
    "PUBLIC_ISSUER_SCOPE");
  requireTrue(/^client_[A-Za-z0-9]+$/.test(env.WORKOS_AUDIENCE ?? ""), "PUBLIC_CLIENT_SCOPE");
  requireTrue(/^\/v2\/credentials\/[A-Za-z0-9-]+$/.test(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? ""), "TASK_CREDENTIAL_SCOPE");
  return {
    NODE_ENV: "test", API_RUNTIME: "next", HOST: "127.0.0.1", PORT: "8003", LOG_LEVEL: "silent",
    TARGET_DATABASE_URL: connection.toString(), AUTH_DATABASE_URL: connection.toString(),
    WORKOS_JWKS_URL: jwks.href, WORKOS_ISSUER: env.WORKOS_ISSUER, WORKOS_AUDIENCE: env.WORKOS_AUDIENCE,
    PUBLIC_HOTEL_PROFILE_SOURCE: "target", MARKETPLACE_ADMIN_SOURCE: "target",
    PMS_OPERATIONS_SOURCE: "target", FINANCE_SOURCE: "target", AFFILIATE_PUBLIC_SOURCE: "target",
    PLATFORM_MEDIA_BUCKET: "vayada-migration-rehearsal-media-269416271598",
    PLATFORM_MEDIA_CDN_BASE_URL: "https://d2k267wlr5pr38.cloudfront.net",
    PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-migration-rehearsal-media-269416271598.s3.eu-west-1.amazonaws.com",
    PLATFORM_MEDIA_CLEANUP_ENABLED: "false", PROPERTY_SETUP_DRAFT_RETENTION_ENABLED: "false",
    PMS_INVENTORY_PUBLIC_OFFER_RETRY_ENABLED: "false", PMS_CHANNEX_WORKER_ENABLED: "false",
    CREATOR_PLATFORM_SYNC_ENABLED: "false", BOOKING_WEB_EVENT_SINK: "disabled",
    STRIPE_WEBHOOK_INTAKE_MODE: "observe_only", XENDIT_WEBHOOK_INTAKE_MODE: "observe_only",
    CHANNEX_WEBHOOK_INTAKE_MODE: "observe_only",
    FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN: recipient,
    FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS: recipient,
    FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN: fingerprint,
    AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
  };
}

export async function captureRows(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    requireTrue(await verifyTarget(client) === evidence, "TARGET_EVIDENCE_CHANGED");
    const { rows: tables } = await client.query(`SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','m') AND NOT c.relispartition
      ORDER BY n.nspname,c.relname`, [domains]);
    requireTrue(domains.every((schema) => tables.some((table) => table.schema === schema)), "MISSING_DOMAIN_TABLES");
    requireTrue(tables.every((table) => table.rls === false), "ROW_VISIBILITY_NOT_PROVEN");
    const records = [];
    for (const table of tables) {
      const qualified = client.escapeIdentifier(table.schema) + "." + client.escapeIdentifier(table.name);
      records.push({ ...table, ...await fingerprintTable(client, qualified) });
    }
    return { sha256: digest(records), tables: records.length, rows: records.reduce((sum, row) => sum + row.count, 0) };
  } finally { await client.query("ROLLBACK"); }
}

export async function fingerprintTable(client, qualified) {
  const hash = appHash("sha256");
  let count = 0;
  await client.query(`DECLARE rehearsal_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row
    FROM ${qualified} t ORDER BY (row_to_json(t)::text) COLLATE "C"`);
  try {
    while (true) {
      const { rows } = await client.query("FETCH FORWARD 1000 FROM rehearsal_rows");
      if (!rows.length) break;
      for (const row of rows) hash.update(JSON.stringify(row.row) + "\n");
      count += rows.length;
    }
    return { count, sha256: hash.digest("hex") };
  } finally { await client.query("CLOSE rehearsal_rows").catch(() => {}); }
}

export async function runReadOnlyApplication(Client, env) {
  const childEnv = applicationEnvironment(env);
  const { loadConfig } = await import(pathToFileURL(process.cwd() + "/apps/api/dist/config.js").href);
  loadConfig(childEnv);
  const client = new Client({ connectionString: childEnv.TARGET_DATABASE_URL,
    connectionTimeoutMillis: 5000, application_name: "vay1361-app-row-proof" });
  let child, before, failure;
  let logBytes = 0;
  const diagnosticCodes = new Set();
  const checks = [];
  let closed;
  const deadline = setTimeout(() => { child?.kill("SIGKILL"); process.exit(2); }, 240000);
  try {
    await client.connect();
    await client.query("SET search_path=pg_catalog");
    verifyPgSettings((await client.query(pgSettingsSql)).rows);
    requireTrue((await client.query(unsafePrivilegesSql, [binding.reader])).rows[0]?.unsafe === false, "READER_PRIVILEGE_DRIFT");
    requireTrue((await client.query("SELECT current_user=session_user AND current_user=$1 AS ok", [binding.reader])).rows[0]?.ok,
      "READER_LOGIN");
    before = await captureRows(client);
    console.log(JSON.stringify({ status: "BASELINE", scope: "application-read-only", runId: binding.runId, ...before }));
    child = spawn(process.execPath, ["apps/api/dist/server.js"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    closed = new Promise((resolve) => {
      child.once("error", () => resolve({ error: "SPAWN_FAILED" }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
      logBytes += data.length;
      // Never forward raw application logs, URLs, identities or credentials.
      for (const code of ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "EADDRINUSE", "EACCES", "ENOMEM"])
        if (data.toString().includes(code)) diagnosticCodes.add(code);
    });
    const get = (path, headers = {}) => fetch("http://127.0.0.1:8003" + path,
      { headers, redirect: "error", signal: AbortSignal.timeout(3000) });
    let healthy = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      requireTrue(child.exitCode === null && child.signalCode === null, "APPLICATION_EXITED");
      try {
        const result = await get("/health");
        const body = await result.json();
        if (result.status === 200 && body.service === "vayada-api" && body.status === "ok") { healthy = true; break; }
      } catch {}
      await delay(1000);
    }
    requireTrue(healthy, "APPLICATION_NOT_READY");
    checks.push("health");
    const ready = await get("/ready");
    requireTrue(ready.status === 200 && (await ready.json()).status === "ready", "READINESS_FAILED");
    checks.push("readiness");
    for (const [name, headers] of [["missing-auth", {}], ["invalid-auth", { authorization: "Bearer deliberately-invalid-rehearsal-token" }]]) {
      const response = await get("/api/identity/admin/users", headers);
      requireTrue(response.status === 401, "AUTH_DENIAL_FAILED");
      const body = await response.json();
      requireTrue(!body.users && !body.email && !body.profile, "AUTH_RESPONSE_DISCLOSURE");
      checks.push(name);
    }
    // Brief observation under the reader ACL; this does not prove job completion.
    await delay(6000);
    requireTrue(child.exitCode === null && child.signalCode === null, "APPLICATION_EXITED");
  } catch (error) { failure = error; }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (closed) {
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await closed;
      clearTimeout(force);
    }
    try {
      if (before) {
        const after = await captureRows(client);
        requireTrue(after.sha256 === before.sha256 && after.tables === before.tables && after.rows === before.rows, "MIGRATED_ROWS_CHANGED");
        console.log(JSON.stringify({ status: "PRESERVED", scope: "application-read-only", runId: binding.runId, ...after }));
      }
    } finally { await client.end().catch(() => {}); clearTimeout(deadline); }
  }
  console.log(JSON.stringify({ scope: "application-process", logBytes, diagnosticCodes: [...diagnosticCodes], stopped: true }));
  if (failure) throw failure;
  return { status: "PASS", scope: "application-boot-and-denials-only", runId: binding.runId,
    release: binding.release, checks, dataSha256: before.sha256, applicationStopped: true,
    authenticatedReadsProven: false, jobAcceptanceProven: false, fullSmokeAccepted: false };
}
