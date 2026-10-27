// Test harness for scripts/channex-management-worker-database.mjs (VAY-2108): runs the script
// against a scripted pg stub and stubbed app modules, then prints every SQL statement, the
// boundary calls and the script's own stdout/stderr lines as JSON. No database, no network.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const scripts = join(here, "..", "..");
const scenario = JSON.parse(process.argv[2]);
const work = mkdtempSync(join(tmpdir(), "channex-worker-db-"));
mkdirSync(join(work, "node_modules", "pg"), { recursive: true });
mkdirSync(join(work, "app"), { recursive: true });
// Scripted pg client: records statements; rows follow the scenario and a few fixed shapes.
writeFileSync(join(work, "node_modules", "pg", "package.json"), JSON.stringify({ name: "pg", main: "index.cjs" }));
writeFileSync(join(work, "node_modules", "pg", "index.cjs"), `
const scenario = ${JSON.stringify(scenario)};
const log = [];
class Client {
  constructor(options) { log.push({ connect: options.connectionString.replace(/:[^:@]*@/, ":***@") }); }
  async connect() {}
  async end() { process.stderr.write("__LOG__" + JSON.stringify(log) + "\\n"); }
  async query(text, params) {
    log.push({ sql: text, params: params ?? null });
    if (/FROM pg_roles WHERE rolname=ANY/.test(text)) return { rows: ["vayada_next_api_runtime", "vayada_next_identity_runtime"].map(rolname => ({ rolname })), rowCount: 2 };
    if (/count\\(\\*\\)::int AS count FROM pg_class WHERE oid=ANY/.test(text)) return { rows: [{ count: params[0].length }], rowCount: 1 };
    if (/count\\(\\*\\)::int AS count FROM pg_proc/.test(text)) return { rows: [{ count: params[0].length }], rowCount: 1 };
    if (/count\\(\\*\\)::int AS count FROM pg_class WHERE oid=\\$1::regclass/.test(text)) return { rows: [{ count: scenario.claimedOwned === false ? 0 : 1 }], rowCount: 1 };
    if (/SELECT current_user,session_user/.test(text)) return { rows: [{ current_user: scenario.login ?? "vayada_next_channex_management_worker", session_user: scenario.login ?? "vayada_next_channex_management_worker" }], rowCount: 1 };
    if (/SELECT operation_type FROM platform\\.channex_management_worker_claimed_operations/.test(text)) return { rows: (scenario.claimedRows ?? []).map(operation_type => ({ operation_type })), rowCount: 0 };
    if (/SELECT operation_type FROM platform\\.channex_management_worker_operations/.test(text)) return { rows: (scenario.operationRows ?? ["enable"]).map(operation_type => ({ operation_type })), rowCount: 0 };
    if (/SELECT property_id::text FROM platform\\.channex_management_worker_properties/.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }
}
module.exports = { Client };
module.exports.default = module.exports;
`);
// App module stubs: a two-table matrix, the function list, a boundary that records its options.
writeFileSync(join(work, "app", "channexManagementWorkerPrivileges.js"), `
export const CHANNEX_MANAGEMENT_WORKER_ROLE = "vayada_next_channex_management_worker";
export const channexManagementWorkerPrivileges = {
  "platform.channex_management_worker_operations": { SELECT: true },
  "pms.channel_connections": { SELECT: true, UPDATE: ["connection_status", "updated_at"] },
  ${scenario.deliveryImage ? '"pms.channex_offer_ari_deliveries": { SELECT: true, INSERT: ["target_id"], UPDATE: ["state"] }, "pms.channex_offer_ari_delivery_dates": { SELECT: true, INSERT: ["delivery_id"] }, "pms.channex_offer_ari_delivery_receipts": { SELECT: true, INSERT: ["id"] },' : ""}
};
${scenario.deliveryImage ? `export const optionalChannexDeliveryRelations = new Set(${JSON.stringify(scenario.deliveryTables ?? ["pms.channex_offer_ari_deliveries", "pms.channex_offer_ari_delivery_dates", "pms.channex_offer_ari_delivery_receipts"])});` : ""}
`);
writeFileSync(join(work, "app", "channexManagementWorkerBoundary.js"), `
export const channexManagementWorkerFunctions = ["platform.channex_management_worker_scope(text,text,uuid)", "pms.enqueue_restriction_ari(uuid,text)"];
export async function assertChannexManagementWorkerBoundary(client, options) {
  await client.query("BOUNDARY " + JSON.stringify(options ?? {}));
}
`);
cpSync(join(scripts, "channex-policy-consumer-roles.mjs"), join(work, "channex-policy-consumer-roles.mjs"));
const source = readFileSync(join(scripts, "channex-management-worker-database.mjs"), "utf8")
  .replaceAll("/app/apps/api/dist/jobs/", pathToFileURL(join(work, "app")).href + "/");
writeFileSync(join(work, "channex-management-worker-database.mjs"), source);
const url = "postgresql://" + encodeURIComponent(scenario.user ?? "vayada_next_channex_management_worker") + ":secret@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod?sslmode=require";
const env = { PATH: process.env.PATH, VAYADA_DB_RDS_CA_BUNDLE: "ca", ...(scenario.env ?? {}) };
if (scenario.grant) { env.VAYADA_DB_GRANT_SCOPE = "channex_management"; env.TARGET_DATABASE_MIGRATION_URL = url; }
else env.PMS_CHANNEX_MANAGEMENT_DATABASE_URL = url;
const result = spawnSync(process.execPath, [join(work, "channex-management-worker-database.mjs")], { env, encoding: "utf8" });
const stderr = result.stderr.split("\n");
const log = JSON.parse(stderr.find(line => line.startsWith("__LOG__"))?.slice(7) ?? "[]");
console.log(JSON.stringify({ status: result.status, stdout: result.stdout.trim(), stderr: stderr.filter(line => line && !line.startsWith("__LOG__")).join("\n"),
  statements: log.filter(entry => entry.sql).map(entry => entry.sql) }));
