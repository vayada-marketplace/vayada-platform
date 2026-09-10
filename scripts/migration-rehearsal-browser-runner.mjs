// VAY-1361 Chromium proof. Both virtual next origins are fulfilled from task-local HTTP.
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import {
  binding,
  requireTrue,
} from "./migration-rehearsal-reader-contract.mjs";
import { attestTaskRuntime } from "./migration-rehearsal-task-images.mjs";

const exchangeDir = "/shared";
const readyPath = `${exchangeDir}/browser-ready.json`;
const resultPath = `${exchangeDir}/browser-result.json`;
const resultTempPath = `${exchangeDir}/browser-result.tmp`;
const virtualFrontend = "https://next-admin.vayada.com";
const virtualApi = "https://next-api.vayada.com";
const localFrontend = "http://127.0.0.1:3001";
const localApi = "http://127.0.0.1:8003";
export const browserProcessEnv = Object.freeze({
  HOME: "/home/pwuser",
  LANG: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TMPDIR: "/tmp",
});
const checks = [
  "login-page",
  "unauthenticated-dashboard-denial",
  "authenticated-user-list",
  "browser-cors-preflight",
  "task-local-api-routing",
  "no-legacy-network",
];

function loopbackRequestUrl(source, localOrigin) {
  const local = new URL(localOrigin);
  local.pathname = source.pathname;
  local.search = source.search;
  return local.href;
}

export function routeTarget(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin === virtualFrontend) {
    return {
      kind: "frontend",
      localUrl: loopbackRequestUrl(url, localFrontend),
    };
  }
  if (url.origin === virtualApi) {
    return {
      kind: "api",
      localUrl: loopbackRequestUrl(url, localApi),
    };
  }
  return {
    kind: "blocked",
    legacy:
      url.hostname === "vayada.com" || url.hostname.endsWith(".vayada.com"),
  };
}

export function parseReadyJson(raw) {
  if (raw === "") return undefined;
  requireTrue(raw.length < 16_384, "BROWSER_READY_SIZE");
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function waitForJson(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (raw !== undefined) {
      const parsed = parseReadyJson(raw);
      if (parsed !== undefined) return parsed;
    }
    await delay(500);
  }
  throw new Error("BROWSER_READY_TIMEOUT");
}

async function waitForHttp(url, expected, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      if (expected(response)) return;
    } catch {}
    await delay(500);
  }
  throw new Error("BROWSER_LOCAL_SERVER_TIMEOUT");
}

export async function fetchTaskLocalRoute(route, target, headers) {
  const expectedOrigin =
    target.kind === "frontend"
      ? localFrontend
      : target.kind === "api"
        ? localApi
        : undefined;
  const local = new URL(target.localUrl);
  requireTrue(
    expectedOrigin &&
      local.origin === expectedOrigin &&
      !local.username &&
      !local.password,
    "BROWSER_LOCAL_TARGET",
  );
  const response = await route.fetch({
    url: local.href,
    headers,
    timeout: 10_000,
    maxRedirects: 0,
  });
  const status = response.status();
  requireTrue(status < 300 || status >= 400, "BROWSER_LOCAL_REDIRECT");
  return response;
}

export function isUserListGet(request) {
  const url = new URL(request.url());
  return (
    request.method() === "GET" &&
    url.origin === virtualApi &&
    url.pathname === "/api/identity/admin/users"
  );
}

