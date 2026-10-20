import { pathToFileURL } from "node:url";
import {
  binding,
  guardedConnection,
  verifyTarget,
  unsafePrivilegesSql,
  pgSettingsSql,
  verifyPgSettings,
  scramVerifier,
  requireTrue,
} from "./migration-rehearsal-reader-contract.mjs";

const schemas = [
  "identity",
  "hotel_catalog",
  "booking",
  "pms",
  "finance",
  "marketplace",
  "distribution",
  "platform",
];

export async function provisionReader(Client, env) {
  const adminUrl = guardedConnection(env.ADMIN_DATABASE_URL, "admin");
  requireTrue(
    ["inspect", "create"].includes(env.REHEARSAL_READER_MODE),
    "EXPLICIT_READER_MODE_REQUIRED",
  );
  const readerUrl =
    env.REHEARSAL_READER_MODE === "create"
      ? guardedConnection(env.REHEARSAL_READER_DATABASE_URL, "reader")
      : null;
  const admin = new Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 5000,
    application_name: "vay1361-reader-bootstrap",
    options: "-c statement_timeout=15000 -c lock_timeout=3000",
  });
  let reader;
  let committed = false;
  try {
    await admin.connect();
    await admin.query(readerUrl ? "BEGIN" : "BEGIN READ ONLY");
    const baseline = await verifyTarget(admin);
    await admin.query("SET LOCAL search_path=pg_catalog");
    verifyPgSettings((await admin.query(pgSettingsSql)).rows);
    const { rows: namespaces } = await admin.query(
      "SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[]) ORDER BY nspname",
      [schemas],
    );
    requireTrue(namespaces.length === schemas.length, "TARGET_SCHEMA_CONTRACT");
    const { rowCount } = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1",
      [binding.reader],
    );
    if (!readerUrl) {
      return {
        status: "PASS",
        scope: "read-only-preflight",
        runId: binding.runId,
        evidenceSha256: baseline,
        readerExists: rowCount !== 0,
        schemas: namespaces.map((row) => row.nspname),
        applicationStarted: false,
      };
    }
    requireTrue(rowCount === 0, "READER_EXISTS_INSPECT_PRIOR_ATTEMPT");
    const role = admin.escapeIdentifier(binding.reader);
    const database = admin.escapeIdentifier(binding.database);
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${admin.escapeLiteral(scramVerifier(decodeURIComponent(readerUrl.password)))}
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 16 VALID UNTIL ${admin.escapeLiteral(expires)}`);
    await admin.query(
      `ALTER ROLE ${role} SET default_transaction_read_only=on`,
    );
    await admin.query(`ALTER ROLE ${role} SET statement_timeout='15s'`);
    await admin.query(
      `ALTER ROLE ${role} SET idle_in_transaction_session_timeout='30s'`,
    );
    await admin.query(
      `SET LOCAL ROLE ${admin.escapeIdentifier(binding.owner)}`,
    );
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    for (const schema of schemas) {
      const name = admin.escapeIdentifier(schema);
      await admin.query(`GRANT USAGE ON SCHEMA ${name} TO ${role}`);
      await admin.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${name} TO ${role}`,
      );
    }
    await admin.query("RESET ROLE");
    await admin.query("SET LOCAL ROLE vayada_migration_attestor");
    await admin.query(
      `GRANT USAGE ON SCHEMA vayada_migration_evidence TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON vayada_migration_evidence.database_attestations TO ${role}`,
    );
    await admin.query("RESET ROLE");
    const privileges = (
      await admin.query(unsafePrivilegesSql, [binding.reader])
    ).rows[0];
    if (privileges?.unsafe !== false)
      console.error(
        JSON.stringify({
          status: "FAIL",
          scope: "reader-privilege-gate",
          flags: privileges,
        }),
      );
    requireTrue(privileges?.unsafe === false, "READER_HAS_WRITE_PRIVILEGES");
    requireTrue(
      (await verifyTarget(admin)) === baseline,
      "TARGET_EVIDENCE_CHANGED",
    );
    await admin.query("COMMIT");
    committed = true;
    reader = new Client({
      connectionString: readerUrl.toString(),
      connectionTimeoutMillis: 5000,
      application_name: "vay1361-reader-proof",
    });
    await reader.connect();
    requireTrue(
      (
        await reader.query(
          "SELECT current_user=session_user AND current_user=$1 AS ok",
          [binding.reader],
        )
      ).rows[0]?.ok,
      "READER_LOGIN",
    );
    requireTrue(
      (await reader.query("SHOW default_transaction_read_only")).rows[0]
        ?.default_transaction_read_only === "on",
      "READER_DEFAULT_WRITABLE",
    );
    requireTrue(
      (await verifyTarget(reader)) === baseline,
      "READER_TARGET_BINDING",
    );
    // Zero-row UPDATE, in a rolled-back transaction, proves ACLs even if a job
    // explicitly selects READ WRITE. No trigger or customer row is touched.
    await reader.query("BEGIN READ WRITE");
    let denied = false;
    try {
      await reader.query("UPDATE identity.users SET id=id WHERE false");
    } catch (error) {
      denied = error.code === "42501";
    } finally {
      await reader.query("ROLLBACK");
    }
    requireTrue(denied, "WRITE_DENIAL_NOT_PROVEN");
    return {
      status: "PASS",
      scope: "reader-role-only",
      runId: binding.runId,
      targetIdentitySha256: binding.identity,
      evidenceSha256: baseline,
      reader: binding.reader,
      expiresAt: expires,
      writeDenied: true,
      applicationStarted: false,
    };
  } finally {
    if (!committed) await admin.query("ROLLBACK").catch(() => {});
    await reader?.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const timeout = setTimeout(() => process.exit(2), 120000);
  try {
    const { default: pg } = await import("pg");
    console.log(JSON.stringify(await provisionReader(pg.Client, process.env)));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "FAIL",
        scope: "reader-role-only",
        code: /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "READER_BOOTSTRAP_FAILED",
        sqlState: /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined,
      }),
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}
