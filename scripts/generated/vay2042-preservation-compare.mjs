var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// scripts/fixtures/vay2042-source-reader.json
var vay2042_source_reader_default;
var init_vay2042_source_reader = __esm({
  "scripts/fixtures/vay2042-source-reader.json"() {
    vay2042_source_reader_default = {
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
  }
});

// scripts/vay2017-pg-scram.mjs
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
function scramVerifier(password, salt = randomBytes(16)) {
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}
var iterations;
var init_vay2017_pg_scram = __esm({
  "scripts/vay2017-pg-scram.mjs"() {
    iterations = 4096;
  }
});

// scripts/provision-vay2042-source-reader.mjs
var provision_vay2042_source_reader_exports = {};
__export(provision_vay2042_source_reader_exports, {
  privilegeSql: () => privilegeSql,
  provisionSourceReader: () => provisionSourceReader,
  reader: () => reader
});
import { randomBytes as randomBytes2 } from "node:crypto";
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
var reader, identifier, relation, requireTrue, applicationSchema, privilegeSql;
var init_provision_vay2042_source_reader = __esm({
  "scripts/provision-vay2042-source-reader.mjs"() {
    init_vay2042_source_reader();
    init_vay2017_pg_scram();
    reader = "vay2042_source_reader_20260925";
    identifier = (value) => `"${value.replaceAll('"', '""')}"`;
    relation = (value) => value.split(".").map(identifier).join(".");
    requireTrue = (condition, code) => {
      if (!condition) throw new Error(code);
    };
    applicationSchema = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";
    privilegeSql = `
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
  }
});

// scripts/vay2042-preservation-compare.mjs
init_vay2042_source_reader();
import { createHash as createHash2, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
var sourceId = "vay2017-metadata-rehearsal-isolated-20260923";
var sourceResource = "db-BB7GOFQ3BQTLTBG444I2Q75X6Y";
var controlId = "vay2042-preservation-control-20260927";
var controlResource = "db-KWO2HSCRBXNV75OK7LNIBZN7TQ";
var controlRestoreEvent = "7781e4d4-0024-4baa-85ea-0ec293175d8b";
var snapshot = "vay2017-legacy-source-freeze-20260920";
var sourceUser = "vay2042_source_reader_20260925";
var caFingerprint = "6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86";
var queryVersion = "source-preservation-jsonb-v1";
var requireTrue2 = (condition, code) => {
  if (!condition) throw new Error(code);
};
var sha256 = (value) => createHash2("sha256").update(value).digest("hex");
var relation2 = (name) => {
  requireTrue2(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name), "manifest_invalid");
  return name.split(".").map((part) => `"${part}"`).join(".");
};
function configuration(env) {
  requireTrue2(
    env.AWS_REGION === "eu-west-1" && env.VAY2042_COMPARE_MAIN === "1" && env.VAY2042_SOURCE_ID === sourceId && env.VAY2042_SOURCE_RESOURCE === sourceResource && env.VAY2042_CONTROL_ID === controlId && env.VAY2042_CONTROL_RESOURCE === controlResource && env.VAY2042_CONTROL_RESTORE_EVENT === controlRestoreEvent && env.VAY2042_SNAPSHOT_ID === snapshot && env.VAY2042_SOURCE_USER === sourceUser && env.VAY2042_CONTROL_USER === "vayada_admin" && env.VAY2042_SOURCE_PASSWORD && env.VAY2042_CONTROL_PASSWORD && vay2042_source_reader_default.restoreResourceId === sourceResource && vay2042_source_reader_default.sourceSnapshotId === snapshot && vay2042_source_reader_default.sources.length === 4 && vay2042_source_reader_default.sources.reduce((n, source) => n + source.tables.length, 0) === 83,
    "configuration_invalid"
  );
  for (const [id, host] of [[sourceId, env.VAY2042_SOURCE_HOST], [controlId, env.VAY2042_CONTROL_HOST]]) {
    requireTrue2(
      typeof host === "string" && host.startsWith(`${id}.`) && /^[a-z0-9]+\.eu-west-1\.rds\.amazonaws\.com$/.test(host.slice(id.length + 1)),
      "configuration_invalid"
    );
  }
  let ca;
  try {
    ca = gunzipSync(
      Buffer.from(env.VAY2042_RDS_CA_BUNDLE_GZIP ?? "", "base64"),
      { maxOutputLength: 16384 }
    ).toString("utf8");
    requireTrue2(new X509Certificate(ca).fingerprint256 === caFingerprint, "database_ca_invalid");
  } catch {
    throw new Error("database_ca_invalid");
  }
  return { ca };
}
async function checksumTable(client, table) {
  const name = relation2(table);
  await client.query(`DECLARE vay2042_rows NO SCROLL CURSOR FOR
    SELECT to_jsonb(t)::text AS row_json FROM ${name} AS t ORDER BY to_jsonb(t)::text`);
  const digest = createHash2("sha256");
  let count = 0;
  try {
    while (true) {
      const rows = (await client.query("FETCH FORWARD 500 FROM vay2042_rows")).rows;
      if (rows.length === 0) break;
      for (const row of rows) {
        requireTrue2(typeof row.row_json === "string", "row_invalid");
        digest.update(`${sha256(row.row_json)}
`);
        count += 1;
      }
    }
  } finally {
    await client.query("CLOSE vay2042_rows").catch(() => {
    });
  }
  return { count, sha256: digest.digest("hex") };
}
async function checkConnection(client, database, user) {
  if (user === sourceUser) {
    requireTrue2((await client.query("SHOW default_transaction_read_only")).rows[0]?.default_transaction_read_only === "on", "source_privilege_mismatch");
  } else {
    await client.query("SET default_transaction_read_only=on");
  }
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const identity = (await client.query(`SELECT host(inet_server_addr()) AS address,
    current_database() AS database, current_user AS username, session_user AS session_username,
    current_setting('transaction_read_only') AS read_only`)).rows;
  requireTrue2(
    identity.length === 1 && identity[0].database === database && identity[0].username === user && identity[0].session_username === user && identity[0].read_only === "on" && /^10\.230\.0\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(identity[0].address),
    "database_identity_invalid"
  );
}
async function checkInventory(client, expected) {
  const tables = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname <> 'vay2017_metadata'
      AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((row) => row.name);
  requireTrue2(JSON.stringify(tables) === JSON.stringify(expected), "table_inventory_mismatch");
}
async function checkSourcePrivileges(client, expected) {
  const role = (await client.query(`SELECT rolname, rolcanlogin, rolconnlimit, rolsuper,
    rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolvaliduntil
    FROM pg_roles WHERE rolname=$1`, [sourceUser])).rows;
  requireTrue2(
    role.length === 1 && role[0].rolname === sourceUser && role[0].rolcanlogin === true && role[0].rolconnlimit === 4 && [
      role[0].rolsuper,
      role[0].rolcreatedb,
      role[0].rolcreaterole,
      role[0].rolinherit,
      role[0].rolreplication,
      role[0].rolbypassrls
    ].every((value) => value === false) && new Date(role[0].rolvaliduntil).getTime() > Date.now() + 72e5,
    "source_privilege_mismatch"
  );
  const { privilegeSql: privilegeSql2 } = await Promise.resolve().then(() => (init_provision_vay2042_source_reader(), provision_vay2042_source_reader_exports));
  const result = await client.query(privilegeSql2, [sourceUser, expected]);
  requireTrue2(
    result.rowCount === 1 && Object.entries(result.rows[0]).every(
      ([key, value]) => value === (key === "attributes")
    ),
    "source_privilege_mismatch"
  );
}
async function compare({ connect }) {
  const tables = [];
  for (const source of vay2042_source_reader_default.sources) {
    const database = source.database;
    const control = await connect("control", database);
    const expected = [];
    try {
      await checkConnection(control, database, "vayada_admin");
      await checkInventory(control, source.tables);
      for (const table of source.tables) {
        expected.push({ database, table, ...await checksumTable(control, table) });
      }
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK").catch(() => {
      });
      throw error;
    } finally {
      await control.end().catch(() => {
      });
    }
    const current = await connect("source", database);
    try {
      await checkConnection(current, database, sourceUser);
      await checkInventory(current, source.tables);
      await checkSourcePrivileges(current, source.tables);
      for (const original of expected) {
        const restored = await checksumTable(current, original.table);
        requireTrue2(
          original.count === restored.count && original.sha256 === restored.sha256,
          "source_rows_mismatch"
        );
        tables.push({ database, table: original.table, count: original.count, sha256: original.sha256 });
      }
      await current.query("COMMIT");
    } catch (error) {
      await current.query("ROLLBACK").catch(() => {
      });
      throw error;
    } finally {
      await current.end().catch(() => {
      });
    }
  }
  requireTrue2(tables.length === 83, "table_inventory_mismatch");
  const evidence = {
    queryVersion,
    snapshot,
    sourceId,
    sourceResource,
    controlId,
    controlResource,
    controlRestoreEvent,
    tables
  };
  return {
    status: "OK",
    scope: "isolated-source-preservation",
    databases: 4,
    tables: 83,
    rows: tables.reduce((n, row) => n + row.count, 0),
    evidenceSha256: sha256(JSON.stringify(evidence)),
    evidence
  };
}
if (process.env.VAY2042_COMPARE_MAIN === "1") {
  let stage = "configuration";
  try {
    const { ca } = configuration(process.env);
    const { default: pg } = await import("pg");
    stage = "comparison";
    const report = await compare({ connect: async (kind, database) => {
      const host = process.env[kind === "source" ? "VAY2042_SOURCE_HOST" : "VAY2042_CONTROL_HOST"];
      const user = process.env[kind === "source" ? "VAY2042_SOURCE_USER" : "VAY2042_CONTROL_USER"];
      const password = process.env[kind === "source" ? "VAY2042_SOURCE_PASSWORD" : "VAY2042_CONTROL_PASSWORD"];
      const client = new pg.Client({
        host,
        port: 5432,
        database,
        user,
        password,
        ssl: { ca, rejectUnauthorized: true, servername: host },
        connectionTimeoutMillis: 1e4,
        statement_timeout: 9e5,
        application_name: "vay2042-source-preservation-v1"
      });
      client.on("error", () => {
      });
      try {
        await client.connect();
      } catch (error) {
        await client.end().catch(() => {
        });
        throw error;
      }
      return client;
    } });
    console.log(JSON.stringify(report));
  } catch (error) {
    const codes = /* @__PURE__ */ new Set([
      "configuration_invalid",
      "database_ca_invalid",
      "manifest_invalid",
      "database_identity_invalid",
      "table_inventory_mismatch",
      "row_invalid",
      "source_rows_mismatch",
      "source_privilege_mismatch"
    ]);
    console.error(JSON.stringify({
      status: "FAIL",
      scope: "isolated-source-preservation",
      stage,
      code: codes.has(error?.message) ? error.message : "comparison_failed"
    }));
    process.exitCode = 1;
  }
}
export {
  checksumTable,
  compare,
  configuration
};
