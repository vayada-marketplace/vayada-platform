// VAY-1361 approved temporary Identity-owned rehearsal boundary, not provisioning.
import { createHash as identityHash } from "node:crypto";
import { createRequire } from "node:module";
import { binding, guardedConnection, requireTrue } from "./migration-rehearsal-reader-contract.mjs";
import { applicationEnvironment, captureRows, captureRowsSnapshot, runReadOnlyApplication } from "./migration-rehearsal-app-readonly.mjs";

export const temporaryAdmin = {
  users: "253a344b-e7f0-4668-b966-b23383282127",
  external_identities: "f6e30264-2608-44d1-b78e-bbc70752785a",
  organizations: "e283bb6c-6628-4042-9409-ef1a20d03c4b",
  organization_memberships: "009d8467-1dc2-4250-8026-7198e1d213b9",
  organization_resource_links: "d140b638-724c-485b-a86e-6db45f76ecaf",
};
const originalData = "c373af9f2d23564c437a1457fd5cd506df92965c608e195c40d86b96a2bf2959";
const testEmail = "f.maliqi+codex-admin@vayada.com";
const testSlug = "vay1361-b074ab-temporary-admin";
const hashIdentity = value => identityHash("sha256").update(value).digest("hex");
// Exact read-only constraint trigger and its transitive function from release 0105.
export const identityTriggerSql = `SELECT
  (SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,
    'definition',pg_get_triggerdef(oid,false)) ORDER BY tgrelid::regclass::text,tgname)
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY($1::regclass[])) AS triggers,
  (SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY proname) FROM pg_proc
    WHERE oid=ANY(ARRAY['identity.enforce_membership_delegation_from_membership()'::regprocedure,
      'identity.assert_membership_delegation_integrity(uuid)'::regprocedure])) AS functions`;

export function verifyAdminSession(session, now = Date.now()) {
  requireTrue(typeof session.workosUserId === "string" && typeof session.workosOrgId === "string"
    && hashIdentity(session.workosUserId) === "1db71651043667105f6c270e800029bba9fdc7161fdbcb1c528a86db21e76c2b"
    && hashIdentity(session.workosOrgId) === "0222289cdc132448e75e88f11cdaf10e74206e4f45b47a0ec46ca120f206fa62", "TEST_ADMIN_SUBJECT");
  requireTrue(Number.isSafeInteger(session.expiresAt) && session.expiresAt * 1000 > now + 180000
    && session.expiresAt * 1000 <= now + 300000, "TEST_SESSION_WINDOW");
}

