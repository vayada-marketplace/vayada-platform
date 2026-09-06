import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { binding } from "./migration-rehearsal-reader-contract.mjs";
import { applicationEnvironment, fingerprintTable } from "./migration-rehearsal-app-readonly.mjs";

const env = {
  REHEARSAL_READER_DATABASE_URL: `postgresql://${binding.reader}:${"A".repeat(43)}@${binding.host}/${binding.database}?sslmode=require`,
  WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client_test",
  WORKOS_ISSUER: "https://api.workos.com", WORKOS_AUDIENCE: "client_test",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/synthetic-uuid",
  ADMIN_DATABASE_URL: "never-forward", WORKOS_API_KEY: "never-forward",
  STRIPE_SECRET_KEY: "never-forward", RESEND_API_KEY: "never-forward",
  NODE_OPTIONS: "never-forward", AWS_ACCESS_KEY_ID: "never-forward",
  REHEARSAL_SESSION: "never-forward", HOST: "0.0.0.0", NODE_ENV: "production",
};
const child = applicationEnvironment(env);
assert.equal(child.HOST, "127.0.0.1");
assert.equal(child.NODE_ENV, "test");
assert.equal(child.TARGET_DATABASE_URL, child.AUTH_DATABASE_URL);
assert.equal(new URL(child.TARGET_DATABASE_URL).searchParams.get("options"),
  "-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=3000");
assert(!JSON.stringify(child).includes("never-forward"));
assert.equal(child.PMS_CHANNEX_WORKER_ENABLED, "false");
assert.equal(child.PLATFORM_MEDIA_CLEANUP_ENABLED, "false");
for (const [key, value] of [
  ["REHEARSAL_READER_DATABASE_URL", env.REHEARSAL_READER_DATABASE_URL.replace(binding.host, "production.test")],
  ["REHEARSAL_READER_DATABASE_URL", env.REHEARSAL_READER_DATABASE_URL + "&options=unsafe"],
  ["WORKOS_JWKS_URL", "https://evil.test/jwks"],
  ["WORKOS_ISSUER", "http://api.workos.com"],
  ["WORKOS_AUDIENCE", "invalid"],
  ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "http://evil.test"],
]) assert.throws(() => applicationEnvironment({ ...env, [key]: value }));
if (process.argv[2]) {
const { loadConfig, stripeSubscriptionRuntimeEnabled } = await import(pathToFileURL(process.argv[2]).href);
const config = loadConfig(child);
assert.equal(config.host, "127.0.0.1");
assert.equal(config.authSession, undefined);
assert.equal(config.stripeSubscriptions.secretKey, undefined);
assert.equal(stripeSubscriptionRuntimeEnabled(config), false);
assert.equal(config.bookingEmailDelivery, undefined);
assert.equal(config.channexManagement.workerEnabled, false);
}
const source = readFileSync(new URL("./migration-rehearsal-app-readonly.mjs", import.meta.url), "utf8");
assert(source.includes('["apps/api/dist/server.js"]'));
assert(!source.includes("start-next-api.sh"));
assert(source.indexOf("before = await captureRows(client)") < source.indexOf("child = spawn("));
const queries = [];
let batch = 0;
const expected = createHash("sha256");
const fake = { async query(sql) {
  queries.push(sql);
  if (!sql.startsWith("FETCH")) return { rows: [] };
  if (batch++ === 102) return { rows: [] };
  const rows = Array.from({length:1000}, (_, i) => ({ row: JSON.stringify({ id: (batch-1)*1000+i }) }));
  for (const row of rows) expected.update(JSON.stringify(row.row) + "\n");
  return { rows };
} };
const streamed = await fingerprintTable(fake, '"pms"."synthetic_large_table"');
assert.equal(streamed.count, 102000);
assert.equal(streamed.sha256, expected.digest("hex"));
assert.equal(queries.at(-1), "CLOSE rehearsal_rows");
queries.length = 0;
await assert.rejects(fingerprintTable({ async query(sql) {
  queries.push(sql);
  if (sql.startsWith("FETCH")) throw new Error("synthetic-fetch-failure");
  return { rows: [] };
} }, '"pms"."synthetic_large_table"'), /synthetic-fetch-failure/);
assert.equal(queries.at(-1), "CLOSE rehearsal_rows");
console.log("PASS: reader URL, loopback, environment isolation, auth/provider omission and baseline-before-start checks; packaged config checked=" + Boolean(process.argv[2]));
