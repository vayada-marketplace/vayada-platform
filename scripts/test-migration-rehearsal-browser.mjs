import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  browserProof,
  validateBrowserResult,
} from "./migration-rehearsal-browser.mjs";
import {
  apiPreflightResponse,
  browserProcessEnv,
  corsProofRequestKind,
  fetchTaskLocalRoute,
  installContextRouteFallback,
  installRoutes,
  isUserListGet,
  parseReadyJson,
  requireUserListResponse,
  runBrowserCorsProof,
  runRoutedContext,
  routeTarget,
} from "./migration-rehearsal-browser-runner.mjs";
import { binding } from "./migration-rehearsal-reader-contract.mjs";
import {
  attestTaskRuntime,
  expectedTaskImages,
} from "./migration-rehearsal-task-images.mjs";

const token = "header.payload.signature";
assert.deepEqual(browserProcessEnv, {
  HOME: "/home/pwuser",
  LANG: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TMPDIR: "/tmp",
});
const taskArn =
  "arn:aws:ecs:eu-west-1:269416271598:task/vayada-backend-cluster/0123456789abcdef0123456789abcdef";
const runtime = { taskArn, images: expectedTaskImages };
const result = {
  status: "PASS",
  scope: "task-local-admin-browser",
  runId: binding.runId,
  release: binding.release,
  virtualOrigin: "https://next-admin.vayada.com",
  taskArn,
  runtimeImages: expectedTaskImages,
  checks: browserProof.expectedChecks,
  network: {
    frontendRequests: 12,
    apiRequests: 1,
    apiPreflightRequests: 0,
    corsProofPreflightRequests: 1,
    corsProofGetRequests: 1,
    corsProofAuthorizationMatches: 1,
    userListRequests: 1,
    userListAuthorizationMatches: 1,
    blockedExternalRequests: 2,
    legacyRequests: 0,
  },
  authenticatedRows: 4,
  pageErrors: 0,
  positivePublicProfileProven: false,
  positivePublicMediaProven: false,
  fullSmokeAccepted: false,
};
assert.equal(validateBrowserResult(result, token, runtime), result);

for (const changed of [
  { status: "FAIL" },
  { runId: "other" },
  { release: "other" },
  { virtualOrigin: "https://admin.vayada.com" },
  { taskArn: taskArn.replace(/.$/, "0") },
  { runtimeImages: { ...expectedTaskImages, browser: "sha256:other" } },
  { checks: ["login-page"] },
  { network: { ...result.network, apiRequests: 0 } },
  { network: { ...result.network, apiPreflightRequests: -1 } },
  { network: { ...result.network, corsProofPreflightRequests: 0 } },
  { network: { ...result.network, corsProofGetRequests: 0 } },
  { network: { ...result.network, corsProofAuthorizationMatches: 0 } },
  { network: { ...result.network, userListAuthorizationMatches: 0 } },
  { network: { ...result.network, legacyRequests: 1 } },
  { authenticatedRows: 0 },
  { pageErrors: 1 },
  { positivePublicProfileProven: true },
  { positivePublicMediaProven: undefined },
  { fullSmokeAccepted: true },
]) {
  assert.throws(() =>
    validateBrowserResult({ ...result, ...changed }, token, runtime),
  );
}
assert.throws(() =>
  validateBrowserResult({ ...result, disclosed: token }, token, runtime),
);

