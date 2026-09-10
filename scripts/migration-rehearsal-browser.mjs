// VAY-1361 controller for one task-local browser proof with exact cleanup.
import { createRequire } from "node:module";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  binding,
  guardedConnection,
  requireTrue,
} from "./migration-rehearsal-reader-contract.mjs";
import {
  applicationEnvironment,
  captureRows,
  runReadOnlyApplication,
} from "./migration-rehearsal-app-readonly.mjs";
import {
  installTemporaryAdmin,
  removeTemporaryAdmin,
  temporaryAdmin,
  verifyAdminSession,
} from "./migration-rehearsal-temporary-admin.mjs";

const originalData =
  "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b";
const exchangeDir = "/shared";
const readyPath = `${exchangeDir}/browser-ready.json`;
const resultPath = `${exchangeDir}/browser-result.json`;
const expectedFrontendDigest =
  "sha256:471b755e8596adde20bc87951bb8eed682d2d3265280ba0a7a8a48cfa81ae59b";
const expectedBrowserDigest =
  "sha256:83192064c7510f7ee73dd63dc5f22a5e01a92c81a2e6a9c715d9e3fe55471fd9";
const expectedChecks = [
  "login-page",
  "unauthenticated-dashboard-denial",
  "authenticated-user-list",
  "task-local-api-routing",
  "no-legacy-network",
];

export const browserProof = Object.freeze({
  exchangeDir,
  readyPath,
  resultPath,
  expectedFrontendDigest,
  expectedBrowserDigest,
  expectedChecks,
});

export function validateBrowserResult(result, token) {
  requireTrue(result && typeof result === "object", "BROWSER_RESULT_FORMAT");
  requireTrue(
    result.status === "PASS" &&
      result.scope === "task-local-admin-browser" &&
      result.runId === binding.runId &&
      result.release === binding.release &&
      result.virtualOrigin === "https://next-admin.vayada.com" &&
      result.frontendDigest === expectedFrontendDigest &&
      result.browserDigest === expectedBrowserDigest,
    "BROWSER_RESULT_BINDING",
  );
  requireTrue(
    JSON.stringify(result.checks) === JSON.stringify(expectedChecks),
    "BROWSER_CHECKS",
  );
  const network = result.network;
  requireTrue(
    network &&
      Number.isSafeInteger(network.frontendRequests) &&
      network.frontendRequests > 0 &&
      Number.isSafeInteger(network.apiRequests) &&
      network.apiRequests > 0 &&
      Number.isSafeInteger(network.userListRequests) &&
      network.userListRequests > 0 &&
      network.userListAuthorizationMatches === network.userListRequests &&
      Number.isSafeInteger(network.blockedExternalRequests) &&
      network.blockedExternalRequests >= 0 &&
      network.legacyRequests === 0,
    "BROWSER_NETWORK_PROOF",
  );
  requireTrue(
    Number.isSafeInteger(result.authenticatedRows) &&
      result.authenticatedRows > 0 &&
      result.pageErrors === 0,
    "BROWSER_UI_PROOF",
  );
  requireTrue(
    typeof token === "string" && !JSON.stringify(result).includes(token),
    "BROWSER_RESULT_DISCLOSURE",
  );
  return result;
}

async function waitForBrowserResult(token, session, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    requireTrue(
      session.expiresAt * 1000 > Date.now() + 10_000,
      "TEST_TOKEN_EXPIRED",
    );
    try {
      const raw = await readFile(resultPath, "utf8");
      requireTrue(raw.length > 0 && raw.length < 16_384, "BROWSER_RESULT_SIZE");
      const result = JSON.parse(raw);
      if (result.status === "FAIL") {
        throw new Error(
          /^[A-Z0-9_]+$/.test(result.code ?? "")
            ? result.code
            : "BROWSER_RUN_FAILED",
        );
      }
      return validateBrowserResult(result, token);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(500);
  }
  throw new Error("BROWSER_RESULT_TIMEOUT");
}

export async function runBrowserController(Client, env) {
  requireTrue(
    env.BROWSER_EXCHANGE_DIR === exchangeDir,
    "BROWSER_EXCHANGE_SCOPE",
  );
  applicationEnvironment(env);
  const token = env.REHEARSAL_TEST_SESSION;
  requireTrue(
    typeof token === "string" && token.length < 16_000,
    "TEST_SESSION_REQUIRED",
  );
  const req = createRequire(process.cwd() + "/package.json");
  const session = await req("@vayada/backend-auth").createWorkOSVerifier({
    jwksUrl: env.WORKOS_JWKS_URL,
    issuer: env.WORKOS_ISSUER,
    audience: env.WORKOS_AUDIENCE,
  })(token);
  verifyAdminSession(session);
  const admin = new Client({
    connectionString: guardedConnection(
      env.ADMIN_DATABASE_URL,
      "admin",
    ).toString(),
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=180000 -c lock_timeout=3000",
    application_name: "vay1361-browser-controller",
  });
  let installed;
  let browserResult;
  let applicationResult;
  let failure;
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    installed = await installTemporaryAdmin(admin, session);
    console.log(
      JSON.stringify({
        status: "TEMPORARY_ADMIN_INSTALLED",
        runId: binding.runId,
        temporaryDataSha256: installed,
        addedRows: 5,
      }),
    );
    applicationResult = await runReadOnlyApplication(Client, env, async () => {
      await writeFile(
        readyPath,
        JSON.stringify({
          runId: binding.runId,
          release: binding.release,
          userId: temporaryAdmin.users,
          expiresAt: session.expiresAt,
          frontendDigest: expectedFrontendDigest,
          browserDigest: expectedBrowserDigest,
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      browserResult = await waitForBrowserResult(token, session);
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (installed) {
        await removeTemporaryAdmin(admin, installed);
        requireTrue(
          (await captureRows(admin)).sha256 === originalData,
          "POST_COMMIT_CLEANUP_MISMATCH",
        );
        console.log(
          JSON.stringify({
            status: "TEMPORARY_ADMIN_REMOVED",
            runId: binding.runId,
            dataSha256: originalData,
            removedRows: 5,
          }),
        );
      }
    } finally {
      await Promise.all([
        unlink(readyPath).catch(() => {}),
        unlink(resultPath).catch(() => {}),
      ]);
      await admin.end().catch(() => {});
    }
  }
  if (failure) throw failure;
  requireTrue(browserResult && applicationResult, "BROWSER_RESULT_MISSING");
  return {
    status: "PASS",
    scope: "task-local-browser-smoke",
    runId: binding.runId,
    release: binding.release,
    checks: browserResult.checks,
    network: browserResult.network,
    authenticatedRows: browserResult.authenticatedRows,
    pageErrors: browserResult.pageErrors,
    dataSha256: originalData,
    applicationStopped: true,
    temporaryAccessRemoved: true,
    browserAcceptanceProven: true,
    positivePublicProfileProven: false,
    positivePublicMediaProven: false,
    fullSmokeAccepted: false,
  };
}
