import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
const host = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const prefix = "hotel-setup-command/prod/organization/";
const rlsHelpers = new Map([
  ["platform.channex_management_worker_source(text,text,uuid)", "8333d3b5cfe357880922d0dc0b46360d419f06194ecd449371bd115bcef73b76"],
  ["platform.channex_management_worker_scope(text,text,uuid)", "2876336c9cdddbc60acc10f74c7cb9f9a575fb035824f55b961390215281cbb2"],
]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const purpose = process.env.HOTEL_SETUP_BOOTSTRAP_PURPOSE ?? "organization";
const readerMode = purpose === "property_reader" ? "property_commands" : "property_creation";
const isReader = purpose === "creation_reader" || purpose === "property_reader";
const role = purpose === "organization"
  ? "vayada_next_hotel_setup_org_" + randomUUID().replaceAll("-", "")
  : purpose === "property_reader" ? "vayada_next_hotel_setup_reader" : "vayada_next_hotel_setup_creation_reader";
let admin;
let native;
let createdRole = false;
let connectionFailed = false;
let migrationLocked = false;
try {
  const organizationId = process.env.HOTEL_SETUP_COMMAND_ORGANIZATION_ID ?? "";
  const actorUserId = process.env.HOTEL_SETUP_COMMAND_ACTOR_USER_ID ?? "";
  if (!["organization", "creation_reader", "property_reader"].includes(purpose) ||
      (purpose === "organization" && (!uuid.test(organizationId) || !uuid.test(actorUserId))))
    throw new Error();
  const url = new URL(process.env.TARGET_DATABASE_ADMIN_URL ?? "");
  const local = process.env.VAYADA_HOTEL_SETUP_CREATION_LOCAL_FIXTURE === "1" &&
    url.hostname === "127.0.0.1" && url.username === "postgres" &&
    url.pathname === "/vay1092_vay965_creation_test";
  if (url.protocol !== "postgresql:" || !url.password || url.hash ||
      (local && url.search !== "?sslmode=verify-full") || (!local &&
      (url.hostname !== host || url.port !== "5432" || url.username !== "vayada_admin" ||
      url.pathname !== "/postgres" || url.search !== "?sslmode=require" ||
      !process.env.VAYADA_DB_RDS_CA_BUNDLE))) throw new Error();
  if (!local) url.pathname = "/vayada_target_prod";
  const appRoot = local ? process.cwd() : "/app";
  const load = name => import(`${appRoot}/apps/api/dist/${name}.js`);
  const { HOTEL_SETUP_CREATION_PRIVILEGES, HOTEL_SETUP_CREATION_RLS_HELPERS } = await load("hotelSetupCreationPrivileges");
  const { checkHotelSetupCreationCredential } = await load("cli/hotelSetupCreationPreflight");
  const { createSecretsManagerProviderCredentialVault, createMemoryProviderCredentialVault } =
    await load("platform/providerCredentialVault");
  const vault = local ? createMemoryProviderCredentialVault() :
    createSecretsManagerProviderCredentialVault({ region: "eu-west-1" });
  const { HOTEL_SETUP_CREATION_READER_READ_COLUMNS, HOTEL_SETUP_READER_READ_COLUMNS, HOTEL_SETUP_READER_AUDIT_COLUMNS, HOTEL_SETUP_READER_RLS_HELPERS } =
    await load("hotelSetupReaderPrivileges");
  const exportedHelpers = isReader ? HOTEL_SETUP_READER_RLS_HELPERS : HOTEL_SETUP_CREATION_RLS_HELPERS;
  if (exportedHelpers !== undefined && (!Array.isArray(exportedHelpers) ||
    !same(exportedHelpers, [...rlsHelpers.keys()]))) throw new Error();
  const { checkHotelSetupReader } = await load("cli/hotelSetupReaderPreflight");
  const inventory = purpose === "organization" ? HOTEL_SETUP_CREATION_PRIVILEGES :
    Object.fromEntries(Object.entries(readerMode === "property_commands" ? HOTEL_SETUP_READER_READ_COLUMNS : HOTEL_SETUP_CREATION_READER_READ_COLUMNS)
      .map(([relation, SELECT]) => [relation, { SELECT }]));
  if (isReader)
    inventory["platform.product_audit_events"].INSERT = HOTEL_SETUP_READER_AUDIT_COLUMNS;
  const readerSecretPrefix = purpose === "property_reader" ? "hotel-setup-command/prod/" : "hotel-setup-creation/prod/";
  const readerSecrets = [readerSecretPrefix + "reader-database-url", readerSecretPrefix + "internal-token"];
  let rawSecrets;
  if (!local && isReader) {
    const sdk = await import("@aws-sdk/client-secrets-manager");
    const client = new sdk.SecretsManagerClient({ region: "eu-west-1" });
    rawSecrets = {
      async get(reference) {
        try {
          const secret = await client.send(new sdk.GetSecretValueCommand({ SecretId: reference }),
            { abortSignal: AbortSignal.timeout(10_000) });
          if (typeof secret.SecretString !== "string") throw new Error();
          return secret.SecretString;
        } catch (error) {
          if (error.name === "ResourceNotFoundException") return null;
          throw error;
        }
      },
      async put(reference, value) {
        await client.send(new sdk.PutSecretValueCommand({ SecretId: reference, SecretString: value }),
          { abortSignal: AbortSignal.timeout(10_000) });
      },
    };
  } else rawSecrets = vault;
  if (isReader)
    for (const reference of readerSecrets) if (await rawSecrets.get(reference) !== null) throw new Error();
  const password = randomBytes(48).toString("base64url");
  const connection = (user, credential) => new pg.Client({
    host: url.hostname, port: Number(url.port || 5432),
    database: url.pathname.slice(1), user, password: credential,
    ssl: local ? { rejectUnauthorized: true } : {
      ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname },
    connectionTimeoutMillis: 10_000, query_timeout: 15_000,
    statement_timeout: 15_000, lock_timeout: 5_000,
    options: "-c search_path=pg_catalog",
  });
  admin = connection(decodeURIComponent(url.username), decodeURIComponent(url.password));
  admin.on("error", () => { connectionFailed = true; });
  admin.on("notice", notice => { if (notice.code === "01007") connectionFailed = true; });
  await admin.connect();
  migrationLocked = (await admin.query("SELECT pg_try_advisory_lock(8734516) AS locked")).rows[0]?.locked === true;
  if (!migrationLocked) throw new Error();
  await admin.query("BEGIN");
  const inspectHelpers = async () => (await admin.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,
to_jsonb(p)-'proacl' AS catalog,pg_get_functiondef(p.oid) AS definition,
p.proowner=(SELECT relowner FROM pg_class WHERE oid='platform.hotel_setup_creation_scopes'::regclass) AND
(pg_has_role(current_user,p.proowner,'USAGE') OR
has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')) AS trusted,
COALESCE((SELECT json_agg(a ORDER BY grantor,grantee)
FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a),'[]'::json) AS acl
FROM pg_proc p
WHERE p.oid=ANY($1::regprocedure[]) ORDER BY signature`,
  [[...rlsHelpers.keys()]])).rows;
  const helpersBefore = await inspectHelpers();
  if (helpersBefore.length !== 2 || helpersBefore.some(row => !row.trusted ||
    rlsHelpers.get(row.signature) !== createHash("sha256").update(row.definition).digest("hex"))) throw new Error();
  if (purpose === "organization") {
    const organization = await admin.query(`SELECT id FROM identity.organizations
      WHERE id=$1 AND kind='hotel_group' AND status='active' FOR UPDATE`, [organizationId]);
    if (organization.rowCount !== 1) throw new Error();
    const existing = await admin.query(`SELECT 1 FROM platform.hotel_setup_creation_scopes
      WHERE organization_id=$1`, [organizationId]);
    if (existing.rowCount) throw new Error();
  }
  await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  createdRole = true;
  const roleOid = (await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [role])).rows[0]?.oid;
  for (const signature of rlsHelpers.keys())
    await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
  const helpersAfter = await inspectHelpers();
  if (!roleOid || helpersAfter.length !== 2 || helpersBefore.some((before, index) => {
    const after = helpersAfter[index];
    const additions = after.acl.filter(edge => !before.acl.some(old => same(old, edge)));
    return !same({ ...before, acl: [] }, { ...after, acl: [] }) ||
      !before.acl.every(old => after.acl.some(edge => same(old, edge))) || additions.length !== 1 ||
      Number(additions[0].grantee) !== roleOid || additions[0].privilege_type !== "EXECUTE" || additions[0].is_grantable;
  })) throw new Error();
  await admin.query("SELECT pg_catalog.set_config('vay965.bootstrap_password',$1,true)", [password]);
  await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format('ALTER ROLE ${role} PASSWORD %L',
    pg_catalog.current_setting('vay965.bootstrap_password')); END $$`);
  const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
  await admin.query(`GRANT CONNECT ON DATABASE ${quote(url.pathname.slice(1))} TO ${role}`);
  const schemas = [...new Set(Object.keys(inventory).map(name => name.split(".")[0]))];
  await admin.query(`GRANT USAGE ON SCHEMA ${schemas.map(quote).join(",")} TO ${role}`);
  if (purpose === "organization")
    await admin.query(`GRANT vayada_next_hotel_setup_scope TO ${role} WITH INHERIT TRUE, SET FALSE`);
  for (const [relation, privileges] of Object.entries(inventory))
    for (const [privilege, columns] of Object.entries(privileges))
      await admin.query(`GRANT ${privilege} (${columns.map(quote).join(",")})
        ON ${relation.split(".").map(quote).join(".")} TO ${role}`);
  if (purpose === "organization") {
    await admin.query(`INSERT INTO platform.hotel_setup_creation_scopes
      (database_login,organization_id) VALUES ($1,$2)`, [role, organizationId]);
  }
  if (connectionFailed) throw new Error();
  await admin.query("COMMIT");
  await admin.query("SELECT pg_advisory_unlock(8734516)");
  migrationLocked = false;
  native = connection(role, password);
  native.on("error", () => { connectionFailed = true; });
  await native.connect();
  if (purpose === "organization") {
    await checkHotelSetupCreationCredential(native, { organizationId, actorUserId });
    await vault.put(prefix + role, { username: role, password }, AbortSignal.timeout(10_000));
    const stored = await vault.get(prefix + role, AbortSignal.timeout(10_000));
    if (stored?.username !== role || stored?.password !== password || Object.keys(stored).length !== 2)
      throw new Error();
  } else {
    await checkHotelSetupReader(native, readerMode);
    const credentialUrl = new URL(url);
    credentialUrl.username = role;
    credentialUrl.password = password;
    credentialUrl.search = "?sslmode=verify-full";
    const values = [credentialUrl.toString(), randomBytes(48).toString("base64url")];
    for (let index = 0; index < readerSecrets.length; index++) {
      await rawSecrets.put(readerSecrets[index], values[index]);
      if (await rawSecrets.get(readerSecrets[index]) !== values[index]) throw new Error();
    }
  }
  if (connectionFailed) throw new Error();
  console.log(JSON.stringify({ status: "PASS", role, purpose, ...(purpose === "organization" ? { organizationId } : {}) }));
} catch {
  await admin?.query("ROLLBACK").catch(() => undefined);
  let cleanupRequired = false;
  if (createdRole) {
    try {
      const exists = await admin.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1", [role]);
      if (exists.rowCount) {
        await admin.query("BEGIN");
        await admin.query(`ALTER ROLE ${role} NOLOGIN`);
        await admin.query("DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1", [role]);
        await admin.query("COMMIT");
        await admin.query("SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename=$1", [role]);
      }
    } catch {
      cleanupRequired = true;
      await admin.query("ROLLBACK").catch(() => undefined);
    }
  }
  console.error(JSON.stringify({ status: "FAIL", code: cleanupRequired ? "hotel_setup_creation_provision_cleanup_required" : "hotel_setup_creation_provision_failed", ...(createdRole ? { role } : {}) }));
  process.exitCode = 1;
} finally {
  await native?.end().catch(() => undefined);
  if (migrationLocked) await admin?.query("SELECT pg_advisory_unlock(8734516)").catch(() => undefined);
  await admin?.end().catch(() => undefined);
}