const metadata = {
  TaskARN: taskArn,
  Containers: Object.entries(expectedTaskImages).map(([Name, ImageID]) => ({
    Name,
    ImageID,
  })),
};
const metadataEnv = {
  ECS_CONTAINER_METADATA_URI_V4:
    "http://169.254.170.2/v4/01234567-89ab-cdef-0123-456789abcdef",
};
let metadataCalls = 0;
const fetchMetadata = async (url, options) => {
  metadataCalls += 1;
  assert.equal(url, `${metadataEnv.ECS_CONTAINER_METADATA_URI_V4}/task`);
  assert.equal(options.redirect, "manual");
  return { status: 200, json: async () => metadata };
};
assert.deepEqual(await attestTaskRuntime(fetchMetadata, metadataEnv), runtime);
assert.equal(metadataCalls, 1);
await assert.rejects(
  attestTaskRuntime(async () => ({ status: 302 }), metadataEnv),
  /ECS_METADATA_STATUS/,
);
await assert.rejects(
  attestTaskRuntime(
    async () => ({
      status: 200,
      json: async () => ({
        ...metadata,
        Containers: metadata.Containers.map((container) =>
          container.Name === "frontend"
            ? { ...container, ImageID: "sha256:other" }
            : container,
        ),
      }),
    }),
    metadataEnv,
  ),
  /ECS_IMAGE_DIGEST_FRONTEND/,
);
await assert.rejects(
  attestTaskRuntime(fetchMetadata, {
    ECS_CONTAINER_METADATA_URI_V4: "https://metadata.example.test/v4/task",
  }),
  /ECS_METADATA_URI/,
);

assert.equal(parseReadyJson(""), undefined);
assert.equal(parseReadyJson('{"runId":'), undefined);
assert.deepEqual(parseReadyJson('{"runId":"ok"}'), { runId: "ok" });
assert.throws(() => parseReadyJson("x".repeat(16_384)), /BROWSER_READY_SIZE/);

let localFetchCalls = 0;
let fetchOptions;
const redirectRoute = {
  async fetch(options) {
    localFetchCalls += 1;
    fetchOptions = options;
    return { status: () => 302 };
  },
};
await assert.rejects(
  fetchTaskLocalRoute(
    redirectRoute,
    { kind: "api", localUrl: "http://127.0.0.1:8003/redirect" },
    { authorization: `Bearer ${token}` },
  ),
  /BROWSER_LOCAL_REDIRECT/,
);
assert.equal(localFetchCalls, 1);
assert.equal(fetchOptions.maxRedirects, 0);
assert.equal(fetchOptions.url, "http://127.0.0.1:8003/redirect");
let escapedFetchCalls = 0;
await assert.rejects(
  fetchTaskLocalRoute(
    {
      async fetch() {
        escapedFetchCalls += 1;
      },
    },
    { kind: "api", localUrl: "http://169.254.170.2/v4/task" },
    { authorization: `Bearer ${token}` },
  ),
  /BROWSER_LOCAL_TARGET/,
);
assert.equal(escapedFetchCalls, 0);

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
for (const path of ["//attacker.example/collect", "//169.254.170.2/v4/task"]) {
  assert.deepEqual(routeTarget(`https://next-api.vayada.com${path}`), {
    kind: "api",
    localUrl: `http://127.0.0.1:8003${path}`,
  });
}

