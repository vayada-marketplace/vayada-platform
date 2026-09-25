// scripts/launch-vay2042-source-reader.mjs
import { randomUUID, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";

// scripts/fixtures/vay2042-source-reader.json
var vay2042_source_reader_default = {
  artifactSha256: "eff705e7526160363618ad5550958d3a74ba066c77ffae2e15b366a16e2fb15e",
  restoreInstanceId: "vay2017-metadata-rehearsal-isolated-20260923",
  restoreResourceId: "db-BB7GOFQ3BQTLTBG444I2Q75X6Y",
  sourceSnapshotId: "vay2017-legacy-source-freeze-20260920",
  databases: [
    "postgres",
    "vayada_auth_db",
    "vayada_booking_db",
    "vayada_pms_db",
    "vayada_pms_staging",
    "vayada_target_prod",
    "vayada_target_staging",
    "vayada_target_staging_12e19c65_01",
    "vayada_target_staging_12e19c65_02"
  ],
  sources: [
    {
      database: "postgres",
      tables: [
        "public.chat_messages",
        "public.collaboration_deliverables",
        "public.collaborations",
        "public.creator_platforms",
        "public.creator_ratings",
        "public.creators",
        "public.external_collaborations",
        "public.hotel_listings",
        "public.hotel_profiles",
        "public.invite_codes",
        "public.listing_collaboration_offerings",
        "public.listing_creator_requirements",
        "public.newsletter_preferences",
        "public.notifications",
        "public.schema_migrations",
        "public.trips"
      ]
    },
    {
      database: "vayada_auth_db",
      tables: [
        "public.consent_history",
        "public.cookie_consent",
        "public.email_change_tokens",
        "public.email_verification_codes",
        "public.email_verification_tokens",
        "public.gdpr_requests",
        "public.login_audit_log",
        "public.login_rate_limit",
        "public.password_reset_tokens",
        "public.schema_migrations",
        "public.totp_recovery_codes",
        "public.totp_secrets",
        "public.users"
      ]
    },
    {
      database: "vayada_booking_db",
      tables: [
        "public.booking_addons",
        "public.booking_events",
        "public.booking_hotel_translations",
        "public.booking_hotels",
        "public.booking_promo_codes",
        "public.commission_rate_changes",
        "public.schema_migrations"
      ]
    },
    {
      database: "vayada_pms_db",
      tables: [
        "inbox_prototype_archive_20260905.automation_sends",
        "inbox_prototype_archive_20260905.guest_automations",
        "inbox_prototype_archive_20260905.message_templates",
        "platform.media_objects",
        "platform.media_variants",
        "public.affiliate_clicks",
        "public.affiliate_payout_settings",
        "public.affiliates",
        "public.automation_sends",
        "public.booking_additional_guests",
        "public.booking_change_requests",
        "public.booking_checkin_records",
        "public.booking_checkout_charges",
        "public.booking_checkout_records",
        "public.booking_drafts",
        "public.booking_events",
        "public.booking_notes",
        "public.booking_notification_deliveries",
        "public.booking_promo_usage_state",
        "public.booking_rooms",
        "public.bookings",
        "public.cancellation_policies",
        "public.channex_booking_mappings",
        "public.channex_channel_markups",
        "public.channex_connections",
        "public.channex_rate_plan_mappings",
        "public.channex_room_type_mappings",
        "public.channex_webhook_events",
        "public.checkin_checklist_templates",
        "public.checkout_inspection_templates",
        "public.guest_automations",
        "public.hotel_payment_settings",
        "public.hotels",
        "public.linked_inventory_group_members",
        "public.linked_inventory_groups",
        "public.message_attachments",
        "public.message_templates",
        "public.message_threads",
        "public.messages",
        "public.payments",
        "public.payouts",
        "public.property_module_activations",
        "public.room_blocks",
        "public.room_types",
        "public.rooms",
        "public.schema_migrations",
        "public.stripe_billing_webhook_events"
      ]
    }
  ]
};

// scripts/provision-vay2042-source-reader.mjs
import { randomBytes as randomBytes2 } from "node:crypto";

// scripts/vay2017-pg-scram.mjs
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
var iterations = 4096;
function scramVerifier(password, salt = randomBytes(16)) {
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

// scripts/provision-vay2042-source-reader.mjs
var reader = "vay2042_source_reader_20260925";
var identifier = (value) => `"${value.replaceAll('"', '""')}"`;
var relation = (value) => value.split(".").map(identifier).join(".");
var requireTrue = (condition, code) => {
  if (!condition) throw new Error(code);
};
var applicationSchema = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";
var privilegeSql = `
SELECT
  EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS membership,
  EXISTS (SELECT 1 FROM pg_shdepend s WHERE s.refclassid = 'pg_authid'::regclass
    AND s.refobjid = r.oid AND s.deptype = 'o') AS ownership,
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication
    OR r.rolbypassrls OR r.rolcanlogin OR r.rolconnlimit <> 4 AS attributes,
  EXISTS (SELECT 1 FROM pg_database d WHERE
    has_database_privilege(r.oid, d.oid, 'CREATE') OR
    (d.datallowconn AND has_database_privilege(r.oid, d.oid, 'TEMP'))) AS database_write,
  EXISTS (SELECT 1 FROM pg_namespace n WHERE ${applicationSchema}
    AND has_schema_privilege(r.oid, n.oid, 'CREATE')) AS schema_write,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${applicationSchema} AND c.relkind IN ('r','p','v','m','f') AND (
      has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES') OR
      ((has_table_privilege(r.oid, c.oid, 'SELECT') OR has_any_column_privilege(r.oid, c.oid, 'SELECT'))
       AND NOT (n.nspname || '.' || c.relname = ANY($2::text[])))
    )) AS relation_privileges,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE CASE WHEN ${applicationSchema} AND c.relkind = 'S'
      THEN has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END) AS sequence_privileges,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE ${applicationSchema} AND p.prosecdef AND p.prokind IN ('f','p')
      AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS definer_privileges,
  EXISTS (SELECT 1 FROM unnest($2::text[]) expected(name)
    WHERE NOT has_table_privilege(r.oid, expected.name, 'SELECT')) AS missing_read
FROM pg_roles r WHERE r.rolname = $1`;
async function verifyPrivileges(client, tables) {
  const result = await client.query(privilegeSql, [reader, tables]);
  requireTrue(
    result.rowCount === 1 && Object.values(result.rows[0]).every((v) => v === false),
    "source_reader_privilege_mismatch"
  );
}
async function provisionSourceReader({ connect, persistCredential, now = () => Date.now() }) {
  const clients = /* @__PURE__ */ new Map();
  const control = await connect("postgres");
  clients.set("postgres", control);
  const password = randomBytes2(36).toString("base64url");
  let locked = false;
  try {
    locked = (await control.query("SELECT pg_try_advisory_lock(204220260925) AS locked")).rows[0]?.locked === true;
    requireTrue(locked, "source_reader_bootstrap_busy");
    const databases = (await control.query(`SELECT datname FROM pg_database
      WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin' ORDER BY datname`)).rows.map((r) => r.datname);
    requireTrue(JSON.stringify(databases) === JSON.stringify(vay2042_source_reader_default.databases), "restore_database_inventory_changed");
    requireTrue(
      (await control.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [reader])).rowCount === 0,
      "source_reader_exists_inspect_prior_attempt"
    );
    for (const database of databases) {
      const client = database === "postgres" ? control : await connect(database);
      clients.set(database, client);
      const source = vay2042_source_reader_default.sources.find((s) => s.database === database);
      if (!source) continue;
      const tables = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${applicationSchema} AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((r) => r.name);
      requireTrue(JSON.stringify(tables) === JSON.stringify(source.tables), "source_table_inventory_changed");
    }
    await control.query("BEGIN");
    try {
      const expiresAt = new Date(now() + 24 * 60 * 60 * 1e3).toISOString();
      const command = (await control.query(`SELECT format(
        'CREATE ROLE %I NOLOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 VALID UNTIL %L',
        $1::text, $2::text, $3::text) AS sql`, [reader, scramVerifier(password), expiresAt])).rows[0].sql;
      await control.query(command);
      await control.query(`ALTER ROLE ${identifier(reader)} SET default_transaction_read_only = on`);
      await control.query(`ALTER ROLE ${identifier(reader)} SET statement_timeout = '60s'`);
      await control.query(`ALTER ROLE ${identifier(reader)} SET idle_in_transaction_session_timeout = '60s'`);
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      throw error;
    }
    for (const [database, client] of clients) {
      const source = vay2042_source_reader_default.sources.find((s) => s.database === database);
      await client.query("BEGIN");
      try {
        await verifyPrivileges(client, []);
        if (source) {
          await client.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(reader)}`);
          for (const schema of new Set(source.tables.map((t) => t.split(".")[0]))) {
            await client.query(`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(reader)}`);
          }
          await client.query(`GRANT SELECT ON TABLE ${source.tables.map(relation).join(",")} TO ${identifier(reader)}`);
        }
        await verifyPrivileges(client, source?.tables ?? []);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    for (const [database, client] of clients) {
      await verifyPrivileges(client, vay2042_source_reader_default.sources.find((s) => s.database === database)?.tables ?? []);
    }
    await persistCredential({ username: reader, password });
    try {
      await control.query(`ALTER ROLE ${identifier(reader)} LOGIN`);
    } catch {
      throw new Error("source_reader_activation_outcome_unknown");
    }
    return { status: "OK", scope: "isolated-source-reader", databases: 4, tables: 83 };
  } finally {
    if (locked) await control.query("SELECT pg_advisory_unlock(204220260925)").catch(() => {
    });
    await Promise.all([...clients.values()].map((client) => client.end().catch(() => {
    })));
  }
}

// scripts/launch-vay2042-source-reader.mjs
var region = "eu-west-1";
var account = "269416271598";
var secretName = "vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925";
var secretPrefix = `arn:aws:secretsmanager:${region}:${account}:secret:${secretName}-`;
var attestation = "fe4c276728e025bb5b0ddf893042d4581a84b84317f7ce2f6e7080546d32ab16";
var caFingerprint = "6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86";
var requireTrue2 = (condition, code) => {
  if (!condition) throw new Error(code);
};
var stages = /* @__PURE__ */ new Set(["configuration", "credential-destination", "database-connect", "source-reader", "credential-store"]);
var codes = /* @__PURE__ */ new Set([
  "configuration_invalid",
  "database_ca_invalid",
  "database_endpoint_invalid",
  "credential_destination_not_empty",
  "source_reader_bootstrap_busy",
  "restore_database_inventory_changed",
  "source_table_inventory_changed",
  "source_reader_exists_inspect_prior_attempt",
  "source_reader_privilege_mismatch",
  "source_reader_activation_outcome_unknown",
  "22023",
  "42501",
  "28P01",
  "3D000",
  "25006",
  "42704",
  "42P01",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);
var classes = /* @__PURE__ */ new Set(["Error", "TypeError", "RangeError", "DatabaseError", "AggregateError", "AccessDeniedException", "InvalidRequestException"]);
function safeFailure(stage, cause) {
  return {
    status: "FAIL",
    stage: stages.has(stage) ? stage : "configuration",
    code: codes.has(cause?.code) ? cause.code : codes.has(cause?.message) ? cause.message : "UNKNOWN",
    errorClass: classes.has(cause?.name) ? cause.name : "Other"
  };
}
function configuration(env) {
  const host = env.VAY2042_DB_HOST ?? "";
  const secretArn = env.VAY2042_READER_SECRET_ARN ?? "";
  const hostPrefix = `${vay2042_source_reader_default.restoreInstanceId}.`;
  requireTrue2(
    env.AWS_REGION === region && env.VAY2042_RESTORE_INSTANCE_ID === vay2042_source_reader_default.restoreInstanceId && env.VAY2042_RESTORE_RESOURCE_ID === vay2042_source_reader_default.restoreResourceId && env.VAY2042_SOURCE_SNAPSHOT_ID === vay2042_source_reader_default.sourceSnapshotId && env.VAY2042_RESTORE_INSTANCE_ARN === `arn:aws:rds:${region}:${account}:db:${vay2042_source_reader_default.restoreInstanceId}` && env.VAY2042_RESTORE_ATTESTATION_CHECKSUM === attestation && env.VAY2042_DB_PORT === "5432" && env.VAY2042_DB_USER && env.VAY2042_DB_PASSWORD && host.startsWith(hostPrefix) && /^[a-z0-9]+\.eu-west-1\.rds\.amazonaws\.com$/.test(host.slice(hostPrefix.length)) && secretArn.startsWith(secretPrefix) && /^[A-Za-z0-9]{6}$/.test(secretArn.slice(secretPrefix.length)),
    "configuration_invalid"
  );
  let ca;
  try {
    ca = gunzipSync(Buffer.from(env.VAY2042_RDS_CA_BUNDLE_GZIP ?? "", "base64"), { maxOutputLength: 16384 }).toString("utf8");
    const certificate = new X509Certificate(ca);
    requireTrue2(
      certificate.toString().replace(/\s/g, "") === ca.replace(/\s/g, "") && certificate.fingerprint256 === caFingerprint,
      "database_ca_invalid"
    );
  } catch {
    throw new Error("database_ca_invalid");
  }
  return { host, secretArn, ca };
}
async function bootstrap(env, { Client, SecretsManagerClient, DescribeSecretCommand, PutSecretValueCommand, provision = provisionSourceReader }) {
  let stage = "configuration";
  let secrets;
  try {
    const { host, secretArn, ca } = configuration(env);
    secrets = new SecretsManagerClient({ region, endpoint: `https://secretsmanager.${region}.amazonaws.com` });
    stage = "credential-destination";
    const destination = await secrets.send(new DescribeSecretCommand({ SecretId: secretArn }));
    requireTrue2(
      destination.ARN === secretArn && destination.Name === secretName && !destination.DeletedDate && Object.keys(destination.VersionIdsToStages ?? {}).length === 0,
      "credential_destination_not_empty"
    );
    await provision({
      connect: async (database) => {
        requireTrue2(vay2042_source_reader_default.databases.includes(database), "configuration_invalid");
        stage = "database-connect";
        const client = new Client({
          host,
          port: 5432,
          database,
          user: env.VAY2042_DB_USER,
          password: env.VAY2042_DB_PASSWORD,
          ssl: { ca, rejectUnauthorized: true, servername: host },
          connectionTimeoutMillis: 1e4,
          statement_timeout: 6e4,
          application_name: "vay2042-source-reader-bootstrap-v1"
        });
        client.on("error", () => {
        });
        try {
          await client.connect();
          const { rows } = await client.query("SELECT inet_server_addr()::text AS address, current_database() AS database");
          requireTrue2(
            rows.length === 1 && rows[0].database === database && /^10\.230\.0\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(rows[0].address),
            "database_endpoint_invalid"
          );
          stage = "source-reader";
          return client;
        } catch (error) {
          await client.end().catch(() => {
          });
          throw error;
        }
      },
      persistCredential: async (credential) => {
        stage = "credential-store";
        requireTrue2(credential.username === reader && typeof credential.password === "string" && /^[A-Za-z0-9_-]{48}$/.test(credential.password), "configuration_invalid");
        await secrets.send(new PutSecretValueCommand({
          SecretId: secretArn,
          ClientRequestToken: randomUUID(),
          SecretString: JSON.stringify({ username: reader, password: credential.password })
        }));
        stage = "source-reader";
      }
    });
    return { status: "OK", stage: "complete", scope: "isolated-source-reader", databases: 4, tables: 83 };
  } catch (error) {
    return safeFailure(stage, error);
  } finally {
    secrets?.destroy();
  }
}
if (process.env.VAY2042_RUN_MAIN === "1") {
  let result;
  try {
    configuration(process.env);
    const [{ default: pg }, sdk] = await Promise.all([import("pg"), import("@aws-sdk/client-secrets-manager")]);
    result = await bootstrap(process.env, { Client: pg.Client, ...sdk });
  } catch (error) {
    result = safeFailure("configuration", error);
  }
  console.log(JSON.stringify(result));
  if (result.status !== "OK") process.exitCode = 1;
}
export {
  bootstrap,
  configuration,
  safeFailure,
  secretName
};