function apiCorsHeaders() {
  return {
    "access-control-allow-origin": virtualFrontend,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

export function apiPreflightResponse(request) {
  const headers = request.headers();
  const url = new URL(request.url());
  const requestedHeaders = (headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  requireTrue(
    request.method() === "OPTIONS" &&
      url.origin === virtualApi &&
      url.pathname === "/api/identity/admin/users" &&
      headers.origin === virtualFrontend &&
      headers["access-control-request-method"] === "GET" &&
      JSON.stringify(requestedHeaders) === JSON.stringify(["authorization"]),
    "BROWSER_API_PREFLIGHT",
  );
  return {
    status: 204,
    headers: {
      ...apiCorsHeaders(),
      "access-control-allow-headers": "authorization",
      "access-control-allow-methods": "GET",
      "access-control-max-age": "0",
    },
    body: "",
  };
}

export function requireUserListResponse(response) {
  requireTrue(
    isUserListGet(response.request()) && response.status() === 200,
    "BROWSER_USER_LIST_STATUS",
  );
}

export async function installRoutes(page, token, network) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const target = routeTarget(request.url());
    if (target.kind === "blocked") {
      network.blockedExternalRequests += 1;
      if (target.legacy) network.legacyRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (target.kind === "api" && request.method() === "OPTIONS") {
      network.apiPreflightRequests += 1;
      await route.fulfill(apiPreflightResponse(request));
      return;
    }
    const headers = { ...request.headers() };
    delete headers.host;
    if (target.kind === "api") {
      requireTrue(
        request.method() === "GET" && headers.origin === virtualFrontend,
        "BROWSER_API_REQUEST",
      );
    }
    let response;
    try {
      response = await fetchTaskLocalRoute(route, target, headers);
    } catch (error) {
      await route.abort("blockedbyclient").catch(() => {});
      throw error;
    }
    if (target.kind === "frontend") network.frontendRequests += 1;
    if (target.kind === "api") {
      network.apiRequests += 1;
      if (isUserListGet(request)) {
        network.userListRequests += 1;
        if (request.headers()["authorization"] === `Bearer ${token}`) {
          network.userListAuthorizationMatches += 1;
        }
      }
    }
    await route.fulfill(
      target.kind === "api"
        ? { response, headers: { ...response.headers(), ...apiCorsHeaders() } }
        : { response },
    );
  });
}

const listenLoopback = (server, onRuntimeError) =>
  new Promise((resolve, reject) => {
    const onListenError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onListenError);
      server.on("error", onRuntimeError);
      resolve();
    };
    server.once("error", onListenError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

const closeLoopback = (server) =>
  new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });

export function corsProofRequestKind(request, sourceOrigin) {
  const url = new URL(request.url ?? "", "http://127.0.0.1");
  requireTrue(
    url.pathname === "/cors-proof" && !url.search,
    "BROWSER_CORS_PROOF_PATH",
  );
  requireTrue(
    request.headers.origin === sourceOrigin,
    "BROWSER_CORS_PROOF_ORIGIN",
  );
  if (request.method === "OPTIONS") {
    const requestedHeaders = (
      request.headers["access-control-request-headers"] ?? ""
    )
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
      .sort();
    requireTrue(
      request.headers["access-control-request-method"] === "GET" &&
        JSON.stringify(requestedHeaders) === JSON.stringify(["authorization"]) &&
        request.headers.authorization === undefined,
      "BROWSER_CORS_PROOF_PREFLIGHT",
    );
    return "preflight";
  }
  requireTrue(
    request.method === "GET" &&
      request.headers.authorization === "Bearer browser-cors-proof",
    "BROWSER_CORS_PROOF_GET",
  );
  return "get";
}