const request = (
  method,
  headers = {},
  url = "https://next-api.vayada.com/api/identity/admin/users?page=1",
) => ({
  method: () => method,
  url: () => url,
  headers: () => headers,
});
const preflightRequest = request("OPTIONS", {
  origin: "https://next-admin.vayada.com",
  "access-control-request-method": "GET",
  "access-control-request-headers": "authorization",
});
assert.deepEqual(apiPreflightResponse(preflightRequest), {
  status: 204,
  headers: {
    "access-control-allow-origin": "https://next-admin.vayada.com",
    "access-control-allow-credentials": "true",
    vary: "Origin",
    "access-control-allow-headers": "authorization",
    "access-control-allow-methods": "GET",
    "access-control-max-age": "0",
  },
  body: "",
});
assert.throws(
  () =>
    apiPreflightResponse(
      request(
        "OPTIONS",
        preflightRequest.headers(),
        "https://next-api.vayada.com/api/identity/admin/users/other",
      ),
    ),
  /BROWSER_API_PREFLIGHT/,
);
assert.throws(
  () =>
    apiPreflightResponse(
      request("OPTIONS", {
        origin: "https://next-admin.vayada.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization, x-unreviewed",
      }),
    ),
  /BROWSER_API_PREFLIGHT/,
);
const getRequest = request("GET", {
  origin: "https://next-admin.vayada.com",
  authorization: `Bearer ${token}`,
});
assert.equal(isUserListGet(getRequest), true);
assert.equal(isUserListGet(request("OPTIONS")), false);
let routeHandler;
const network = {
  frontendRequests: 0,
  apiRequests: 0,
  apiPreflightRequests: 0,
  corsProofPreflightRequests: 0,
  corsProofGetRequests: 0,
  corsProofAuthorizationMatches: 0,
  userListRequests: 0,
  userListAuthorizationMatches: 0,
  blockedExternalRequests: 0,
  legacyRequests: 0,
};
await installRoutes(
  {
    async route(_pattern, handler) {
      routeHandler = handler;
    },
  },
  token,
  network,
);
const fulfilled = [];
await routeHandler({
  request: () => preflightRequest,
  async fetch() {
    throw new Error("PREFLIGHT_ESCAPED");
  },
  async fulfill(value) {
    fulfilled.push(value);
  },
});
const localResponse = {
  status: () => 200,
  headers: () => ({ "content-type": "application/json" }),
};
await routeHandler({
  request: () => getRequest,
  async fetch(options) {
    assert.equal(
      options.url,
      "http://127.0.0.1:8003/api/identity/admin/users?page=1",
    );
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    return localResponse;
  },
  async fulfill(value) {
    fulfilled.push(value);
  },
  async abort() {},
});
assert.equal(network.apiPreflightRequests, 1);
assert.equal(network.corsProofPreflightRequests, 0);
assert.equal(network.corsProofGetRequests, 0);
assert.equal(network.corsProofAuthorizationMatches, 0);
assert.equal(network.userListRequests, 1);
assert.equal(network.userListAuthorizationMatches, 1);
assert.equal(fulfilled[0].status, 204);
assert.equal(
  fulfilled[1].headers["access-control-allow-origin"],
  "https://next-admin.vayada.com",
);

