import pg from "pg";
import { runFinancialsActivationReadiness } from "/app/packages/backend-migration/dist/financialsActivationReadiness.js";

let client;
try {
  const propertyId = process.env.FINANCIALS_READINESS_PROPERTY_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(propertyId ?? ""))
    throw new Error("property_required");
  if (!process.env.TARGET_DATABASE_URL || !process.env.VAYADA_DB_RDS_CA_BUNDLE)
    throw new Error("connection_missing");
  const url = new URL(process.env.TARGET_DATABASE_URL);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com" ||
    url.port !== "5432" ||
    url.pathname !== "/vayada_target_prod" ||
    decodeURIComponent(url.username) !== "vayada_target_prod_user" ||
    url.search !== "?sslmode=require" ||
    url.hash ||
    !url.password
  ) throw new Error("endpoint_untrusted");
  url.search = "";
  client = new pg.Client({
    connectionString: url.toString(),
    ssl: {
      ca: process.env.VAYADA_DB_RDS_CA_BUNDLE,
      rejectUnauthorized: true,
      servername: url.hostname,
    },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30000ms'");
  const readiness = await runFinancialsActivationReadiness(client, {
    propertyId,
    expectedModuleState: "inactive",
  });
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: readiness.status === "ready" ? "PASS" : "BLOCKED", readiness }));
  if (readiness.status === "blocked") process.exitCode = 2;
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  console.error(JSON.stringify({
    status: "FAIL",
    code: "financials_readiness_audit_failed",
    sqlState: typeof error?.code === "string" ? error.code : undefined,
  }));
  process.exitCode = 1;
} finally {
  await client?.end();
}
