// One explicitly resumed test window. No password, grants, data or provider changes.
import { binding, guardedConnection, verifyTarget, requireTrue,
  pgSettingsSql, verifyPgSettings, unsafePrivilegesSql } from "./migration-rehearsal-reader-contract.mjs";
import { captureRows } from "./migration-rehearsal-app-readonly.mjs";

export const previousExpiry = "2026-09-05T22:55:19.399Z";
export const renewedExpiry = "2026-09-06T10:18:00.000Z";
const renewalEvidence = "90fb12e32a1d26b535b836782a5ef93ed4be9788b575bbd6aaa33afb3c53e3ee";
const renewalData = "c373af9f2d23564c437a1457fd5cd506df92965c608e195c40d86b96a2bf2959";

export function assertRenewalWindow(role, now = Date.now()) {
  requireTrue(role?.rolcanlogin === true && role.rolconnlimit === 16
    && new Date(role.rolvaliduntil).toISOString() === previousExpiry, "EXPECTED_EXPIRED_ROLE");
  requireTrue(JSON.stringify([...role.rolconfig].sort()) === JSON.stringify([
    "default_transaction_read_only=on", "idle_in_transaction_session_timeout=30s", "statement_timeout=15s",
  ]), "READER_DEFAULTS_DRIFT");
  requireTrue(Date.parse(previousExpiry) < now && Date.parse(renewedExpiry) > now + 15 * 60000
    && Date.parse(renewedExpiry) <= now + 8 * 3600000, "RENEWAL_WINDOW_CLOSED");
}

export async function renewReader(Client, env) {
  const adminUrl = guardedConnection(env.ADMIN_DATABASE_URL, "admin");
  const readerUrl = guardedConnection(env.REHEARSAL_READER_DATABASE_URL, "reader");
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=15000 -c lock_timeout=3000", application_name: "vay1361-reader-window" });
  let reader;
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    requireTrue((await captureRows(admin)).sha256 === renewalData, "MIGRATED_ROWS_CHANGED");
    await admin.query("BEGIN");
    requireTrue(await verifyTarget(admin) === renewalEvidence, "TARGET_EVIDENCE_CHANGED");
    verifyPgSettings((await admin.query(pgSettingsSql)).rows);
    const { rows: [role] } = await admin.query(`SELECT rolcanlogin,rolconnlimit,rolvaliduntil,rolconfig
      FROM pg_roles WHERE rolname=$1`, [binding.reader]);
    assertRenewalWindow(role);
    requireTrue((await admin.query(unsafePrivilegesSql, [binding.reader])).rows[0]?.unsafe === false, "READER_PRIVILEGE_DRIFT");
    // The only persistent mutation in this payload. Exact role and fixed end time.
    await admin.query(`ALTER ROLE ${admin.escapeIdentifier(binding.reader)} VALID UNTIL ${admin.escapeLiteral(renewedExpiry)}`);
    await admin.query("COMMIT");
    requireTrue((await captureRows(admin)).sha256 === renewalData, "MIGRATED_ROWS_CHANGED");
    reader = new Client({ connectionString: readerUrl.toString(), connectionTimeoutMillis: 5000 });
    await reader.connect();
    await reader.query("SET search_path=pg_catalog");
    requireTrue((await reader.query("SELECT current_user=session_user AND current_user=$1 AS ok", [binding.reader])).rows[0]?.ok, "READER_LOGIN");
    requireTrue((await reader.query("SHOW default_transaction_read_only")).rows[0]?.default_transaction_read_only === "on", "READER_DEFAULT_WRITABLE");
    requireTrue(await verifyTarget(reader) === renewalEvidence, "TARGET_EVIDENCE_CHANGED");
    requireTrue((await reader.query(unsafePrivilegesSql, [binding.reader])).rows[0]?.unsafe === false, "READER_PRIVILEGE_DRIFT");
    await reader.query("BEGIN READ WRITE");
    let denied = false;
    try { await reader.query("UPDATE identity.users SET id=id WHERE false"); }
    catch (error) { denied = error.code === "42501"; }
    finally { await reader.query("ROLLBACK"); }
    requireTrue(denied, "WRITE_DENIAL_NOT_PROVEN");
    return { status: "PASS", scope: "reader-window-only", runId: binding.runId, reader: binding.reader,
      previousExpiry, expiresAt: renewedExpiry, targetIdentitySha256: binding.identity,
      evidenceSha256: renewalEvidence, dataSha256: renewalData, passwordChanged: false, grantsChanged: false,
      writeDenied: true, applicationStarted: false };
  } finally {
    await admin.query("ROLLBACK").catch(() => {});
    await reader?.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}
