// VAY-1361: single-run permission bootstrap, not a migration or app launcher.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const binding = Object.freeze({
  host: "vayada-migration-rehearsal-20260831.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com",
  database: "vayada_target_staging_824c10d8_b074ab",
  owner: "vayada_cutover_staging_20260905_b074ab",
  reader: "vayada_app_reader_b074ab30e0ff1559080d6942",
  resourceId: "db-TEVNKEU27W4EIU3GRHXJZSYB74",
  runId: "vay1360-b074ab30e0ff1559080d6942",
  release: "824c10d89e11a84bc7ea298577f80040bf5ff840",
  identity: "92947042f7fbe1f34957dfcb9c73816fd7231026a6277cafb9992e7e61a239d3",
  clean: "c4145a8a928de24c1e1622bfb865fb2b1d6de09a8c1bde95162ec14b039acb11",
  parity: "da2ea7b36d27296376ec3b0061f435300edce46e0867348ed5e2bf686f33c07c",
  sourceRun: "vay1351-284859bacf5c049394f9f5e6",
});
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const requireTrue = (condition, code) => {
  if (!condition) throw new Error(code);
};

export function guardedConnection(raw, kind) {
  const url = new URL(raw);
  requireTrue(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname === binding.host &&
      (!url.port || url.port === "5432") &&
      !url.hash &&
      url.username &&
      url.password &&
      new Set(url.searchParams.keys()).size ===
        [...url.searchParams.keys()].length &&
      [...url.searchParams.keys()].every((key) =>
        ["sslmode", "uselibpqcompat"].includes(key),
      ) &&
      url.searchParams.get("sslmode") === "require",
    "CONNECTION_SCOPE",
  );
  if (kind === "reader") {
    requireTrue(
      url.pathname === "/" + binding.database &&
        decodeURIComponent(url.username) === binding.reader &&
        /^[A-Za-z0-9_-]{43}$/.test(decodeURIComponent(url.password)),
      "READER_SCOPE",
    );
  } else {
    requireTrue(
      kind === "admin" &&
        ["/postgres", "/" + binding.database].includes(url.pathname) &&
        decodeURIComponent(url.username) !== binding.reader,
      "ADMIN_SCOPE",
    );
  }
  url.pathname = "/" + binding.database;
  url.searchParams.set("uselibpqcompat", "true");
  return url;
}

export async function verifyTarget(client) {
  const {
    rows: [db],
  } = await client.query(`SELECT current_database() AS name,
    oid::text, pg_get_userbyid(datdba) AS owner, current_setting('server_version_num') AS version
    FROM pg_database WHERE datname=current_database()`);
  requireTrue(
    db?.name === binding.database &&
      db.owner === binding.owner &&
      db.version === "170009",
    "DATABASE_IDENTITY",
  );
  requireTrue(
    sha({
      version: 1,
      purpose: "vayada-isolated-staging-rehearsal-target",
      awsRdsInstanceResourceId: binding.resourceId,
      database: binding.database,
      databaseOid: db.oid,
      engine: "postgres",
      engineVersion: "17.9",
    }) === binding.identity,
    "DATABASE_OID_BINDING",
  );
  const {
    rows: [run],
  } = await client.query(
    `SELECT status, mode, environment, source_environment,
    application_release, target_identity_sha256, target_clean_proof_sha256, source_run_id,
    parity_decision, parity_report_checksum_sha256, current_step, last_safe_checkpoint,
    smoke_proof_sha256, failure_code FROM platform.production_cutover_runs WHERE run_id=$1`,
    [binding.runId],
  );
  const expected = {
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
  requireTrue(
    run && Object.entries(expected).every(([key, value]) => run[key] === value),
    "RUN_BINDING",
  );
  const { rows: steps } = await client.query(
    `SELECT step_name, status, attempt_count, safe_checkpoint
    FROM platform.production_cutover_steps WHERE run_id=$1 ORDER BY step_order`,
    [binding.runId],
  );
  const names = [
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
  ];
  requireTrue(
    steps.length === names.length &&
      steps.every(
        (step, i) =>
          step.step_name === names[i] &&
          step.status === (i === 9 ? "pending" : "completed") &&
          step.attempt_count === (i === 9 ? 0 : 1) &&
          step.safe_checkpoint === (i !== 9),
      ),
    "CHECKPOINT_BINDING",
  );
  const { rows: attestations } =
    await client.query(`SELECT attestation_key, attestation_value
    FROM vayada_migration_evidence.database_attestations ORDER BY attestation_key`);
  const values = Object.fromEntries(
    attestations.map((row) => [row.attestation_key, row.attestation_value]),
  );
  requireTrue(
    attestations.length === 5 &&
      Object.keys(values).length === 5 &&
      values["vayada.target_environment"] === "staging" &&
      values["vayada.target_identity_sha256"] === binding.identity &&
      values["vayada.target_clean_run_id"] === binding.runId &&
      values["vayada.target_clean_proof_sha256"] === binding.clean &&
      values["vayada.target_application_release"] === binding.release,
    "ATTESTATION_BINDING",
  );
  return sha({ db, run, steps, attestations });
}

// Default read-only is defence in depth, not a substitute for privilege checks.
export const unsafePrivilegesSql = `SELECT (
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
  OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
  OR has_database_privilege(r.rolname,current_database(),'CREATE')
  OR EXISTS (SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(r.rolname,n.oid,'CREATE'))
  OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind IN ('r','p','v','m','f') AND (
    has_table_privilege(r.rolname,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN')
    OR has_any_column_privilege(r.rolname,c.oid,'INSERT,UPDATE,REFERENCES')))
  OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind='S'
    AND has_sequence_privilege(r.rolname,c.oid,'USAGE,UPDATE'))
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND p.prorettype NOT IN ('trigger'::regtype,'event_trigger'::regtype)
    AND has_schema_privilege(r.rolname,n.oid,'USAGE') AND has_function_privilege(r.rolname,p.oid,'EXECUTE'))
) AS unsafe FROM pg_roles r WHERE r.rolname=$1`;

// Send PostgreSQL only its stored verifier, never the raw password in SQL.
// The fixed ASCII base64url credential has no SASLprep normalization ambiguity.
export function scramVerifier(password, salt = randomBytes(16)) {
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const keyed = (label) => createHmac("sha256", salted).update(label).digest();
  const stored = createHash("sha256")
    .update(keyed("Client Key"))
    .digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${keyed("Server Key").toString("base64")}`;
}
