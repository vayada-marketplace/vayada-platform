// Presence audit only: email is never an identity join or a grant instruction.
import { binding, requireTrue, verifyPgSettings, pgSettingsSql, unsafePrivilegesSql } from "./migration-rehearsal-reader-contract.mjs";
import { applicationEnvironment, captureRows } from "./migration-rehearsal-app-readonly.mjs";

export const readinessAccounts = ["creator", "hotel", "staff", "admin"];
const acceptedData = "c373af9f2d23564c437a1457fd5cd506df92965c608e195c40d86b96a2bf2959";
export const readinessSql = `WITH expected AS (
  SELECT label, 'f.maliqi+codex-' || label || '@vayada.com' AS email
  FROM unnest($1::text[]) AS label
)
SELECT expected.label,
  (SELECT count(*)::int FROM identity.users u WHERE lower(u.email)=expected.email) AS users,
  (SELECT count(*)::int FROM identity.users u JOIN identity.external_identities e ON e.user_id=u.id
    WHERE lower(u.email)=expected.email AND e.provider='workos' AND e.provider_user_id IS NOT NULL) AS provider_bindings,
  (SELECT count(*)::int FROM identity.users u JOIN identity.organization_memberships m ON m.user_id=u.id
    JOIN identity.organizations o ON o.id=m.organization_id
    WHERE lower(u.email)=expected.email AND u.status='active' AND m.status='active'
      AND o.status='active' AND o.workos_org_id IS NOT NULL) AS active_memberships
FROM expected ORDER BY expected.label`;

export function summarizeReadiness(rows) {
  requireTrue(rows.length === readinessAccounts.length
    && new Set(rows.map(row => row.label)).size === readinessAccounts.length
    && rows.every(row => readinessAccounts.includes(row.label)
      && [row.users, row.provider_bindings, row.active_memberships].every(value => Number.isSafeInteger(value) && value >= 0)), "IDENTITY_AUDIT_SHAPE");
  return { accounts: rows, absentAccounts: rows.filter(row => row.users === 0).map(row => row.label),
    ambiguousAccounts: rows.filter(row => row.users > 1).map(row => row.label),
    providerIdentityVerified: false, authenticatedReadsProven: false, mappingChanged: false };
}

export async function auditIdentityReadiness(Client, env) {
  const scoped = applicationEnvironment(env);
  const client = new Client({ connectionString: scoped.TARGET_DATABASE_URL,
    connectionTimeoutMillis: 5000, application_name: "vay1361-identity-presence-audit" });
  try {
    await client.connect();
    await client.query("SET search_path=pg_catalog");
    verifyPgSettings((await client.query(pgSettingsSql)).rows);
    requireTrue((await client.query(unsafePrivilegesSql, [binding.reader])).rows[0]?.unsafe === false, "READER_PRIVILEGE_DRIFT");
    requireTrue((await client.query("SELECT current_user=session_user AND current_user=$1 AS ok", [binding.reader])).rows[0]?.ok, "READER_LOGIN");
    const before = await captureRows(client);
    requireTrue(before.sha256 === acceptedData, "MIGRATED_ROWS_CHANGED");
    const summary = summarizeReadiness((await client.query(readinessSql, [readinessAccounts])).rows);
    const after = await captureRows(client);
    requireTrue(after.sha256 === before.sha256 && after.tables === before.tables && after.rows === before.rows, "MIGRATED_ROWS_CHANGED");
    return { status: "PASS", scope: "identity-presence-audit-only", runId: binding.runId, release: binding.release,
      ...summary, dataSha256: after.sha256, tables: after.tables, rows: after.rows,
      applicationStarted: false, fullSmokeAccepted: false };
  } finally { await client.end().catch(() => {}); }
}
