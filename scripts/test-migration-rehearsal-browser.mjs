import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  browserProof,
  validateBrowserResult,
} from "./migration-rehearsal-browser.mjs";
import { routeTarget } from "./migration-rehearsal-browser-runner.mjs";
import { binding } from "./migration-rehearsal-reader-contract.mjs";

const token = "header.payload.signature";
const result = {
  status: "PASS",
  scope: "task-local-admin-browser",
  runId: binding.runId,
  release: binding.release,
  virtualOrigin: "https://next-admin.vayada.com",
  frontendDigest: browserProof.expectedFrontendDigest,
  browserDigest: browserProof.expectedBrowserDigest,
  checks: browserProof.expectedChecks,
  network: {
    frontendRequests: 12,
    apiRequests: 1,
    userListRequests: 1,
    userListAuthorizationMatches: 1,
    blockedExternalRequests: 2,
    legacyRequests: 0,
  },
  authenticatedRows: 4,
  pageErrors: 0,
};
assert.equal(validateBrowserResult(result, token), result);

for (const changed of [
  { status: "FAIL" },
  { runId: "other" },
  { release: "other" },
  { virtualOrigin: "https://admin.vayada.com" },
  { frontendDigest: "sha256:other" },
  { browserDigest: "sha256:other" },
  { checks: ["login-page"] },
  { network: { ...result.network, apiRequests: 0 } },
  { network: { ...result.network, userListAuthorizationMatches: 0 } },
  { network: { ...result.network, legacyRequests: 1 } },
  { authenticatedRows: 0 },
  { pageErrors: 1 },
]) {
  assert.throws(() => validateBrowserResult({ ...result, ...changed }, token));
}
assert.throws(() =>
  validateBrowserResult({ ...result, disclosed: token }, token),
);

assert.deepEqual(routeTarget("https://next-admin.vayada.com/dashboard?q=1"), {
  kind: "frontend",
  localUrl: "http://127.0.0.1:3001/dashboard?q=1",
});
assert.deepEqual(
  routeTarget("https://next-api.vayada.com/api/identity/admin/users?page=1"),
  {
    kind: "api",
    localUrl: "http://127.0.0.1:8003/api/identity/admin/users?page=1",
  },
);
for (const url of [
  "https://api.vayada.com/users",
  "https://booking-api.vayada.com/bookings",
  "https://pms-api.vayada.com/rooms",
  "https://marketplace-api.vayada.com/offers",
  "https://next-booking.vayada.com/hotel",
]) {
  assert.deepEqual(routeTarget(url), { kind: "blocked", legacy: true });
}
assert.deepEqual(routeTarget("https://fonts.example.test/font.woff2"), {
  kind: "blocked",
  legacy: false,
});

for (const file of [
  "migration-rehearsal-browser.mjs",
  "migration-rehearsal-browser-runner.mjs",
]) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  assert(!source.includes('client.query("COMMIT")'));
  assert(!/api\.vayada\.com\/auth\/password\/login/.test(source));
  assert(
    !/WORKOS_API_KEY|RESEND_API_KEY|STRIPE_SECRET|CHANNEX_API_KEY/.test(source),
  );
}

console.log(
  "PASS: exact virtual origins rewrite task-locally, legacy hosts block, results bind digests, and token disclosure fails",
);
