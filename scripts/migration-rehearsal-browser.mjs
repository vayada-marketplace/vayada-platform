// VAY-1361 controller for one task-local browser proof with exact cleanup.
import { createRequire } from "node:module";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  binding,
  guardedConnection,
  requireTrue,
} from "./migration-rehearsal-reader-contract.mjs";
import {
  applicationEnvironment,
  runReadOnlyApplication,
} from "./migration-rehearsal-app-readonly.mjs";
import {
  combineRunAndCleanupFailures,
  ensureTemporaryAdminRemoved,
  installTemporaryAdmin,
  preparedTemporaryAdminHash,
  temporaryAdmin,
  verifyAdminSession,
} from "./migration-rehearsal-temporary-admin.mjs";
import {
  attestTaskRuntime,
  expectedTaskImages,
} from "./migration-rehearsal-task-images.mjs";

const originalData =
  "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b";
const exchangeDir = "/shared";
const readyPath = `${exchangeDir}/browser-ready.json`;
const readyTempPath = `${exchangeDir}/browser-ready.tmp`;
const resultPath = `${exchangeDir}/browser-result.json`;
const resultTempPath = `${exchangeDir}/browser-result.tmp`;
const expectedChecks = [
  "login-page",
  "unauthenticated-dashboard-denial",
  "authenticated-user-list",
  "browser-cors-preflight",
  "task-local-api-routing",
  "no-legacy-network",
];

export const browserProof = Object.freeze({
  exchangeDir,
  readyPath,
  resultPath,
  expectedTaskImages,
  expectedChecks,
});

export function validateBrowserResult(result, token, runtime) {
  requireTrue(result && typeof result === "object", "BROWSER_RESULT_FORMAT");
  requireTrue(
    result.status === "PASS" &&
      result.scope === "task-local-admin-browser" &&
      result.runId === binding.runId &&
      result.release === binding.release &&
      result.virtualOrigin === "https://next-admin.vayada.com" &&
      result.taskArn === runtime?.taskArn &&
      JSON.stringify(result.runtimeImages) ===
        JSON.stringify(expectedTaskImages) &&
      JSON.stringify(result.runtimeImages) === JSON.stringify(runtime?.images),
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
      Number.isSafeInteger(network.apiPreflightRequests) &&
      network.apiPreflightRequests >= 0 &&
      network.corsProofPreflightRequests === 1 &&
      network.corsProofGetRequests === 1 &&
      network.corsProofAuthorizationMatches === 1 &&
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
      result.pageErrors === 0 &&
      result.positivePublicProfileProven === false &&
      result.positivePublicMediaProven === false &&
      result.fullSmokeAccepted === false,
    "BROWSER_UI_PROOF",
  );
  requireTrue(
    typeof token === "string" && !JSON.stringify(result).includes(token),
    "BROWSER_RESULT_DISCLOSURE",
  );
  return result;
}

async function waitForBrowserResult(
  token,
  session,
  runtime,
  timeoutMs = 150_000,
) {
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
      return validateBrowserResult(result, token, runtime);
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
  const runtime = await attestTaskRuntime(fetch, env);
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
    try {
      installed = await installTemporaryAdmin(admin, session);
    } catch (error) {
      installed = preparedTemporaryAdminHash(error);
      throw error;
    }
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
        readyTempPath,
        JSON.stringify({
          runId: binding.runId,
          release: binding.release,
          userId: temporaryAdmin.users,
          expiresAt: session.expiresAt,
          taskArn: runtime.taskArn,
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await rename(readyTempPath, readyPath);
      browserResult = await waitForBrowserResult(token, session, runtime);
    });
  } catch (error) {
    failure = error;
  }
  await admin.end().catch(() => {});
  let cleanupFailure;
  if (installed) {
    try {
      const cleanup = await ensureTemporaryAdminRemoved(Client, env, installed);
      console.log(
        JSON.stringify({
          status: "TEMPORARY_ADMIN_REMOVED",
          runId: binding.runId,
          dataSha256: cleanup.dataSha256,
          removedRows: cleanup.removedRows,
          alreadyAbsent: cleanup.alreadyAbsent,
        }),
      );
    } catch (error) {
      cleanupFailure = error;
    }
  }
  await Promise.all([
    unlink(readyTempPath).catch(() => {}),
    unlink(readyPath).catch(() => {}),
    unlink(resultTempPath).catch(() => {}),
    unlink(resultPath).catch(() => {}),
  ]);
  const finalFailure = combineRunAndCleanupFailures(failure, cleanupFailure);
  if (finalFailure) throw finalFailure;
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
    taskArn: runtime.taskArn,
    runtimeImages: runtime.images,
    dataSha256: originalData,
    applicationStopped: true,
    temporaryAccessRemoved: true,
    browserAcceptanceProven: true,
    positivePublicProfileProven: false,
    positivePublicMediaProven: false,
    fullSmokeAccepted: false,
  };
}
