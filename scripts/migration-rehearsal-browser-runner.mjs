// VAY-1361 Chromium proof. Both virtual next origins are fulfilled from task-local HTTP.
import { readFile, rename, writeFile } from "node:fs/promises";
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
const checks = [
  "login-page",
  "unauthenticated-dashboard-denial",
  "authenticated-user-list",
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
  });
  try {
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
