import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { binding, requireTrue } from "./migration-rehearsal-reader-contract.mjs";
const original = "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b", installed = "a".repeat(64);
let rows, snapshot, savepoint, fault, mutations, settings;
const reset = () => { rows = new Set(); fault = undefined; mutations = []; settings = { role_key: "platform_admin", member: "active", link: "active" }; };
const client = { async query(sql, values = []) {
  if (sql.startsWith("BEGIN")) snapshot = new Set(rows);
  if (sql === "ROLLBACK") rows = new Set(snapshot);
  if (sql === "SAVEPOINT cleanup_probe") savepoint = new Set(rows);
  if (sql === "ROLLBACK TO SAVEPOINT cleanup_probe") rows = new Set(savepoint);
  if (sql === "COMMIT" && fault === "commit") throw new Error("COMMIT_FAILED");
  if (sql.includes("FROM pg_trigger")) return { rows: [{ approved: fault !== "trigger" }] };
  if (sql.includes("WHERE id=$1") && sql.startsWith("SELECT")) return { rows: [{ count: fault === "id" ? 1 : 0 }] };
  if (sql.includes("AS found")) return { rows: [{ found: fault === "collision" }] };
  if (sql.includes("AS present")) return { rows: [{ present: fault !== "permission", denied_role: false }] };
  if (sql.startsWith("INSERT")) { mutations.push(sql); rows.add(sql.split(" ")[2]); }
  if (sql.startsWith("DELETE")) { mutations.push(sql); const existed = rows.delete(sql.split(" ")[2]); return { rowCount: existed ? 1 : 0 }; }
  if (sql.startsWith("UPDATE")) {
    mutations.push(sql);
    settings[sql.includes("role_key") ? "role_key" : sql.includes("organization_memberships") ? "member" : "link"] = values[0];
    return { rowCount: 1 };
  }
  if (sql.startsWith("SELECT id,email")) return { rows: [{ id: "migrated-fixture", email: "fixture@example.test" }] };
  return { rows: [], rowCount: 1 };
} };
const context = { binding, requireTrue, console: { log() {} },
  identityHash: () => ({ update(value) { return { digest: () => value === "test_user" ? "1db71651043667105f6c270e800029bba9fdc7161fdbcb1c528a86db21e76c2b"
    : value === "test_org" ? "0222289cdc132448e75e88f11cdaf10e74206e4f45b47a0ec46ca120f206fa62"
    : value === '{"approved":true}' ? "0c4a4faa097a7c43cdcd22fc1929befd4944e6976fc48367762265bb5e75666c" : createHash("sha256").update(value).digest("hex") }; } }),
  captureRowsSnapshot: async () => ({ sha256: fault === "hash" ? "b".repeat(64) : rows.size ? installed : original, tables: 210, rows: 449379 + rows.size }),
};
// Substitute only imported boundaries; execute the actual implementation body.
const source = readFileSync(new URL("./migration-rehearsal-temporary-admin.mjs", import.meta.url), "utf8");
vm.runInNewContext(source.replace(/^import .*;\n/gm, "").replaceAll("export ", "")
  + "\nObject.assign(globalThis,{temporaryAdmin,verifyAdminSession,installTemporaryAdmin,removeTemporaryAdmin,checkAdminRoutes,runTemporaryAdmin,runTemporaryAdminCleanup});", context);
const session = { workosUserId: "test_user", workosOrgId: "test_org", expiresAt: Math.floor(Date.now()/1000)+250 };
context.verifyAdminSession(session);
for (const changed of [{ workosUserId: "other" }, { workosOrgId: "other" }, { expiresAt: 1 }, { expiresAt: Math.floor(Date.now()/1000)+301 }])
  assert.throws(() => context.verifyAdminSession({ ...session, ...changed }));
for (const fail of ["trigger", "id", "collision", "permission", "hash", "commit"]) {
  reset(); fault = fail;
  await assert.rejects(context.installTemporaryAdmin(client, session));
  assert.equal(rows.size, 0);
  if (fail !== "commit") assert(!mutations.some(sql => sql.startsWith("INSERT")));
}
reset();
assert.equal(await context.installTemporaryAdmin(client, session), installed);
assert.equal(rows.size, 5);
assert.equal(mutations.filter(sql => sql.startsWith("INSERT")).length, 5);
const get = async path => {
  const status = settings.member !== "active" ? 401 : settings.role_key !== "platform_admin" || settings.link !== "active" ? 403 : 200;
  const id = path.split("/").at(-1);
  return { status, json: async () => status === 200 ? { id, email: id === context.temporaryAdmin.users ? "f.maliqi+codex-admin@vayada.com" : "fixture@example.test" } : { statusCode: status } };
};
assert.equal((await context.checkAdminRoutes(get, client, client, "synthetic", session)).length, 6);
assert.deepEqual(settings, { role_key: "platform_admin", member: "active", link: "active" });
await assert.rejects(context.checkAdminRoutes(async path => ({ ...(await get(path)), status: 200 }), client, client, "synthetic", session), /ADMIN_ROUTE_STATUS_403/);
assert.equal(settings.role_key, "platform_admin");
fault = "hash";
const deletes = mutations.filter(sql => sql.startsWith("DELETE")).length;
await assert.rejects(context.removeTemporaryAdmin(client, installed), /TEST_OR_MIGRATED_DATA_DRIFT/);
assert.equal(mutations.filter(sql => sql.startsWith("DELETE")).length, deletes);
fault = "trigger";
await assert.rejects(context.removeTemporaryAdmin(client, installed), /IDENTITY_TRIGGER_DRIFT/);
assert.equal(mutations.filter(sql => sql.startsWith("DELETE")).length, deletes);
fault = undefined;
await context.removeTemporaryAdmin(client, installed);
assert.equal(rows.size, 0);
assert(!mutations.some(sql => /ON CONFLICT|CASCADE|TRUNCATE|GRANT/.test(sql)));
// Driver failures must still execute exact cleanup after installation.
class FakeClient { async connect() {} async end() {} query(...args) { return client.query(...args); } }
Object.assign(context, { process: { cwd: () => "/fixture" }, applicationEnvironment() {},
  guardedConnection: () => new URL("postgresql://fixture.test/fixture"),
  createRequire: () => () => ({ createWorkOSVerifier: () => async () => session }),
  captureRows: context.captureRowsSnapshot, runReadOnlyApplication: async () => { throw new Error("SYNTHETIC_APP_FAILURE"); } });
reset();
await assert.rejects(context.runTemporaryAdmin(FakeClient, { REHEARSAL_TEST_SESSION: "synthetic" }), /SYNTHETIC_APP_FAILURE/);
assert.equal(rows.size, 0);
await context.installTemporaryAdmin(client, session);
assert.equal((await context.runTemporaryAdminCleanup(FakeClient, { REHEARSAL_CLEANUP_HASH: installed })).temporaryAccessRemoved, true);
assert.equal(rows.size, 0);
console.log("PASS: verified-subject/window, five-row transaction, collision/trigger/grant guards, HTTP allow/denial restoration and drift-refusing cleanup");