const corsSourceOrigin = "http://127.0.0.1:45678";
assert.equal(
  corsProofRequestKind(
    {
      method: "OPTIONS",
      url: "/cors-proof",
      headers: {
        origin: corsSourceOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    },
    corsSourceOrigin,
  ),
  "preflight",
);
assert.equal(
  corsProofRequestKind(
    {
      method: "GET",
      url: "/cors-proof",
      headers: {
        origin: corsSourceOrigin,
        authorization: "Bearer browser-cors-proof",
      },
    },
    corsSourceOrigin,
  ),
  "get",
);
for (const invalid of [
  { method: "GET", url: "/wrong", headers: {} },
  {
    method: "OPTIONS",
    url: "/cors-proof",
    headers: {
      origin: "http://127.0.0.1:1",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  },
  {
    method: "OPTIONS",
    url: "/cors-proof",
    headers: {
      origin: corsSourceOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization, x-unreviewed",
    },
  },
  {
    method: "GET",
    url: "/cors-proof",
    headers: {
      origin: corsSourceOrigin,
      authorization: "Bearer wrong",
    },
  },
]) {
  assert.throws(
    () => corsProofRequestKind(invalid, corsSourceOrigin),
    /BROWSER_CORS_PROOF/,
  );
}

let corsContextCloses = 0;
let navigatedSourceOrigin;
let corsFetchCalls = 0;
let corsNetwork;
const corsTimeouts = [];
const fakeCorsBrowser = (close) => ({
  async newContext(options) {
    assert.deepEqual(options, { serviceWorkers: "block" });
    return {
      async newPage() {
        return {
          async goto(url, options) {
            assert.deepEqual(options, { waitUntil: "domcontentloaded" });
            navigatedSourceOrigin = new URL(url).origin;
          },
          url() {
            return `${navigatedSourceOrigin}/source`;
          },
          async evaluate(callback, targetUrl) {
            return callback(targetUrl);
          },
        };
      },
      async close() {
        corsContextCloses += 1;
        await close?.();
      },
    };
  },
});
const originalCorsFetch = globalThis.fetch;
const originalCorsTimeout = AbortSignal.timeout;
try {
  AbortSignal.timeout = (milliseconds) => {
    corsTimeouts.push(milliseconds);
    return originalCorsTimeout(milliseconds);
  };
  globalThis.fetch = async (targetUrl, options) => {
    corsFetchCalls += 1;
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, {
      authorization: "Bearer browser-cors-proof",
    });
    const preflight = await originalCorsFetch(targetUrl, {
      method: "OPTIONS",
      headers: {
        origin: navigatedSourceOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    return originalCorsFetch(targetUrl, {
      method: options.method,
      headers: { origin: navigatedSourceOrigin, ...options.headers },
    });
  };
  corsNetwork = await runBrowserCorsProof(fakeCorsBrowser());
  await assert.rejects(
    runBrowserCorsProof(
      fakeCorsBrowser(async () => {
        const response = await originalCorsFetch(
          `${navigatedSourceOrigin}/unexpected`,
        );
        assert.equal(response.status, 404);
      }),
    ),
    /BROWSER_CORS_PROOF_RESPONSE/,
  );
} finally {
  globalThis.fetch = originalCorsFetch;
  AbortSignal.timeout = originalCorsTimeout;
}
assert.deepEqual(corsNetwork, {
  corsProofPreflightRequests: 1,
  corsProofGetRequests: 1,
  corsProofAuthorizationMatches: 1,
});
assert.equal(corsFetchCalls, 2);
assert.deepEqual(corsTimeouts, [10_000, 10_000]);
assert.equal(corsContextCloses, 2);
const corsRunFailure = new Error("SYNTHETIC_CORS_RUN_FAILURE");
const corsCloseFailure = new Error("SYNTHETIC_CORS_CLOSE_FAILURE");
await assert.rejects(
  runBrowserCorsProof({
    async newContext() {
      return {
        async newPage() {
          return {
            async goto() {
              throw corsRunFailure;
            },
          };
        },
        async close() {
          throw corsCloseFailure;
        },
      };
    },
  }),
  (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.message, "BROWSER_CORS_PROOF_AND_TEARDOWN_FAILED");
    assert.deepEqual(error.errors, [corsRunFailure, corsCloseFailure]);
    return true;
  },
);
let fallbackHandler;
const fallback = await installContextRouteFallback(
  {
    async route(pattern, handler) {
      assert.equal(pattern, "**/*");
      fallbackHandler = handler;
    },
  },
  network,
);
let fallbackAborts = 0;
const teardownOrder = [];
let finishRoute;
const routeFinished = new Promise((resolve) => {
  finishRoute = resolve;
});
let teardownFinished = false;
const scenarioFailure = new Error("SYNTHETIC_SCENARIO_FAILURE");
const teardown = runRoutedContext(
  {
    async unrouteAll(options) {
      assert.deepEqual(options, { behavior: "wait" });
      teardownOrder.push("routes-draining");
      await routeFinished;
      teardownOrder.push("routes-drained");
    },
    async close(options) {
      assert.deepEqual(options, { runBeforeUnload: false });
      teardownOrder.push("page-closed");
    },
  },
  {
    async close() {
      teardownOrder.push("context-closed");
    },
  },
  fallback,
  async () => {
    throw scenarioFailure;
  },
).then(() => {
  teardownFinished = true;
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(teardownFinished, false);
assert.deepEqual(teardownOrder, ["routes-draining"]);
await fallbackHandler({
  request: () =>
    request("GET", {}, "https://next-admin.vayada.com/late-chunk.js"),
  async abort(reason) {
    assert.equal(reason, "blockedbyclient");
    fallbackAborts += 1;
  },
});
assert.equal(fallbackAborts, 1);
finishRoute();
await assert.rejects(teardown, (error) => error === scenarioFailure);
assert.deepEqual(teardownOrder, [
  "routes-draining",
  "routes-drained",
  "page-closed",
  "context-closed",
]);
let pendingFallbackHandler;
const pendingFallback = await installContextRouteFallback(
  {
    async route(_pattern, handler) {
      pendingFallbackHandler = handler;
    },
  },
  network,
);
const deferredAbortFailure = new Error("SYNTHETIC_DEFERRED_ABORT_FAILURE");
let rejectDeferredAbort;
const deferredAbort = new Promise((_resolve, reject) => {
  rejectDeferredAbort = reject;
});
const pendingFallbackRun = pendingFallbackHandler({
  request: () => request("GET", {}, "https://next-admin.vayada.com/late-poll"),
  abort: () => deferredAbort,
});
let pendingTeardownFinished = false;
const pendingTeardown = runRoutedContext(
  {
    async unrouteAll() {},
    async close() {},
  },
  { async close() {} },
  pendingFallback,
  async () => "PASS",
).then(() => {
  pendingTeardownFinished = true;
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pendingTeardownFinished, false);
rejectDeferredAbort(deferredAbortFailure);
await pendingFallbackRun;
await assert.rejects(
  pendingTeardown,
  (error) => error === deferredAbortFailure,
);
const runFailure = new Error("SYNTHETIC_RUN_FAILURE");
const unrouteFailure = new Error("SYNTHETIC_UNROUTE_FAILURE");
const contextCloseFailure = new Error("SYNTHETIC_CONTEXT_CLOSE_FAILURE");
const fallbackAbortFailure = new Error("SYNTHETIC_FALLBACK_ABORT_FAILURE");
const failedTeardownOrder = [];
await assert.rejects(
  runRoutedContext(
    {
      async unrouteAll() {
        failedTeardownOrder.push("routes-draining");
        throw unrouteFailure;
      },
      async close() {
        failedTeardownOrder.push("page-closed");
      },
    },
    {
      async close() {
        failedTeardownOrder.push("context-closed");
        throw contextCloseFailure;
      },
    },
    { abortFailure: fallbackAbortFailure, pending: new Set() },
    async () => {
      throw runFailure;
    },
  ),
  (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.message, "BROWSER_SCENARIO_AND_TEARDOWN_FAILED");
    assert.equal(error.errors[0], runFailure);
    assert(error.errors[1] instanceof AggregateError);
    assert.deepEqual(error.errors[1].errors, [
      unrouteFailure,
      contextCloseFailure,
      fallbackAbortFailure,
    ]);
    return true;
  },
);
assert.deepEqual(failedTeardownOrder, [
  "routes-draining",
  "page-closed",
  "context-closed",
]);
requireUserListResponse({ request: () => getRequest, status: () => 200 });
assert.throws(
  () =>
    requireUserListResponse({ request: () => getRequest, status: () => 500 }),
  /BROWSER_USER_LIST_STATUS/,
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
  "migration-rehearsal-task-images.mjs",
]) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  assert(!source.includes('client.query("COMMIT")'));
  assert(!/api\.vayada\.com\/auth\/password\/login/.test(source));
  assert(
    !/WORKOS_API_KEY|RESEND_API_KEY|STRIPE_SECRET|STRIPE_WEBHOOK_SECRET|CHANNEX_API_KEY|AUTH_COOKIE_SECRET|WORKOS_WEBHOOK_SECRET/.test(
      source,
    ),
  );
}

console.log(
  "PASS: runtime digests attest, browser CORS proof is exact, redirects fail closed, virtual origins stay task-local, readiness retries, and token disclosure fails",
);