export async function runBrowserCorsProof(browser) {
  const state = {
    corsProofPreflightRequests: 0,
    corsProofGetRequests: 0,
    corsProofAuthorizationMatches: 0,
    failure: undefined,
  };
  let targetOrigin;
  const source = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/source") {
      state.failure ??= "BROWSER_CORS_PROOF_SOURCE_REQUEST";
      response.writeHead(404, { connection: "close" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        `default-src 'none'; img-src data:; connect-src ${targetOrigin}`,
      "x-content-type-options": "nosniff",
    });
    response.end(
      '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>CORS proof</title>',
    );
  });
  source.on("clientError", (_error, socket) => {
    state.failure ??= "BROWSER_CORS_PROOF_SOURCE_CLIENT";
    socket.destroy();
  });
  let target;
  let context;
  let proof;
  let result;
  let runFailure;
  try {
    await listenLoopback(source, () => {
      state.failure ??= "BROWSER_CORS_PROOF_SOURCE_SERVER";
    });
    const sourceAddress = source.address();
    requireTrue(
      sourceAddress &&
        typeof sourceAddress === "object" &&
        sourceAddress.address === "127.0.0.1",
      "BROWSER_CORS_PROOF_SOURCE_BINDING",
    );
    const sourceOrigin = `http://127.0.0.1:${sourceAddress.port}`;
    target = createServer((request, response) => {
      let kind;
      try {
        kind = corsProofRequestKind(request, sourceOrigin);
      } catch (error) {
        state.failure ??= /^[A-Z0-9_]+$/.test(error?.message ?? "")
          ? error.message
          : "BROWSER_CORS_PROOF_REQUEST";
        response.writeHead(400, { connection: "close" });
        response.end();
        return;
      }
      const corsHeaders = {
        "access-control-allow-origin": sourceOrigin,
        vary: "Origin",
      };
      if (kind === "preflight") {
        state.corsProofPreflightRequests += 1;
        response.writeHead(204, {
          ...corsHeaders,
          "access-control-allow-headers": "authorization",
          "access-control-allow-methods": "GET",
          "access-control-max-age": "0",
        });
        response.end();
        return;
      }
      state.corsProofGetRequests += 1;
      state.corsProofAuthorizationMatches += 1;
      response.writeHead(200, {
        ...corsHeaders,
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
      });
      response.end('{"status":"ok"}');
    });
    target.on("clientError", (_error, socket) => {
      state.failure ??= "BROWSER_CORS_PROOF_TARGET_CLIENT";
      socket.destroy();
    });
    await listenLoopback(target, () => {
      state.failure ??= "BROWSER_CORS_PROOF_TARGET_SERVER";
    });
    const targetAddress = target.address();
    requireTrue(
      targetAddress &&
        typeof targetAddress === "object" &&
        targetAddress.address === "127.0.0.1",
      "BROWSER_CORS_PROOF_TARGET_BINDING",
    );
    targetOrigin = `http://127.0.0.1:${targetAddress.port}`;
    context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(`${sourceOrigin}/source`, {
      waitUntil: "domcontentloaded",
    });
    requireTrue(
      page.url() === `${sourceOrigin}/source`,
      "BROWSER_CORS_PROOF_SOURCE_URL",
    );
    proof = await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: "Bearer browser-cors-proof" },
      });
      return { status: response.status, body: await response.json() };
    }, `${targetOrigin}/cors-proof`);
  } catch (error) {
    runFailure = error;
  }
  const teardownFailures = [];
  for (const teardown of [
    () => context?.close(),
    () => closeLoopback(target),
    () => closeLoopback(source),
  ]) {
    try {
      await teardown();
    } catch (error) {
      teardownFailures.push(error);
    }
  }
  let validationFailure;
  if (!runFailure) {
    try {
      requireTrue(
        proof?.status === 200 &&
          proof.body?.status === "ok" &&
          !state.failure,
        "BROWSER_CORS_PROOF_RESPONSE",
      );
      requireTrue(
        state.corsProofPreflightRequests === 1 &&
          state.corsProofGetRequests === 1 &&
          state.corsProofAuthorizationMatches === 1,
        "BROWSER_CORS_PROOF_COUNTS",
      );
      result = {
        corsProofPreflightRequests: state.corsProofPreflightRequests,
        corsProofGetRequests: state.corsProofGetRequests,
        corsProofAuthorizationMatches: state.corsProofAuthorizationMatches,
      };
    } catch (error) {
      validationFailure = error;
    }
  }
  const failures = [
    runFailure,
    validationFailure,
    ...teardownFailures,
  ].filter(Boolean);
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      runFailure || validationFailure
        ? "BROWSER_CORS_PROOF_AND_TEARDOWN_FAILED"
        : "BROWSER_CORS_PROOF_TEARDOWN_FAILED",
    );
  }
  if (failures.length === 1) throw failures[0];
  return result;
}

