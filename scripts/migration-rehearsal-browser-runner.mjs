// VAY-1361 Chromium proof. Both virtual next origins are fulfilled from task-local HTTP.
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  binding,
  requireTrue,
} from "./migration-rehearsal-reader-contract.mjs";

const exchangeDir = "/shared";
const readyPath = `${exchangeDir}/browser-ready.json`;
const resultPath = `${exchangeDir}/browser-result.json`;
const resultTempPath = `${exchangeDir}/browser-result.tmp`;
const virtualFrontend = "https://next-admin.vayada.com";
const virtualApi = "https://next-api.vayada.com";
const localFrontend = "http://127.0.0.1:3001";
const localApi = "http://127.0.0.1:8003";
const frontendDigest =
  "sha256:471b755e8596adde20bc87951bb8eed682d2d3265280ba0a7a8a48cfa81ae59b";
const browserDigest =
  "sha256:83192064c7510f7ee73dd63dc5f22a5e01a92c81a2e6a9c715d9e3fe55471fd9";
const checks = [
  "login-page",
  "unauthenticated-dashboard-denial",
  "authenticated-user-list",
  "task-local-api-routing",
  "no-legacy-network",
];

export function routeTarget(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin === virtualFrontend) {
    return {
      kind: "frontend",
      localUrl: new URL(url.pathname + url.search, localFrontend).href,
    };
  }
  if (url.origin === virtualApi) {
    return {
      kind: "api",
      localUrl: new URL(url.pathname + url.search, localApi).href,
    };
  }
  return {
    kind: "blocked",
    legacy:
      url.hostname === "vayada.com" || url.hostname.endsWith(".vayada.com"),
  };
}

async function waitForJson(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, "utf8");
      requireTrue(raw.length > 0 && raw.length < 16_384, "BROWSER_READY_SIZE");
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
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

async function installRoutes(page, token, network) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const target = routeTarget(request.url());
    if (target.kind === "blocked") {
      network.blockedExternalRequests += 1;
      if (target.legacy) network.legacyRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    const headers = { ...request.headers() };
    delete headers.host;
    const response = await route.fetch({
      url: target.localUrl,
      headers,
      timeout: 10_000,
    });
    if (target.kind === "frontend") network.frontendRequests += 1;
    if (target.kind === "api") {
      network.apiRequests += 1;
      const path = new URL(request.url()).pathname;
      if (path === "/api/identity/admin/users") {
        network.userListRequests += 1;
        if (request.headers()["authorization"] === `Bearer ${token}`) {
          network.userListAuthorizationMatches += 1;
        }
        requireTrue(response.status() === 200, "BROWSER_USER_LIST_STATUS");
      }
    }
    await route.fulfill({ response });
  });
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
      ready.frontendDigest === frontendDigest &&
      ready.browserDigest === browserDigest,
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
    const loginPage = await loginContext.newPage();
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
    await loginContext.close();

    const deniedContext = await browser.newContext({ serviceWorkers: "block" });
    const deniedPage = await deniedContext.newPage();
    deniedPage.on("pageerror", () => {
      pageErrors += 1;
    });
    await installRoutes(deniedPage, token, network);
    await deniedPage.goto(`${virtualFrontend}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await deniedPage.waitForURL(/\/login\?expired=true$/, { timeout: 15_000 });
    requireTrue(
      (await deniedPage.locator("tbody tr").count()) === 0,
      "BROWSER_DENIED_DATA",
    );
    await deniedContext.close();

    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addInitScript(storageSession, {
      token,
      expiresAt: tokenPayload.exp,
      userId: ready.userId,
    });
    const page = await context.newPage();
    page.on("pageerror", () => {
      pageErrors += 1;
    });
    await installRoutes(page, token, network);
    await page.goto(`${virtualFrontend}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Users", level: 1 })
      .waitFor({ timeout: 20_000 });
    await page.locator("tbody tr").first().waitFor({ timeout: 20_000 });
    authenticatedRows = await page.locator("tbody tr").count();
    requireTrue(authenticatedRows > 0, "BROWSER_NO_AUTHENTICATED_ROWS");
    requireTrue(
      (await page
        .getByText(/failed to load users|access denied|authentication failed/i)
        .count()) === 0,
      "BROWSER_UI_ERROR",
    );
    await context.close();
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
    frontendDigest,
    browserDigest,
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
