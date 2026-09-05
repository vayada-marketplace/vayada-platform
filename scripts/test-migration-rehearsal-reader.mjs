import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { binding } from "./migration-rehearsal-reader-contract.mjs";
import { provisionReader } from "./migration-rehearsal-reader.mjs";
const password = "A".repeat(43);
const settings = JSON.parse(
  readFileSync(
    new URL("./fixtures/migration-rehearsal-pg-settings.json", import.meta.url),
    "utf8",
  ),
);
const readerUrl = `postgresql://${binding.reader}:${password}@${binding.host}/${binding.database}?sslmode=require`;
const adminUrl = `postgresql://isolated_admin:${password}@${binding.host}/postgres?sslmode=require`;
let connections = 0;
const queries = [];
const env = {
  ADMIN_DATABASE_URL: adminUrl,
  REHEARSAL_READER_DATABASE_URL: readerUrl,
  REHEARSAL_READER_MODE: "create",
};
const run = {
  status: "awaiting_smoke",
  mode: "staging_rehearsal",
  environment: "staging",
  source_environment: "staging",
  application_release: binding.release,
  target_identity_sha256: binding.identity,
  target_clean_proof_sha256: binding.clean,
  source_run_id: binding.sourceRun,
  parity_decision: "go",
  parity_report_checksum_sha256: binding.parity,
  current_step: "smoke_evidence",
  last_safe_checkpoint: "parity",
  smoke_proof_sha256: null,
  failure_code: null,
};
const steps = [
  "schema_migrations",
  "source_extraction",
  "identity",
  "catalog",
  "booking",
  "pms",
  "marketplace",
  "finance",
  "parity",
  "smoke_evidence",
].map((step_name, i) => ({
  step_name,
  status: i === 9 ? "pending" : "completed",
  attempt_count: i === 9 ? 0 : 1,
  safe_checkpoint: i !== 9,
}));
const attestations = Object.entries({
  target_environment: "staging",
  target_identity_sha256: binding.identity,
  target_clean_run_id: binding.runId,
  target_clean_proof_sha256: binding.clean,
  target_application_release: binding.release,
}).map(([key, attestation_value]) => ({
  attestation_key: "vayada." + key,
  attestation_value,
}));
let variant = "valid";
class MockDatabase {
  async connect() {
    connections++;
  }
  async end() {}
  escapeIdentifier(value) {
    return '"' + value + '"';
  }
  escapeLiteral(value) {
    return "'" + value + "'";
  }
  async query(sql) {
    queries.push(sql);
    let rows = [];
    if (sql.startsWith("SELECT c.relkind"))
      rows = variant === "pg-settings" ? [] : [settings];
    else if (sql.includes("oid::text"))
      rows = [
        {
          name: variant === "database" ? "wrong_database" : binding.database,
          oid: variant === "oid" ? "1" : "180558",
          owner: binding.owner,
          version: "170009",
        },
      ];
    else if (sql.includes("FROM platform.production_cutover_runs"))
      rows = [
        { ...run, ...(variant === "run" ? { status: "completed" } : {}) },
      ];
    else if (sql.includes("FROM platform.production_cutover_steps"))
      rows = variant === "steps" ? [] : steps;
    else if (
      sql.includes("FROM vayada_migration_evidence.database_attestations")
    )
      rows =
        variant === "attestation"
          ? []
          : variant === "extra-attestation"
            ? [
                ...attestations,
                {
                  attestation_key: "unexpected",
                  attestation_value: "unexpected",
                },
              ]
            : variant === "duplicate-attestation"
              ? [...attestations, attestations[0]]
              : attestations;
    else if (sql.includes("SELECT 1 FROM pg_roles"))
      return { rowCount: variant === "existing" ? 1 : 0, rows: [] };
    else if (sql.startsWith("SELECT nspname FROM pg_namespace"))
      rows =
        variant === "schemas"
          ? []
          : [
              "identity",
              "hotel_catalog",
              "booking",
              "pms",
              "finance",
              "marketplace",
              "distribution",
              "platform",
            ].map((nspname) => ({ nspname }));
    else if (sql.startsWith("SELECT flags.*"))
      rows = [{ unsafe: variant === "privileges" }];
    else if (sql.includes("current_user=session_user")) rows = [{ ok: true }];
    else if (sql.startsWith("SHOW default"))
      rows = [{ default_transaction_read_only: "on" }];
    else if (
      sql.startsWith("UPDATE identity.users") &&
      variant !== "write-allowed"
    )
      throw Object.assign(new Error("denied"), { code: "42501" });
    return { rows, rowCount: rows.length };
  }
}
await assert.rejects(
  provisionReader(MockDatabase, { ADMIN_DATABASE_URL: adminUrl }),
  /EXPLICIT_READER_MODE_REQUIRED/,
);
await assert.rejects(
  provisionReader(MockDatabase, {
    ...env,
    REHEARSAL_READER_DATABASE_URL: readerUrl.replace(
      binding.host,
      "production.example.test",
    ),
  }),
  /CONNECTION_SCOPE/,
);
assert.equal(connections, 0);
queries.length = 0;
const proof = await provisionReader(MockDatabase, env);
assert.equal(proof.status, "PASS");
assert.equal(proof.applicationStarted, false);
assert(
  queries
    .find((sql) => sql.startsWith("CREATE ROLE"))
    .includes("SCRAM-SHA-256$4096:"),
);
assert(!queries.some((sql) => sql.includes(password)));
assert(queries.includes("COMMIT") && queries.includes("BEGIN READ WRITE"));
for (const [bad, code, committed] of [
  ["database", "DATABASE_IDENTITY", false],
  ["oid", "DATABASE_OID_BINDING", false],
  ["run", "RUN_BINDING", false],
  ["steps", "CHECKPOINT_BINDING", false],
  ["attestation", "ATTESTATION_BINDING", false],
  ["extra-attestation", "ATTESTATION_BINDING", false],
  ["duplicate-attestation", "ATTESTATION_BINDING", false],
  ["existing", "READER_EXISTS_INSPECT_PRIOR_ATTEMPT", false],
  ["schemas", "TARGET_SCHEMA_CONTRACT", false],
  ["pg-settings", "PG_SETTINGS_CONTRACT", false],
  ["privileges", "READER_HAS_WRITE_PRIVILEGES", false],
  ["write-allowed", "WRITE_DENIAL_NOT_PROVEN", true],
]) {
  variant = bad;
  queries.length = 0;
  await assert.rejects(provisionReader(MockDatabase, env), new RegExp(code));
  assert.equal(queries.includes("COMMIT"), committed);
  assert(queries.includes("ROLLBACK"));
  if (!["privileges", "write-allowed"].includes(bad))
    assert(!queries.some((sql) => sql.startsWith("CREATE ROLE")));
}
variant = "database";
queries.length = 0;
await assert.rejects(
  provisionReader(MockDatabase, { ...env, REHEARSAL_READER_MODE: "inspect" }),
  /DATABASE_IDENTITY/,
);
assert(queries.includes("BEGIN READ ONLY") && queries.at(-1) === "ROLLBACK");
assert(
  !queries.some((sql) =>
    /^(CREATE|ALTER|GRANT|UPDATE|INSERT|DELETE|COMMIT)/.test(sql),
  ),
);
variant = "valid";
queries.length = 0;
const inspected = await provisionReader(MockDatabase, {
  ...env,
  REHEARSAL_READER_MODE: "inspect",
});
assert.equal(inspected.scope, "read-only-preflight");
assert(queries.includes("BEGIN READ ONLY") && queries.includes("ROLLBACK"));
assert(!queries.some((sql) => /^(CREATE|ALTER|GRANT|UPDATE|COMMIT)/.test(sql)));
console.log(
  "PASS: create/inspect, rollback, existing-role refusal, exact-target drift and write-denial checks; live permission proof still required",
);
