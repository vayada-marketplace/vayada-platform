// VAY-1361 target-only controlled worker proof. Every database write is rolled back.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  binding,
  guardedConnection,
  requireTrue,
} from "./migration-rehearsal-reader-contract.mjs";
import {
  captureRows,
  captureRowsSnapshot,
} from "./migration-rehearsal-app-readonly.mjs";

const originalData =
  "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b";
const jobId = "8fd6fcf6-4557-4a27-b20b-27ba91061361";
const jobKey = `vay1361-controlled-email:${binding.runId}:v1`;
const workerId = `vay1361-controlled-worker:${binding.runId}`;
const auditKey = `booking.email.delivery:${jobId}:attempt:1:succeeded`;
const jobType = "email.booking-updated";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const controlledJob = Object.freeze({
  jobId,
  jobKey,
  workerId,
  auditKey,
  jobType,
});

export async function proveControlledJob(
  client,
  runWorker,
  jobTypes,
  baseline,
  captureSnapshot = captureRowsSnapshot,
) {
  requireTrue(
    Array.isArray(jobTypes) &&
      jobTypes.includes(jobType) &&
      jobTypes.length === new Set(jobTypes).size,
    "WORKER_JOB_TYPES",
  );
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
  let rolledBack = false;
  try {
    await client.query("SET LOCAL statement_timeout='180s'");
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SELECT pg_advisory_xact_lock(1361,1363)");
    await client.query(
      "LOCK TABLE platform.jobs,platform.job_attempts,platform.product_audit_events IN SHARE ROW EXCLUSIVE MODE",
    );
    const {
      rows: [queue],
    } = await client.query(
      `SELECT count(*)::int AS eligible
       FROM platform.jobs
       WHERE queue_name='platform.email' AND job_type=ANY($1::text[])
         AND (status='pending' OR (status='running' AND locked_at<now()-interval '5 minutes'))
         AND run_after<=now() AND attempts_count<max_attempts`,
      [jobTypes],
    );
    requireTrue(queue?.eligible === 0, "PREEXISTING_EMAIL_JOB");
    const {
      rows: [collision],
    } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM platform.jobs WHERE id=$1::uuid OR
          (queue_name='platform.email' AND job_key=$2)) OR
        EXISTS(SELECT 1 FROM platform.product_audit_events
          WHERE product='booking' AND audit_key=$3) AS found`,
      [jobId, jobKey, auditKey],
    );
    requireTrue(collision?.found === false, "CONTROLLED_JOB_COLLISION");
    const {
      rows: [property],
    } = await client.query(
      "SELECT id::text FROM hotel_catalog.properties ORDER BY id LIMIT 1",
    );
    requireTrue(
      /^[0-9a-f-]{36}$/.test(property?.id ?? ""),
      "NO_PROPERTY_FIXTURE",
    );
    await client.query(
      `INSERT INTO platform.jobs (
         id,job_key,queue_name,job_type,status,priority,attempts_count,max_attempts,run_after,
         tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,
         idempotency_key_hash,payload,job_metadata
       ) VALUES (
         $1::uuid,$2,'platform.email',$3,'pending',2147483647,0,1,now(),
         'property',$4::uuid,'booking','guest_booking',$5,$6,$7,$8::jsonb,$9::jsonb
       )`,
      [
        jobId,
        jobKey,
        jobType,
        property.id,
        `vay1361-controlled-booking:${binding.runId}`,
        `vay1361-controlled-job:${binding.runId}`,
        sha256(jobKey),
        JSON.stringify({
          emailProduct: "booking",
          to: "rehearsal@vayada.invalid",
          subject: "VAY-1361 controlled worker proof",
          text: "Synthetic transaction-only message; no provider delivery.",
        }),
        JSON.stringify({
          rehearsalRunId: binding.runId,
          temporary: true,
          provider: "in-memory-stub",
        }),
      ],
    );

    const sends = [];
    const delivery = {
      async send(input) {
        sends.push(input);
      },
    };
    const first = await runWorker(
      "postgresql://unused.invalid/unused",
      delivery,
      {
        pool: client,
        limit: 1,
        workerId,
      },
    );
    requireTrue(
      first?.processed === 1 && first.failed === 0 && sends.length === 1,
      "FIRST_JOB_RUN",
    );
    requireTrue(
      sends[0]?.idempotencyKey === jobKey &&
        sends[0]?.to === "rehearsal@vayada.invalid" &&
        sends[0]?.emailProduct === "booking",
      "STUB_DELIVERY_CONTRACT",
    );
    const {
      rows: [state],
    } = await client.query(
      `SELECT job.status,job.attempts_count AS attempts,
        (SELECT count(*)::int FROM platform.job_attempts attempt
          WHERE attempt.job_id=job.id AND attempt.status='succeeded') AS succeeded_attempts,
        (SELECT count(*)::int FROM platform.product_audit_events audit
          WHERE audit.job_id=job.id AND audit.product='booking'
            AND audit.action='booking.notification.delivery_succeeded'
            AND audit.audit_key=$2) AS success_audits
       FROM platform.jobs job WHERE job.id=$1::uuid`,
      [jobId, auditKey],
    );
    requireTrue(
      state?.status === "succeeded" &&
        state.attempts === 1 &&
        state.succeeded_attempts === 1 &&
        state.success_audits === 1,
      "FIRST_JOB_STATE",
    );
    const once = await captureSnapshot(client);
    requireTrue(
      once.tables === baseline.tables && once.rows === baseline.rows + 3,
      "CONTROLLED_JOB_ROW_DELTA",
    );

    const second = await runWorker(
      "postgresql://unused.invalid/unused",
      delivery,
      {
        pool: client,
        limit: 1,
        workerId,
      },
    );
    requireTrue(
      second?.processed === 0 && second.failed === 0 && sends.length === 1,
      "SECOND_JOB_RUN",
    );
    const repeated = await captureSnapshot(client);
    requireTrue(
      repeated.sha256 === once.sha256 &&
        repeated.tables === once.tables &&
        repeated.rows === once.rows,
      "SECOND_RUN_MUTATED_TARGET",
    );
    await client.query("ROLLBACK");
    rolledBack = true;
    return {
      temporaryDataSha256: once.sha256,
      first,
      second,
      providerCalls: sends.length,
      attempts: state.attempts,
      successAudits: state.success_audits,
    };
  } catch (error) {
    if (!rolledBack) await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function runControlledJob(Client, env) {
  const connection = guardedConnection(env.ADMIN_DATABASE_URL, "admin");
  connection.searchParams.set(
    "options",
    "-c statement_timeout=180000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=240000",
  );
  const client = new Client({
    connectionString: connection.toString(),
    connectionTimeoutMillis: 5000,
    application_name: "vay1361-controlled-job-proof",
  });
  try {
    await client.connect();
    await client.query("SET search_path=pg_catalog");
    const before = await captureRows(client);
    requireTrue(
      before.sha256 === originalData &&
        before.tables === 210 &&
        before.rows === 449379,
      "MIGRATED_ROWS_CHANGED",
    );
    const root = process.cwd() + "/apps/api/dist";
    const { runBookingEmailDeliveryJobs } = await import(
      pathToFileURL(root + "/jobs/bookingEmailDelivery.js").href
    );
    const { BOOKING_LIFECYCLE_EMAIL_JOB_TYPES } = await import(
      pathToFileURL(root + "/jobs/bookingEmails.js").href
    );
    const proof = await proveControlledJob(
      client,
      runBookingEmailDeliveryJobs,
      BOOKING_LIFECYCLE_EMAIL_JOB_TYPES,
      before,
    );
    const after = await captureRows(client);
    requireTrue(
      after.sha256 === before.sha256 &&
        after.tables === before.tables &&
        after.rows === before.rows,
      "ROLLBACK_DATA_MISMATCH",
    );
    return {
      status: "PASS",
      scope: "controlled-job-idempotency",
      runId: binding.runId,
      release: binding.release,
      checks: [
        "in-memory-provider-stub",
        "first-worker-run",
        "second-run-idle",
        "transaction-rollback",
        "whole-target-row-preservation",
      ],
      ...proof,
      before,
      after,
      jobAcceptanceProven: true,
      browserAcceptanceProven: false,
      fullSmokeAccepted: false,
    };
  } finally {
    await client.end().catch(() => {});
  }
}
