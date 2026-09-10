import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  controlledJob,
  proveControlledJob,
} from "./migration-rehearsal-controlled-job.mjs";

const baseline = { sha256: "d".repeat(64), tables: 210, rows: 449379 };
const installed = { sha256: "e".repeat(64), tables: 210, rows: 449382 };
const jobTypes = [controlledJob.jobType, "email.booking-final-confirmation"];

function fixture(options = {}) {
  const state = {
    active: false,
    status: null,
    attempts: 0,
    attemptsRows: 0,
    audits: 0,
    eligible: options.eligible ?? 0,
    collision: options.collision ?? false,
    rolledBack: false,
  };
  const client = {
    async query(sql) {
      if (sql.startsWith("BEGIN")) return { rows: [] };
      if (sql === "ROLLBACK") {
        state.active = false;
        state.status = null;
        state.attempts = 0;
        state.attemptsRows = 0;
        state.audits = 0;
        state.rolledBack = true;
        return { rows: [] };
      }
      if (sql.includes("AS eligible"))
        return { rows: [{ eligible: state.eligible }] };
      if (sql.includes("AS found"))
        return { rows: [{ found: state.collision }] };
      if (sql.startsWith("SELECT id::text FROM hotel_catalog.properties")) {
        return {
          rows: options.noProperty
            ? []
            : [{ id: "11111111-1111-4111-8111-111111111111" }],
        };
      }
      if (sql.startsWith("INSERT INTO platform.jobs")) {
        state.active = true;
        state.status = "pending";
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("AS succeeded_attempts")) {
        return {
          rows: state.active
            ? [
                {
                  status: state.status,
                  attempts: state.attempts,
                  succeeded_attempts: state.attemptsRows,
                  success_audits: state.audits,
                },
              ]
            : [],
        };
      }
      return { rows: [] };
    },
  };
  let workerRuns = 0;
  const runWorker = async (_unused, delivery) => {
    workerRuns += 1;
    if (workerRuns === 1 && state.status === "pending") {
      await delivery.send({
        to: "rehearsal@vayada.invalid",
        subject: "synthetic",
        text: "synthetic",
        idempotencyKey: controlledJob.jobKey,
        emailProduct: "booking",
      });
      state.status = "succeeded";
      state.attempts = 1;
      state.attemptsRows = 1;
      state.audits = 1;
      return { processed: 1, failed: 0 };
    }
    if (options.mutateSecond && workerRuns === 2) state.audits += 1;
    if (options.sendSecond && workerRuns === 2) {
      await delivery.send({
        to: "rehearsal@vayada.invalid",
        idempotencyKey: controlledJob.jobKey,
        emailProduct: "booking",
      });
    }
    return { processed: 0, failed: 0 };
  };
  const capture = async () => ({
    ...(state.active ? installed : baseline),
    sha256:
      options.mutateSecond && workerRuns === 2
        ? "f".repeat(64)
        : state.active
          ? installed.sha256
          : baseline.sha256,
  });
  return { state, client, runWorker, capture };
}

{
  const test = fixture();
  const result = await proveControlledJob(
    test.client,
    test.runWorker,
    jobTypes,
    baseline,
    test.capture,
  );
  assert.deepEqual(result.first, { processed: 1, failed: 0 });
  assert.deepEqual(result.second, { processed: 0, failed: 0 });
  assert.equal(result.providerCalls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.successAudits, 1);
  assert.equal(test.state.rolledBack, true);
  assert.equal(test.state.active, false);
}

for (const [options, code] of [
  [{ eligible: 1 }, /PREEXISTING_EMAIL_JOB/],
  [{ collision: true }, /CONTROLLED_JOB_COLLISION/],
  [{ noProperty: true }, /NO_PROPERTY_FIXTURE/],
  [{ sendSecond: true }, /SECOND_JOB_RUN/],
  [{ mutateSecond: true }, /SECOND_RUN_MUTATED_TARGET/],
]) {
  const test = fixture(options);
  await assert.rejects(
    proveControlledJob(
      test.client,
      test.runWorker,
      jobTypes,
      baseline,
      test.capture,
    ),
    code,
  );
  assert.equal(test.state.rolledBack, true);
  assert.equal(test.state.active, false);
}

await assert.rejects(
  proveControlledJob(
    fixture().client,
    fixture().runWorker,
    [],
    baseline,
    fixture().capture,
  ),
  /WORKER_JOB_TYPES/,
);
await assert.rejects(
  proveControlledJob(
    fixture().client,
    fixture().runWorker,
    [controlledJob.jobType, controlledJob.jobType],
    baseline,
    fixture().capture,
  ),
  /WORKER_JOB_TYPES/,
);

const source = readFileSync(
  new URL("./migration-rehearsal-controlled-job.mjs", import.meta.url),
  "utf8",
);
assert(!source.includes('client.query("COMMIT")'));
assert(!source.includes("api.resend.com"));
assert(!/RESEND|SENDGRID|MAILGUN/.test(source));
assert(/runWorker\(\s*"postgresql:\/\/unused\.invalid\/unused"/.test(source));

console.log(
  "PASS: controlled job uses one stub delivery, idles on rerun, rejects queue/collision/drift, and always rolls back",
);