export async function installContextRouteFallback(context, network) {
  const state = { abortFailure: undefined, pending: new Set() };
  await context.route("**/*", async (route) => {
    network.blockedExternalRequests += 1;
    if (routeTarget(route.request().url()).legacy) {
      network.legacyRequests += 1;
    }
    const abort = route.abort("blockedbyclient").catch((error) => {
      state.abortFailure ??= error;
    });
    state.pending.add(abort);
    try {
      await abort;
    } finally {
      state.pending.delete(abort);
    }
  });
  return state;
}

export async function runRoutedContext(page, context, fallback, run) {
  let result;
  let runFailure;
  try {
    result = await run();
  } catch (error) {
    runFailure = error;
  }
  const teardownFailures = [];
  for (const teardown of [
    () => page.unrouteAll({ behavior: "wait" }),
    () => page.close({ runBeforeUnload: false }),
    () => context.close(),
  ]) {
    try {
      await teardown();
    } catch (error) {
      teardownFailures.push(error);
    }
  }
  while (fallback.pending.size > 0) {
    await Promise.allSettled([...fallback.pending]);
  }
  if (fallback.abortFailure) teardownFailures.push(fallback.abortFailure);
  const teardownFailure =
    teardownFailures.length > 1
      ? new AggregateError(
          teardownFailures,
          "BROWSER_ROUTE_AND_CONTEXT_TEARDOWN_FAILED",
        )
      : teardownFailures[0];
  if (runFailure && teardownFailure) {
    throw new AggregateError(
      [runFailure, teardownFailure],
      "BROWSER_SCENARIO_AND_TEARDOWN_FAILED",
    );
  }
  if (runFailure) throw runFailure;
  if (teardownFailure) throw teardownFailure;
  return result;
}

function storageSession({ token, expiresAt, userId }) {
  localStorage.setItem("access_token", token);
  localStorage.setItem("token_expires_at", String(expiresAt * 1000));
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", userId);
  localStorage.setItem("userEmail", "f.maliqi+codex-admin@vayada.com");
  localStorage.setItem("userStatus", "active");
  localStorage.setItem("isSuperAdmin", "true");
  localStorage.setItem(
    "user",
    JSON.stringify({
      id: userId,
      email: "f.maliqi+codex-admin@vayada.com",
      status: "active",
      is_superadmin: true,
    }),
  );
}

