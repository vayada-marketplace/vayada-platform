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
  + "\nObject.assign(globalThis,{temporaryAdmin,verifyAdminSession,installTemporaryAdmin,removeTemporaryAdmin,checkAdminRoutes,checkAuthenticatedDomainRoutes,domainImpactCandidatesSql,bookingOracleSql,collaborationOracleSql,collaborationCountSql,expectedBooking,expectedCollaboration,runTemporaryAdmin,runTemporaryAdminCleanup});", context);
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
const bookingId = "11111111-1111-4111-8111-111111111111";
const collaborationId = "22222222-2222-4222-8222-222222222222";
const baseDomainSample = { lifecycleStatus: "active", lifecycleRevision: 7, linkedOrganizations: 1,
  activeEntitlements: 2, suspendedEntitlements: 0, totalBookings: 0, activeBookings: 0, roomTypes: 0, rooms: 0,
  totalPayments: 0, unresolvedPayments: 0, totalPayouts: 0, openPayouts: 0, billingEntitlements: 0,
  mediaObjects: 0, marketplaceActive: false, distributionStatus: null, bookingRevisionActive: false,
  connectedChannels: 0 };
const domainCandidates = [
  { ...baseDomainSample, propertyId: "33333333-3333-4333-8333-333333333333", totalBookings: 4, activeBookings: 1 },
  { ...baseDomainSample, propertyId: "44444444-4444-4444-8444-444444444444", roomTypes: 2, rooms: 3, connectedChannels: 1 },
  { ...baseDomainSample, propertyId: "55555555-5555-4555-8555-555555555555", totalPayments: 5, unresolvedPayments: 1,
    totalPayouts: 2, openPayouts: 1, billingEntitlements: 1 },
  { ...baseDomainSample, propertyId: "66666666-6666-4666-8666-666666666666", mediaObjects: 6,
    distributionStatus: "public", bookingRevisionActive: true },
  { ...baseDomainSample, propertyId: "77777777-7777-4777-8777-777777777777", marketplaceActive: true },
];
assert(domainCandidates.every(sample => !(sample.totalBookings > 0 && sample.roomTypes + sample.rooms > 0
  && sample.totalPayments + sample.totalPayouts + sample.billingEntitlements > 0 && sample.mediaObjects > 0)));
const domainSample = domainCandidates[0];
const bookingRow = { id: bookingId, bookingReference: "BOOK-1", hotelId: domainSample.propertyId, hotelName: "Hotel",
  hotelSlug: "hotel", guestName: "Test Guest", guestEmail: "guest@example.test", checkIn: "2026-09-11",
  checkOut: "2026-09-12", nights: 1, totalAmount: "99.50", currency: "EUR", status: "accepted",
  rawStatus: "confirmed", channel: "direct", requestedAt: "2026-09-01T00:00:00.000Z",
  respondedAt: "2026-09-01T00:01:00.000Z" };
