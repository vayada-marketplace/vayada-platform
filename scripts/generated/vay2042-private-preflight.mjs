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

// scripts/launch-vay2042-source-reader.mjs
import { randomUUID, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";

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
  const control = await connect("postgres");
  const withDatabase = async (database, action) => {
    const client = database === "postgres" ? control : await connect(database);
    try {
      return await action(client);
    } finally {
      if (client !== control) await client.end();
    }
  };
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
      await withDatabase(database, async (client) => {
        const source = vay2042_source_reader_default.sources.find((s) => s.database === database);
        if (!source) return;
        const tables = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ${applicationSchema} AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((r) => r.name);
        requireTrue(JSON.stringify(tables) === JSON.stringify(source.tables), "source_table_inventory_changed");
      });
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
    for (const database of databases) await withDatabase(database, async (client) => {
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
    });
    for (const database of databases) await withDatabase(database, (client) => verifyPrivileges(client, vay2042_source_reader_default.sources.find((s) => s.database === database)?.tables ?? []));
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
    await control.end().catch(() => {
    });
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
          const { rows } = await client.query("SELECT host(inet_server_addr()) AS address, current_database() AS database");
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

// scripts/provision-vay2042-target.mjs
var target = "vay2042_target_rehearsal_20260925";
var writer = "vay2042_target_writer_20260925";
var attestor = "vayada_migration_attestor";

// scripts/vay2042-private-preflight.mjs
var requireTrue3 = (condition, code) => {
  if (!condition) throw new Error(code);
};
var initialExpiry = /* @__PURE__ */ new Map([
  [reader, ["2026-09-26T13:22:00Z", "2026-09-26T13:23:15Z"]],
  [writer, ["2026-09-26T13:33:58Z", "2026-09-26T13:34:59Z"]]
]);
var expectedDatabases = [...vay2042_source_reader_default.databases, target].sort();
var expectedSettings = [
  "default_transaction_read_only=on",
  "idle_in_transaction_session_timeout=60s",
  "statement_timeout=60s"
].sort();
var credentials = [
  {
    arn: "arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925-4kTuiw",
    name: "vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925",
    version: "91d7b931-e78e-419f-8a9f-b1aeb9c259ba"
  },
  {
    arn: "arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925-mfr57v",
    name: "vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925",
    version: "220507a8-4ac8-4bab-bd57-221862dd2dcc"
  }
];
function checkSecretMetadata(metadata, expected) {
  const versions = metadata?.VersionIdsToStages ?? {};
  requireTrue3(
    metadata?.ARN === expected.arn && metadata?.Name === expected.name && !metadata.DeletedDate && Object.keys(versions).length === 1 && JSON.stringify(versions[expected.version]) === JSON.stringify(["AWSCURRENT"]),
    "credential_version_changed"
  );
}
function checkRole(row, name, now) {
  const window = initialExpiry.get(name);
  const expiry = new Date(row?.rolvaliduntil).getTime();
  requireTrue3(
    row?.rolname === name && row.rolcanlogin === true && row.rolconnlimit === 4 && [
      row.rolsuper,
      row.rolcreatedb,
      row.rolcreaterole,
      row.rolinherit,
      row.rolreplication,
      row.rolbypassrls
    ].every((value) => value === false) && Number.isFinite(expiry) && expiry >= Date.parse(window[0]) && expiry <= Date.parse(window[1]) && expiry < now,
    "role_identity_or_expiry_mismatch"
  );
}
async function checkPrivileges(client, name, tables, ignored = []) {
  const result = await client.query(privilegeSql, [name, tables]);
  requireTrue3(
    result.rowCount === 1 && Object.entries(result.rows[0]).every(
      ([key, value]) => value === (key === "attributes" || ignored.includes(key))
    ),
    "role_privilege_mismatch"
  );
}
async function checkOldDatabase(client, database) {
  const source = vay2042_source_reader_default.sources.find((entry) => entry.database === database);
  if (source) {
    const tables = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((row) => row.name);
    requireTrue3(JSON.stringify(tables) === JSON.stringify(source.tables), "source_table_inventory_changed");
  }
  await checkPrivileges(client, reader, source?.tables ?? []);
  await checkPrivileges(client, writer, [], ["database_write"]);
  const defaults = await client.query(`SELECT count(*)::int AS grants FROM pg_default_acl d,
    LATERAL aclexplode(d.defaclacl) a
    WHERE a.grantee = 0 OR a.grantee IN
      (SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[]))`, [[reader, writer]]);
  requireTrue3(defaults.rows[0]?.grants === 0, "old_database_default_acl_mismatch");
  const boundary = await client.query(`SELECT NOT has_database_privilege($1, current_database(), 'CREATE')
    AND NOT has_database_privilege($1, current_database(), 'TEMP') AS writer_denied`, [writer]);
  requireTrue3(boundary.rows[0]?.writer_denied === true, "old_database_writer_privilege_mismatch");
}
async function checkTarget(client, admin = true) {
  const schemas = (await client.query(`SELECT nspname AS name FROM pg_namespace
    WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' ORDER BY 1`)).rows.map((row) => row.name);
  requireTrue3(
    JSON.stringify(schemas) === JSON.stringify(["public", "vayada_migration_evidence"]),
    "target_not_clean"
  );
  const relations = (await client.query(`SELECT n.nspname || '.' || c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' ORDER BY 1`)).rows.map((row) => row.name);
  requireTrue3(JSON.stringify(relations) === JSON.stringify([
    "vayada_migration_evidence.database_attestations",
    "vayada_migration_evidence.database_attestations_pkey"
  ]), "target_not_clean");
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='vayada_migration_evidence' AND c.relname='database_attestations'
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
  requireTrue3(JSON.stringify(columns) === JSON.stringify([
    { name: "attestation_key", type: "text", required: true, default_value: null },
    { name: "attestation_value", type: "text", required: true, default_value: null },
    { name: "attested_at", type: "timestamp with time zone", required: true, default_value: "now()" }
  ]), "target_evidence_shape_mismatch");
  const constraints = (await client.query(`SELECT conname AS name, contype AS type,
    conkey::text AS columns, convalidated AS valid, condeferrable AS deferrable
    FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='vayada_migration_evidence' AND c.relname='database_attestations'`)).rows;
  requireTrue3(JSON.stringify(constraints) === JSON.stringify([
    { name: "database_attestations_pkey", type: "p", columns: "{1}", valid: true, deferrable: false }
  ]), "target_evidence_shape_mismatch");
  const objects = await client.query(`SELECT
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_') AS routines,
    (SELECT count(*)::int FROM pg_default_acl) AS defaults,
    (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND t.typtype IN ('b','d','e','r','m') AND t.typelem = 0) AS types,
    (SELECT count(*)::int FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_') AS operators,
    (SELECT count(*)::int FROM pg_event_trigger) AS event_triggers,
    (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
    (SELECT count(*)::int FROM pg_policy) AS policies,
    (SELECT count(*)::int FROM pg_extension WHERE extname <> 'plpgsql') AS extensions`);
  requireTrue3([
    "routines",
    "defaults",
    "types",
    "operators",
    "event_triggers",
    "triggers",
    "policies",
    "extensions"
  ].every((key) => objects.rows[0]?.[key] === 0), "target_not_clean");
  if (admin) {
    const owner = await client.query(`SELECT
    c.relowner = r.oid AND n.nspowner = r.oid AS owned_by_attestor,
    NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
      AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls AS safe_role,
    NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid OR
      (roleid=r.oid AND inherit_option)) AS safe_membership,
    pg_has_role(current_user, r.oid, 'SET') AS admin_can_set_role
    FROM pg_roles r JOIN pg_namespace n ON n.nspname='vayada_migration_evidence'
    JOIN pg_class c ON c.relnamespace=n.oid AND c.relname='database_attestations'
    WHERE r.rolname=$1`, [attestor]);
    requireTrue3(
      owner.rowCount === 1 && Object.values(owner.rows[0]).every((value) => value === true),
      "target_attestor_mismatch"
    );
    await client.query("BEGIN READ ONLY");
  }
  try {
    if (admin) await client.query(`SET LOCAL ROLE "${attestor}"`);
    await checkPrivileges(client, reader, []);
    await checkPrivileges(
      client,
      writer,
      ["vayada_migration_evidence.database_attestations"],
      ["database_write", "schema_write"]
    );
    const boundary = await client.query(`SELECT
      NOT has_database_privilege($1, current_database(), 'CONNECT') AS source_denied,
      has_database_privilege($2, current_database(), 'CONNECT')
        AND has_database_privilege($2, current_database(), 'CREATE')
        AND NOT has_database_privilege($2, current_database(), 'TEMP')
        AND has_schema_privilege($2, 'vayada_migration_evidence', 'USAGE')
        AND NOT has_schema_privilege($2, 'vayada_migration_evidence', 'CREATE')
        AND has_schema_privilege($2, 'public', 'USAGE')
        AND has_schema_privilege($2, 'public', 'CREATE')
        AND has_table_privilege($2, 'vayada_migration_evidence.database_attestations', 'SELECT')
        AND NOT has_table_privilege($2, 'vayada_migration_evidence.database_attestations',
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writer_boundary`, [reader, writer]);
    requireTrue3(
      boundary.rows[0]?.source_denied === true && boundary.rows[0]?.writer_boundary === true,
      "target_privilege_mismatch"
    );
    const evidence = await client.query("SELECT count(*)::int AS rows FROM vayada_migration_evidence.database_attestations");
    requireTrue3(evidence.rows[0]?.rows === 0, "target_not_clean");
  } finally {
    if (admin) await client.query("ROLLBACK");
  }
}
async function runPreflight({ connect, checkCredentials = async () => {
}, now = () => Date.now() }) {
  const control = await connect("postgres", "admin");
  let locked = false;
  let committed = false;
  let commitAttempted = false;
  try {
    locked = (await control.query("SELECT pg_try_advisory_lock(204220260925) AS locked")).rows[0]?.locked === true;
    requireTrue3(locked, "preflight_busy");
    const databases = (await control.query(`SELECT datname FROM pg_database
      WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin' ORDER BY datname`)).rows.map((row) => row.datname);
    requireTrue3(JSON.stringify(databases) === JSON.stringify(expectedDatabases), "database_inventory_mismatch");
    const roles = (await control.query(`SELECT rolname,rolcanlogin,rolconnlimit,rolsuper,rolcreatedb,
      rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolvaliduntil
      FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [[reader, writer]])).rows;
    requireTrue3(roles.length === 2, "role_identity_or_expiry_mismatch");
    for (const name of [reader, writer]) checkRole(roles.find((role) => role.rolname === name), name, now());
    const settings = (await control.query(`SELECT r.rolname,s.setdatabase = 0 AS global,s.setconfig FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname = ANY($1::text[])`, [[reader, writer]])).rows;
    requireTrue3(
      settings.length === 1 && settings[0].rolname === reader && settings[0].global === true && JSON.stringify([...settings[0].setconfig].sort()) === JSON.stringify(expectedSettings),
      "role_settings_mismatch"
    );
    for (const database of vay2042_source_reader_default.databases) {
      const client = database === "postgres" ? control : await connect(database, "admin");
      try {
        await checkOldDatabase(client, database);
      } finally {
        if (client !== control) await client.end();
      }
    }
    const fresh = await connect(target, "admin");
    try {
      await checkTarget(fresh);
    } finally {
      await fresh.end();
    }
    await checkCredentials();
    const expiry = new Date(now() + 864e5).toISOString();
    await control.query("BEGIN");
    try {
      for (const name of [reader, writer]) {
        const sql = (await control.query(
          `SELECT format('ALTER ROLE %I VALID UNTIL %L', $1::text,$2::text) AS sql`,
          [name, expiry]
        )).rows[0].sql;
        await control.query(sql);
      }
      commitAttempted = true;
      await control.query("COMMIT");
      committed = true;
    } catch (error) {
      await control.query("ROLLBACK").catch(() => {
      });
      throw error;
    }
    for (const { database } of vay2042_source_reader_default.sources) {
      const client = await connect(database, "source");
      try {
        await client.query("BEGIN READ ONLY");
        try {
          await checkPrivileges(client, reader, vay2042_source_reader_default.sources.find((s) => s.database === database).tables);
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        await client.end();
      }
    }
    const writerClient = await connect(target, "writer");
    try {
      await writerClient.query("BEGIN READ ONLY");
      try {
        await checkTarget(writerClient, false);
      } finally {
        await writerClient.query("ROLLBACK");
      }
    } finally {
      await writerClient.end();
    }
    return {
      status: "OK",
      stage: "complete",
      scope: "isolated-catalog-preflight",
      databases: 10,
      tables: 83,
      bound: false,
      expiresAt: expiry
    };
  } catch (error) {
    if (committed || commitAttempted) throw new Error("renewal_committed_requires_inspection");
    throw error;
  } finally {
    if (locked) await control.query("SELECT pg_advisory_unlock(204220260925)").catch(() => {
    });
    await control.end().catch(() => {
    });
  }
}
var stages2 = /* @__PURE__ */ new Set(["configuration", "database-connect", "preflight", "credential-version"]);
var codes2 = /* @__PURE__ */ new Set([
  "configuration_invalid",
  "database_ca_invalid",
  "database_endpoint_invalid",
  "preflight_busy",
  "credential_version_changed",
  "database_inventory_mismatch",
  "role_identity_or_expiry_mismatch",
  "role_settings_mismatch",
  "source_table_inventory_changed",
  "role_privilege_mismatch",
  "target_not_clean",
  "old_database_default_acl_mismatch",
  "old_database_writer_privilege_mismatch",
  "target_evidence_shape_mismatch",
  "target_privilege_mismatch",
  "target_attestor_mismatch",
  "renewal_committed_requires_inspection",
  "42501",
  "28P01",
  "3D000",
  "25006",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);
var classes2 = /* @__PURE__ */ new Set(["Error", "TypeError", "DatabaseError", "AggregateError"]);
var safeFailure2 = (stage, error) => ({
  status: "FAIL",
  stage: stages2.has(stage) ? stage : "preflight",
  code: codes2.has(error?.code) ? error.code : codes2.has(error?.message) ? error.message : "UNKNOWN",
  errorClass: classes2.has(error?.name) ? error.name : "Other"
});
async function launch(env, { Client, SecretsManagerClient, DescribeSecretCommand }) {
  let stage = "configuration";
  try {
    const { host, ca } = configuration(env);
    requireTrue3(
      env.VAY2042_PRECHECK_MAIN === "1" && env.VAY2042_READER_SECRET_ARN === credentials[0].arn && env.VAY2042_SOURCE_USER === reader && env.VAY2042_SOURCE_PASSWORD && env.VAY2042_TARGET_USER === writer && env.VAY2042_TARGET_PASSWORD && env.VAY2042_TARGET_SECRET_ARN === credentials[1].arn,
      "configuration_invalid"
    );
    stage = "database-connect";
    const connect = async (database, identity) => {
      requireTrue3(
        expectedDatabases.includes(database) && (identity === "admin" || identity === "source" && vay2042_source_reader_default.sources.some((s) => s.database === database) || identity === "writer" && database === target),
        "configuration_invalid"
      );
      const credentials2 = identity === "admin" ? [env.VAY2042_DB_USER, env.VAY2042_DB_PASSWORD] : identity === "source" ? [env.VAY2042_SOURCE_USER, env.VAY2042_SOURCE_PASSWORD] : [env.VAY2042_TARGET_USER, env.VAY2042_TARGET_PASSWORD];
      const client = new Client({
        host,
        port: 5432,
        database,
        user: credentials2[0],
        password: credentials2[1],
        ssl: { ca, rejectUnauthorized: true, servername: host },
        connectionTimeoutMillis: 1e4,
        statement_timeout: 6e4,
        application_name: "vay2042-private-preflight-v1"
      });
      client.on("error", () => {
      });
      try {
        await client.connect();
        const result = await client.query(`SELECT current_database() AS database,session_user AS login,
          host(inet_server_addr()) AS address,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl`);
        requireTrue3(
          result.rows[0]?.database === database && result.rows[0]?.login === credentials2[0] && result.rows[0]?.ssl === true && /^10\.230\.0\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(result.rows[0]?.address),
          "database_endpoint_invalid"
        );
        stage = "preflight";
        return client;
      } catch (error) {
        await client.end().catch(() => {
        });
        throw error;
      }
    };
    return await runPreflight({ connect, checkCredentials: async () => {
      stage = "credential-version";
      const secrets = new SecretsManagerClient({
        region: "eu-west-1",
        endpoint: "https://secretsmanager.eu-west-1.amazonaws.com"
      });
      try {
        for (const expected of credentials) {
          const metadata = await secrets.send(new DescribeSecretCommand({ SecretId: expected.arn }));
          checkSecretMetadata(metadata, expected);
        }
      } finally {
        secrets.destroy();
      }
      stage = "preflight";
    } });
  } catch (error) {
    return safeFailure2(stage, error);
  }
}
if (process.env.VAY2042_PRECHECK_MAIN === "1") {
  let result;
  try {
    const [{ default: pg }, sdk] = await Promise.all([
      import("pg"),
      import("@aws-sdk/client-secrets-manager")
    ]);
    result = await launch(process.env, { Client: pg.Client, ...sdk });
  } catch (error) {
    result = safeFailure2("configuration", error);
  }
  console.log(JSON.stringify(result));
  if (result.status !== "OK") process.exitCode = 1;
}
export {
  checkRole,
  checkSecretMetadata,
  launch,
  runPreflight
};