export async function runBrowserProof(chromium, env) {
  requireTrue(
    env.BROWSER_EXCHANGE_DIR === exchangeDir,
    "BROWSER_EXCHANGE_SCOPE",
  );
  const runtime = await attestTaskRuntime(fetch, env);
  const token = env.REHEARSAL_TEST_SESSION;
  requireTrue(
    typeof token === "string" && token.length < 16_000,
    "TEST_SESSION_REQUIRED",
  );
  const tokenPayload = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  );
  requireTrue(
    Number.isSafeInteger(tokenPayload.exp) &&
      tokenPayload.exp * 1000 > Date.now() + 10_000,
    "TEST_TOKEN_EXPIRED",
  );
  const ready = await waitForJson(readyPath, 180_000);
  requireTrue(
    ready.runId === binding.runId &&
      ready.release === binding.release &&
      ready.userId === "21630265-3a7f-40f6-9569-cd06016bedac" &&
      ready.expiresAt === tokenPayload.exp &&
      ready.taskArn === runtime.taskArn,
    "BROWSER_READY_BINDING",
  );
  await waitForHttp(
    `${localApi}/health`,
    (response) => response.status === 200,
  );
  await waitForHttp(
    `${localFrontend}/login`,
    (response) => response.status === 200,
  );

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
  let pageErrors = 0;
  let authenticatedRows = 0;
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
    env: browserProcessEnv,
  });
  try {
    Object.assign(network, await runBrowserCorsProof(browser));
    const loginContext = await browser.newContext({ serviceWorkers: "block" });
    const loginFallback = await installContextRouteFallback(
      loginContext,
      network,
    );
    const loginPage = await loginContext.newPage();
    await runRoutedContext(loginPage, loginContext, loginFallback, async () => {
      loginPage.on("pageerror", () => {
        pageErrors += 1;
      });
      await installRoutes(loginPage, token, network);
      await loginPage.goto(`${virtualFrontend}/login`, {
        waitUntil: "domcontentloaded",
      });
      await loginPage
        .getByRole("heading", { name: /vayada admin/i, level: 1 })
        .waitFor();
      await loginPage.getByLabel(/email address/i).waitFor();
      await loginPage.getByLabel(/^password$/i).waitFor();
      await loginPage.getByRole("button", { name: /sign in/i }).waitFor();
    });

    const deniedContext = await browser.newContext({ serviceWorkers: "block" });
    const deniedFallback = await installContextRouteFallback(
      deniedContext,
      network,
    );
    const deniedPage = await deniedContext.newPage();
    await runRoutedContext(
      deniedPage,
      deniedContext,
      deniedFallback,
      async () => {
        deniedPage.on("pageerror", () => {
          pageErrors += 1;
        });
        await installRoutes(deniedPage, token, network);
        await deniedPage.goto(`${virtualFrontend}/dashboard`, {
          waitUntil: "domcontentloaded",
        });
        await deniedPage.waitForURL(/\/login\?expired=true$/, {
          timeout: 15_000,
        });
        requireTrue(
          (await deniedPage.locator("tbody tr").count()) === 0,
          "BROWSER_DENIED_DATA",
        );
      },
    );

    const context = await browser.newContext({ serviceWorkers: "block" });
    const fallback = await installContextRouteFallback(context, network);
    await context.addInitScript(storageSession, {
      token,
      expiresAt: tokenPayload.exp,
      userId: ready.userId,
    });
    const page = await context.newPage();
    authenticatedRows = await runRoutedContext(
      page,
      context,
      fallback,
      async () => {
        page.on("pageerror", () => {
          pageErrors += 1;
        });
        await installRoutes(page, token, network);
        const [userListResponse] = await Promise.all([
          page.waitForResponse((response) => isUserListGet(response.request())),
          page.goto(`${virtualFrontend}/dashboard`, {
            waitUntil: "domcontentloaded",
          }),
        ]);
        requireUserListResponse(userListResponse);
        await page
          .getByRole("heading", { name: "Users", level: 1 })
          .waitFor({ timeout: 20_000 });
        await page.locator("tbody tr").first().waitFor({ timeout: 20_000 });
        const rows = await page.locator("tbody tr").count();
        requireTrue(rows > 0, "BROWSER_NO_AUTHENTICATED_ROWS");
        requireTrue(
          (await page
            .getByText(
              /failed to load users|access denied|authentication failed/i,
            )
            .count()) === 0,
          "BROWSER_UI_ERROR",
        );
        return rows;
      },
    );
  } finally {
    await browser.close().catch(() => {});
  }
  requireTrue(network.userListRequests > 0, "BROWSER_USER_LIST_MISSING");
  requireTrue(
    network.userListAuthorizationMatches === network.userListRequests,
    "BROWSER_AUTHORIZATION_HEADER",
  );
  requireTrue(
    network.corsProofPreflightRequests === 1 &&
      network.corsProofGetRequests === 1 &&
      network.corsProofAuthorizationMatches === 1,
    "BROWSER_CORS_PROOF",
  );
  requireTrue(network.legacyRequests === 0, "BROWSER_LEGACY_NETWORK");
  requireTrue(pageErrors === 0, "BROWSER_PAGE_ERROR");
  return {
    status: "PASS",
    scope: "task-local-admin-browser",
    runId: binding.runId,
    release: binding.release,
    virtualOrigin: virtualFrontend,
    taskArn: runtime.taskArn,
    runtimeImages: runtime.images,
    checks,
    network,
    authenticatedRows,
    pageErrors,
    positivePublicProfileProven: false,
    positivePublicMediaProven: false,
    fullSmokeAccepted: false,
  };
}

export async function writeBrowserResult(result) {
  const raw = JSON.stringify(result);
  requireTrue(raw.length > 0 && raw.length < 16_384, "BROWSER_RESULT_SIZE");
  await writeFile(resultTempPath, raw, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(resultTempPath, resultPath);
}