const collaborationRow = { collaborationId, offerId: "offer", creatorId: "creator", hotelProfileId: domainSample.propertyId,
  creatorProfileId: "creator", creatorOrganizationId: "creator-org", hotelOrganizationId: "hotel-org",
  initiatorSide: "creator", status: "accepted", compensationType: "paid", offerTitle: "Offer", hotelLocation: "Pristina, XK",
  creatorName: "Creator", creatorAvatarUrl: null, hotelName: "Hotel", freeStayMinNights: null, freeStayMaxNights: null,
  paidAmount: "125.00", currency: "EUR", discountPercentage: null, affiliateEnabled: true,
  affiliateCommissionPercentage: "5.00", travelDateFrom: "2026-10-01", travelDateTo: "2026-10-03",
  preferredDateFrom: null, preferredDateTo: null, preferredMonths: ["october"], deliverables: [{ deliverableId: "deliverable",
    platform: "instagram", type: "reel", quantity: 2, status: "completed", completedAt: "2026-09-01T02:00:00+00:00" }],
  lastMessageAt: "2026-09-01T03:00:00.000Z", applicationMessage: "Message", hotelAgreedAt: null,
  creatorAgreedAt: "2026-09-01T04:00:00.000Z", completedAt: null, cancelledAt: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T05:00:00.000Z" };
const domainReader = { async query(sql, values = []) {
  if (sql === context.domainImpactCandidatesSql) return { rows: domainCandidates };
  if (sql === context.bookingOracleSql) return { rows: [bookingRow] };
  if (sql === context.collaborationOracleSql) return { rows: [collaborationRow] };
  if (sql === context.collaborationCountSql) return { rows: [{ total: 1 }] };
  return { rows: [] };
} };
const impactBody = sample => {
  const blockers = [
    sample.activeBookings > 0 && { code: "active_bookings", ownerDomain: "booking", count: sample.activeBookings,
      message: "Resolve active bookings." },
    sample.unresolvedPayments > 0 && { code: "unresolved_payments", ownerDomain: "finance", count: sample.unresolvedPayments,
      message: "Resolve pending or disputed payments." },
    sample.openPayouts > 0 && { code: "open_payouts", ownerDomain: "finance", count: sample.openPayouts,
      message: "Resolve open payouts." },
    sample.connectedChannels > 0 && { code: "connected_channels", ownerDomain: "pms", count: sample.connectedChannels,
      message: "Disconnect active channel-manager connections." },
  ].filter(Boolean);
  return { propertyId: sample.propertyId, lifecycleStatus: sample.lifecycleStatus,
  contractVersion: "platform-property-lifecycle.v1", lifecycleRevision: sample.lifecycleRevision,
  organizations: { linked: sample.linkedOrganizations },
  entitlements: { active: sample.activeEntitlements, suspended: sample.suspendedEntitlements },
  bookings: { total: sample.totalBookings, active: sample.activeBookings },
  inventory: { roomTypes: sample.roomTypes, rooms: sample.rooms },
  finance: { totalPayments: sample.totalPayments, unresolvedPayments: sample.unresolvedPayments,
    totalPayouts: sample.totalPayouts, openPayouts: sample.openPayouts, billingEntitlements: sample.billingEntitlements },
  media: { objects: sample.mediaObjects }, publicExposure: { marketplaceActive: sample.marketplaceActive,
    distributionStatus: sample.distributionStatus, bookingRevisionActive: sample.bookingRevisionActive },
  blockers, canRetire: blockers.length === 0 && sample.lifecycleStatus !== "retired",
  hardDeletion: { allowed: false, reason: "hard_delete_not_supported" } };
};
const bookingBody = { bookings: [context.expectedBooking(bookingRow)] };
const collaborationBody = { contractVersion: "marketplace-admin.v1", authorizationMode: "platform_organization_membership",
  collaborations: [context.expectedCollaboration(collaborationRow)], pagination: { page: 1, pageSize: 2, total: 1 } };
const domainCalls = [];
const domainGet = async (path, headers = {}) => {
  domainCalls.push({ path, authorization: headers.authorization });
  const status = !headers.authorization || headers.authorization.includes("deliberately-invalid") ? 401
    : settings.role_key !== "platform_admin" ? 403 : 200;
  const permission = path.includes("/marketplace/") ? "platform.user.suspend" : "platform.admin.read";
  return { status, json: async () => status !== 200 ? { statusCode: status,
    error: status === 401 ? "Unauthorized" : "Forbidden",
    message: status === 401 ? "A valid access token is required." : `Missing required permission: ${permission}` }
    : path.includes("retirement-impact") ? impactBody(domainCandidates.find(sample => path.includes(sample.propertyId)))
    : path.includes("/bookings?") ? bookingBody : collaborationBody };
};
const domainResult = await context.checkAuthenticatedDomainRoutes(domainGet, domainReader, client, "synthetic", session);
assert.equal(domainResult.checks.length, 4);
assert.deepEqual(JSON.parse(JSON.stringify(domainResult.coverage)), { bookings: 4, roomTypes: 2, rooms: 3,
  financeRecords: 8, marketplaceImpactActiveSample: true, distributionStatePresent: true, mediaObjects: 6, connectedChannels: 1,
  retirementPropertiesCompared: 5,
  bookingRowsCompared: 1, collaborationRowsCompared: 1, collaborationTotal: 1 });
for (const path of [...domainCandidates.map(sample => sample.propertyId), "/bookings?", "/collaborations?"]) assert.deepEqual(
  domainCalls.filter(call => call.path.includes(path)).map(call => call.authorization),
  [undefined, "Bearer deliberately-invalid-rehearsal-token", "Bearer synthetic", "Bearer synthetic"]);
await assert.rejects(context.checkAuthenticatedDomainRoutes(async (path, headers) => {
  const response = await domainGet(path, headers);
  if (!headers.authorization) return { status: 401, json: async () => ({ statusCode: 401, error: "Unauthorized",
    message: "A valid access token is required.", guestEmail: "disclosed@example.test" }) };
  return response;
}, domainReader, client, "synthetic", session), /DOMAIN_AUTH_DISCLOSURE/);
await assert.rejects(context.checkAuthenticatedDomainRoutes(async (path, headers) => {
  const response = await domainGet(path, headers);
  if (response.status === 200 && path.includes("retirement-impact")) return { status: 200,
    json: async () => ({ ...impactBody(domainSample), canRetire: true }) };
  return response;
}, domainReader, client, "synthetic", session), /CROSS_DOMAIN_RESPONSE_MISMATCH/);
await assert.rejects(context.checkAuthenticatedDomainRoutes(async (path, headers) => {
  const response = await domainGet(path, headers);
  if (response.status === 200 && path.includes("\/bookings?")) return { status: 200,
    json: async () => ({ bookings: [{ ...bookingBody.bookings[0], rawStatus: "stale" }] }) };
  return response;
}, domainReader, client, "synthetic", session), /BOOKING_ROUTE_TARGET_MISMATCH/);
await assert.rejects(context.checkAuthenticatedDomainRoutes(async (path, headers) => {
  const response = await domainGet(path, headers);
  if (response.status === 200 && path.includes("/collaborations?")) return { status: 200,
    json: async () => ({ ...collaborationBody, pagination: { ...collaborationBody.pagination, total: 2 } }) };
  return response;
}, domainReader, client, "synthetic", session), /MARKETPLACE_ROUTE_TARGET_MISMATCH/);
await assert.rejects(context.checkAuthenticatedDomainRoutes(domainGet, { ...domainReader,
  query: async sql => sql === context.domainImpactCandidatesSql ? { rows: domainCandidates.map(sample => ({ ...sample,
    totalPayments: 0, totalPayouts: 0, billingEntitlements: 0 })) } : domainReader.query(sql) },
client, "synthetic", session), /FINANCE_IMPACT_COVERAGE_GAP/);
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
console.log("PASS: verified-subject/window, five-row transaction, collision/trigger/grant guards, Identity denials, cross-domain target reads and drift-refusing cleanup");