async function lockIdentity(client) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock(1361,1361)");
  await client.query(`LOCK TABLE ${Object.keys(temporaryAdmin).map(name => 'identity.' + name).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
}

async function deleteTestRows(client) {
  for (const name of ["organization_resource_links", "organization_memberships", "external_identities", "organizations", "users"])
    requireTrue((await client.query(`DELETE FROM identity.${name} WHERE id=$1`, [temporaryAdmin[name]])).rowCount === 1, "TEST_CLEANUP_ROW_COUNT");
}

async function verifyIdentityTriggers(client) {
  const tables = Object.keys(temporaryAdmin).map(name => "identity." + name);
  requireTrue(hashIdentity(JSON.stringify((await client.query(identityTriggerSql, [tables])).rows[0])) ===
    "0c4a4faa097a7c43cdcd22fc1929befd4944e6976fc48367762265bb5e75666c", "IDENTITY_TRIGGER_DRIFT");
}

export async function installTemporaryAdmin(client, session) {
  await lockIdentity(client);
  try {
    requireTrue((await captureRowsSnapshot(client)).sha256 === originalData, "MIGRATED_ROWS_CHANGED");
    await verifyIdentityTriggers(client);
    for (const [name, id] of Object.entries(temporaryAdmin))
      requireTrue((await client.query(`SELECT count(*)::int AS count FROM identity.${name} WHERE id=$1`, [id])).rows[0]?.count === 0, "TEST_ID_COLLISION");
    const { rows: [collision] } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM identity.users WHERE lower(email)=$1) OR
      EXISTS(SELECT 1 FROM identity.external_identities WHERE provider_user_id=$2 OR lower(provider_email)=$1) OR
      EXISTS(SELECT 1 FROM identity.organizations WHERE workos_org_id=$3 OR slug=$4) AS found`,
      [testEmail, session.workosUserId, session.workosOrgId, testSlug]);
    requireTrue(collision?.found === false, "TEST_IDENTITY_COLLISION");
    requireTrue((await client.query(`SELECT EXISTS(SELECT 1 FROM identity.role_permission_grants
      WHERE organization_kind='platform' AND role_key='platform_admin' AND permission_key='platform.user.suspend') AS present,
      EXISTS(SELECT 1 FROM identity.role_permission_grants WHERE organization_kind='platform' AND role_key='vay1361_no_grants') AS denied_role`)).rows
      .some(row => row.present === true && row.denied_role === false), "EXISTING_PERMISSION_CONTRACT");
    await client.query("INSERT INTO identity.users (id,email,name,status) VALUES ($1,$2,'VAY-1361 temporary test admin','active')", [temporaryAdmin.users, testEmail]);
    await client.query(`INSERT INTO identity.external_identities (id,user_id,provider,provider_user_id,provider_email,raw_profile)
      VALUES ($1,$2,'workos',$3,$4,$5::jsonb)`, [temporaryAdmin.external_identities, temporaryAdmin.users, session.workosUserId, testEmail, JSON.stringify({ rehearsalRunId: binding.runId, temporary: true })]);
    await client.query(`INSERT INTO identity.organizations (id,kind,name,slug,status,workos_org_id)
      VALUES ($1,'platform','VAY-1361 temporary test organization',$2,'active',$3)`, [temporaryAdmin.organizations, testSlug, session.workosOrgId]);
    await client.query(`INSERT INTO identity.organization_memberships (id,organization_id,user_id,status,role_key,property_access_mode,access_origin)
      VALUES ($1,$2,$3,'active','platform_admin','assigned','agency')`, [temporaryAdmin.organization_memberships, temporaryAdmin.organizations, temporaryAdmin.users]);
    await client.query(`INSERT INTO identity.organization_resource_links (id,organization_id,product,resource_type,resource_id,relationship,status)
      VALUES ($1,$2,'platform','platform','vayada','operator','active')`, [temporaryAdmin.organization_resource_links, temporaryAdmin.organizations]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const installed = await captureRowsSnapshot(client);
    requireTrue(installed.tables === 197 && installed.rows === 449361, "TEMPORARY_ROW_DELTA");
    // Prove before commit that deleting only these five rows restores the exact data.
    await client.query("SAVEPOINT cleanup_probe");
    await deleteTestRows(client);
    requireTrue((await captureRowsSnapshot(client)).sha256 === originalData, "TEST_INSERT_SIDE_EFFECT");
    await client.query("ROLLBACK TO SAVEPOINT cleanup_probe");
    console.log(JSON.stringify({ status: "TEMPORARY_ADMIN_PREPARED", runId: binding.runId, temporaryDataSha256: installed.sha256, committed: false }));
    await client.query("COMMIT");
    return installed.sha256;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function removeTemporaryAdmin(client, expectedHash) {
  requireTrue(/^[a-f0-9]{64}$/.test(expectedHash ?? "") && expectedHash !== originalData, "EXPECTED_TEST_HASH");
  await lockIdentity(client);
  try {
    await verifyIdentityTriggers(client);
    requireTrue((await captureRowsSnapshot(client)).sha256 === expectedHash, "TEST_OR_MIGRATED_DATA_DRIFT");
    await deleteTestRows(client);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    requireTrue((await captureRowsSnapshot(client)).sha256 === originalData, "CLEANUP_DATA_MISMATCH");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function checkAdminRoutes(get, reader, admin, token, session) {
  const headers = { authorization: "Bearer " + token };
  const request = async (id, status) => {
    requireTrue(session.expiresAt * 1000 > Date.now() + 10000, "TEST_TOKEN_EXPIRED");
    const response = await get("/api/identity/admin/users/" + id, headers);
    requireTrue(response.status === status, "ADMIN_ROUTE_STATUS_" + status);
    const body = await response.json();
    if (status !== 200) requireTrue(!body.id && !body.email && !body.users && !body.profile, "DENIED_DATA_DISCLOSURE");
    return body;
  };
  const self = await request(temporaryAdmin.users, 200);
  requireTrue(self.id === temporaryAdmin.users && self.email === testEmail, "ADMIN_SELF_MISMATCH");
  const migrated = (await reader.query("SELECT id,email FROM identity.users WHERE id<>$1 ORDER BY id LIMIT 1", [temporaryAdmin.users])).rows[0];
  requireTrue(migrated, "NO_MIGRATED_IDENTITY_SAMPLE");
  const actual = await request(migrated.id, 200);
  requireTrue(actual.id === migrated.id && actual.email === migrated.email, "MIGRATED_IDENTITY_READ_MISMATCH");
  for (const [table, column, denied, restored, status] of [
    ["organization_memberships", "role_key", "vay1361_no_grants", "platform_admin", 403],
    ["organization_memberships", "status", "inactive", "active", 401],
    ["organization_resource_links", "status", "archived", "active", 403],
  ]) {
    const change = async value => requireTrue((await admin.query(`UPDATE identity.${table} SET ${column}=$1 WHERE id=$2`, [value, temporaryAdmin[table]])).rowCount === 1, "TEMPORARY_STATE_COUNT");
    await change(denied);
    try { await request(temporaryAdmin.users, status); }
    finally { await change(restored); }
  }
  await request(temporaryAdmin.users, 200);
  return ["admin-self", "migrated-identity-read", "missing-permission", "inactive-membership", "missing-platform-link", "restored-access"];
}

export async function runTemporaryAdmin(Client, env) {
  applicationEnvironment(env); // Validate child isolation before credentials or writes.
  const token = env.REHEARSAL_TEST_SESSION;
  requireTrue(typeof token === "string" && token.length < 16000, "TEST_SESSION_REQUIRED");
  const req = createRequire(process.cwd() + "/package.json");
  const session = await req("@vayada/backend-auth").createWorkOSVerifier({ jwksUrl: env.WORKOS_JWKS_URL,
    issuer: env.WORKOS_ISSUER, audience: env.WORKOS_AUDIENCE })(token);
  verifyAdminSession(session);
  const admin = new Client({ connectionString: guardedConnection(env.ADMIN_DATABASE_URL, "admin").toString(),
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=3000", application_name: "vay1361-temporary-admin" });
  let installed, checks, failure;
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    installed = await installTemporaryAdmin(admin, session);
    console.log(JSON.stringify({ status: "TEMPORARY_ADMIN_INSTALLED", runId: binding.runId, temporaryDataSha256: installed, addedRows: 5 }));
    await runReadOnlyApplication(Client, env, async (get, reader) => {
      checks = await checkAdminRoutes(get, reader, admin, token, session);
    });
  } catch (error) { failure = error; }
  finally {
    try {
      if (installed) {
        await removeTemporaryAdmin(admin, installed);
        requireTrue((await captureRows(admin)).sha256 === originalData, "POST_COMMIT_CLEANUP_MISMATCH");
        console.log(JSON.stringify({ status: "TEMPORARY_ADMIN_REMOVED", runId: binding.runId, dataSha256: originalData, removedRows: 5 }));
      }
    } finally { await admin.end().catch(() => {}); }
  }
  if (failure) throw failure;
  return { status: "PASS", scope: "temporary-admin-identity-smoke-only", runId: binding.runId, release: binding.release,
    checks, dataSha256: originalData, applicationStopped: true, temporaryAccessRemoved: true,
    authenticatedIdentityReadProven: true, otherDomainReadsProven: false, fullSmokeAccepted: false };
}

// Recovery only: never provision or launch an application, and refuse data drift.
export async function runTemporaryAdminCleanup(Client, env) {
  const admin = new Client({ connectionString: guardedConnection(env.ADMIN_DATABASE_URL, "admin").toString(),
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=3000", application_name: "vay1361-admin-cleanup" });
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    await removeTemporaryAdmin(admin, env.REHEARSAL_CLEANUP_HASH);
    requireTrue((await captureRows(admin)).sha256 === originalData, "POST_COMMIT_CLEANUP_MISMATCH");
    return { status: "PASS", scope: "temporary-admin-cleanup-only", runId: binding.runId,
      dataSha256: originalData, temporaryAccessRemoved: true, fullSmokeAccepted: false };
  } finally { await admin.end().catch(() => {}); }
}
