import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

// Operational bootstrap only, in the reviewed application image. Never a service entrypoint.
const host = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const prefix = "hotel-setup-command/prod/organization/";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const purpose = process.env.HOTEL_SETUP_BOOTSTRAP_PURPOSE ?? "organization";
const role = purpose === "organization"
  ? "vayada_next_hotel_setup_org_" + randomUUID().replaceAll("-", "")
  : "vayada_next_hotel_setup_creation_reader";
let admin;
let native;
let createdRole = false;
let connectionFailed = false;
try {
  const organizationId = process.env.HOTEL_SETUP_COMMAND_ORGANIZATION_ID ?? "";
  const actorUserId = process.env.HOTEL_SETUP_COMMAND_ACTOR_USER_ID ?? "";
  if (!["organization", "creation_reader"].includes(purpose) ||
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
  const { HOTEL_SETUP_CREATION_PRIVILEGES } = await import(
    `${appRoot}/apps/api/dist/hotelSetupCreationPrivileges.js`);
  const { checkHotelSetupCreationCredential } = await import(
    `${appRoot}/apps/api/dist/cli/hotelSetupCreationPreflight.js`);
  const { createSecretsManagerProviderCredentialVault, createMemoryProviderCredentialVault } =
    await import(`${appRoot}/apps/api/dist/platform/providerCredentialVault.js`);
  const vault = local ? createMemoryProviderCredentialVault() :
    createSecretsManagerProviderCredentialVault({ region: "eu-west-1" });
  const { HOTEL_SETUP_CREATION_READER_READ_COLUMNS, HOTEL_SETUP_READER_AUDIT_COLUMNS } =
    await import(`${appRoot}/apps/api/dist/hotelSetupReaderPrivileges.js`);
  const { checkHotelSetupReader } = await import(`${appRoot}/apps/api/dist/cli/hotelSetupReaderPreflight.js`);
  const inventory = purpose === "organization" ? HOTEL_SETUP_CREATION_PRIVILEGES :
    Object.fromEntries(Object.entries(HOTEL_SETUP_CREATION_READER_READ_COLUMNS)
      .map(([relation, SELECT]) => [relation, { SELECT }]));
  if (purpose === "creation_reader")
    inventory["platform.product_audit_events"].INSERT = HOTEL_SETUP_READER_AUDIT_COLUMNS;
  const readerSecrets = ["hotel-setup-creation/prod/reader-database-url", "hotel-setup-creation/prod/internal-token"];
  let rawSecrets;
  if (!local && purpose === "creation_reader") {
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
  if (purpose === "creation_reader")
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
  // Never emit pg diagnostics or credential-bearing connection errors.
  admin.on("error", () => { connectionFailed = true; });
  await admin.connect();
  await admin.query("BEGIN");
  if (purpose === "organization") {
    const organization = await admin.query(`SELECT id FROM identity.organizations
      WHERE id=$1 AND kind='hotel_group' AND status='active' FOR UPDATE`, [organizationId]);
    if (organization.rowCount !== 1) throw new Error();
    const existing = await admin.query(`SELECT 1 FROM platform.hotel_setup_creation_scopes
      WHERE organization_id=$1`, [organizationId]);
    if (existing.rowCount) throw new Error();
  }
  // CREATE fails if this identity exists; never adopt or rotate it.
  await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  createdRole = true;
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
    await vault.put(prefix + role, { username: role, password }, AbortSignal.timeout(10_000));
    const stored = await vault.get(prefix + role, AbortSignal.timeout(10_000));
    if (stored?.username !== role || stored?.password !== password || Object.keys(stored).length !== 2)
      throw new Error();
  }
  if (connectionFailed) throw new Error();
  await admin.query("COMMIT");
  native = connection(role, password);
  native.on("error", () => { connectionFailed = true; });
  await native.connect();
  if (purpose === "organization")
    await checkHotelSetupCreationCredential(native, { organizationId, actorUserId });
  else {
    await checkHotelSetupReader(native, "property_creation");
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
    // Check after rollback too: a lost COMMIT response may still have committed.
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
  await admin?.end().catch(() => undefined);
}
