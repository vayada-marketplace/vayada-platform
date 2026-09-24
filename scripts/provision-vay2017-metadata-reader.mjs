import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';

const { Client } = pg;
function scramVerifier(password, salt = randomBytes(16)) {
  const saltedPassword = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}
const reader = 'vay2017_metadata_reader';
const helperSchema = 'vay2017_metadata';
const helperFunction = 'count_table_rows';
const snapshotId = 'vay2017-legacy-source-freeze-20260920';
const restoreId = 'vay2017-metadata-rehearsal-isolated-20260923';
const rdsCaFingerprint = '6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86';
const safeNetworkCodes = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const safePgCodes = new Set(['22023', '42501', '28P01', '3D000', '25006', '42704', '42P01']);
const internalCodes = new Set([
  'restore_identity_invalid', 'database_endpoint_invalid', 'reader_privilege_check_failed',
  'function_owner_lacks_select', 'database_ca_invalid',
]);
const phases = new Set(['configuration', 'database-connect', 'database-discovery', 'reader-provision', 'reader-secret']);
function safeFailure(phase, cause) {
  const driverCode = typeof cause?.code === 'string' ? cause.code : '';
  const code = safePgCodes.has(driverCode) || safeNetworkCodes.has(driverCode)
    ? driverCode
    : typeof cause?.message === 'string' && internalCodes.has(cause.message)
      ? cause.message
      : 'UNKNOWN';
  const names = new Set(['Error', 'TypeError', 'RangeError', 'DatabaseError', 'AggregateError', 'AccessDeniedException', 'InvalidRequestException']);
  const errorClass = names.has(cause?.name) ? cause.name : 'Other';
  return { status: 'FAIL', stage: phases.has(phase) ? phase : 'reader-provision', code, errorClass };
}
function trustedRdsCa() {
  try {
    const pem = gunzipSync(Buffer.from(process.env.VAY2017_RDS_CA_BUNDLE_GZIP ?? '', 'base64')).toString('utf8');
    if (new X509Certificate(pem).fingerprint256 !== rdsCaFingerprint) throw new Error();
    return pem;
  } catch {
    throw new Error('database_ca_invalid');
  }
}
function assertConfiguration() {
  const required = [
    'VAY2017_DB_HOST', 'VAY2017_DB_PORT', 'VAY2017_DB_USER', 'VAY2017_DB_PASSWORD',
    'VAY2017_READER_SECRET_ARN', 'VAY2017_RESTORE_INSTANCE_ID', 'VAY2017_SOURCE_SNAPSHOT_ID',
    'VAY2017_RESTORE_RESOURCE_ID', 'VAY2017_RESTORE_INSTANCE_ARN', 'VAY2017_RESTORE_ATTESTATION_CHECKSUM',
  ];
  if (required.some((name) => !process.env[name])) throw new Error('restore_identity_invalid');
  const secretPrefix = 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2017/metadata-reader/vay2017-metadata-rehearsal-isolated-20260923-';
  if (
    process.env.VAY2017_RESTORE_INSTANCE_ID !== restoreId ||
    process.env.VAY2017_SOURCE_SNAPSHOT_ID !== snapshotId ||
    !/^db-[A-Z0-9]+$/.test(process.env.VAY2017_RESTORE_RESOURCE_ID) ||
    process.env.VAY2017_RESTORE_INSTANCE_ARN !== `arn:aws:rds:eu-west-1:269416271598:db:${restoreId}` ||
    !/^[a-f0-9]{64}$/.test(process.env.VAY2017_RESTORE_ATTESTATION_CHECKSUM) ||
    !process.env.VAY2017_READER_SECRET_ARN.startsWith(secretPrefix)
  ) {
    throw new Error('restore_identity_invalid');
  }
  return trustedRdsCa();
}
function adminClient(database, ca) {
  return new Client({
    host: process.env.VAY2017_DB_HOST,
    port: Number(process.env.VAY2017_DB_PORT),
    database,
    user: process.env.VAY2017_DB_USER,
    password: process.env.VAY2017_DB_PASSWORD,
    ssl: {
      ca,
      rejectUnauthorized: true,
      servername: process.env.VAY2017_DB_HOST,
    },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'vay2017-metadata-bootstrap-v1',
  });
}
function safeIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
async function inventoryDatabases(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const address = await client.query('SELECT inet_server_addr()::text AS address');
    if (!/^10\.230\.0\./.test(address.rows[0]?.address ?? '')) throw new Error('database_endpoint_invalid');
    const result = await client.query(`
      SELECT datname AS database_name
      FROM pg_catalog.pg_database
      WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin'
      ORDER BY datname
    `);
    await client.query('COMMIT');
    return result.rows.map((row) => row.database_name);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
async function inventoryTemplateDatabases(client) {
  const result = await client.query(`
    SELECT datname AS database_name
    FROM pg_catalog.pg_database
    WHERE datallowconn AND datistemplate AND datname <> 'template0'
    ORDER BY datname
  `);
  return result.rows.map((row) => row.database_name);
}
async function readerPrivilegeCheck(client) {
  const result = await client.query(`
    -- PG16+ adds this exact immutable admin-only membership when the CREATEROLE user creates a role.
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS m
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = m.member
      JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = m.roleid
      WHERE (member_role.rolname = $1 OR granted_role.rolname = $1)
        AND NOT (
          granted_role.rolname = $1 AND member_role.rolname = CURRENT_USER
          AND m.grantor = 10::oid AND m.admin_option
          AND NOT m.set_option AND NOT m.inherit_option
        )
    ) AS has_memberships,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS r
      WHERE r.rolname = $1 AND (
        r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR
        NOT r.rolcanlogin OR r.rolinherit OR r.rolconnlimit <> 2
      )
    ) AS has_unsafe_role_attributes,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_shdepend
      WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND refobjid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        AND deptype = 'o'
    ) AS owns_objects,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_database AS d
      WHERE pg_catalog.has_database_privilege($1, d.oid, 'CREATE')
    ) AS can_create_database,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_database AS d
      WHERE d.datallowconn AND NOT d.datistemplate
        AND pg_catalog.has_database_privilege($1, d.oid, 'TEMP')
    ) AS can_create_temp_objects,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_database AS d
      WHERE d.datistemplate AND d.datallowconn AND d.datname <> 'template0'
        AND pg_catalog.has_database_privilege($1, d.oid, 'CONNECT')
    ) AS can_connect_template_database,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND (
          pg_catalog.has_table_privilege($1, c.oid, 'SELECT') OR
          pg_catalog.has_any_column_privilege($1, c.oid, 'SELECT') OR
          pg_catalog.has_table_privilege($1, c.oid, 'INSERT') OR
          pg_catalog.has_table_privilege($1, c.oid, 'UPDATE') OR
          pg_catalog.has_table_privilege($1, c.oid, 'DELETE') OR
          pg_catalog.has_table_privilege($1, c.oid, 'TRUNCATE') OR
          pg_catalog.has_table_privilege($1, c.oid, 'REFERENCES') OR
          pg_catalog.has_table_privilege($1, c.oid, 'TRIGGER') OR
          pg_catalog.has_any_column_privilege($1, c.oid, 'INSERT') OR
          pg_catalog.has_any_column_privilege($1, c.oid, 'UPDATE') OR
          pg_catalog.has_any_column_privilege($1, c.oid, 'REFERENCES')
        )
    ) AS has_application_relation_privileges,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace AS n
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND pg_catalog.has_schema_privilege($1, n.oid, 'CREATE')
    ) AS can_create_schema,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname <> 'information_schema'
        AND n.nspname !~ '^pg_'
        AND (
          pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE') OR
          pg_catalog.has_sequence_privilege($1, c.oid, 'SELECT') OR
          pg_catalog.has_sequence_privilege($1, c.oid, 'UPDATE')
        )
    ) AS can_use_sequence,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND p.prokind IN ('f', 'p')
        AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND NOT (
          n.nspname = '${helperSchema}' AND p.proname = '${helperFunction}' AND p.prokind = 'f'
          AND p.pronargs = 2
          AND p.proargtypes[0] = 'pg_catalog.text'::pg_catalog.regtype::oid
          AND p.proargtypes[1] = 'pg_catalog.text'::pg_catalog.regtype::oid
          AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER)
        )
        AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
    ) AS can_execute_other_definer_routine,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname <> 'information_schema'
        AND n.nspname !~ '^pg_'
        AND NOT pg_catalog.has_table_privilege(CURRENT_USER, c.oid, 'SELECT')
    ) AS function_owner_lacks_select
  `, [reader]);
  const checks = result.rows[0];
  if (checks.function_owner_lacks_select) throw new Error('function_owner_lacks_select');
  if (Object.entries(checks).some(([name, value]) => name !== 'function_owner_lacks_select' && value)) {
    throw new Error('reader_privilege_check_failed');
  }
}
async function provisionRole(client, passwordVerifier, exists) {
  const verb = exists ? 'ALTER ROLE' : 'CREATE ROLE';
  const command = await client.query(
    `SELECT pg_catalog.format('${verb} %I LOGIN PASSWORD %L NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2', $1, $2) AS sql`,
    [reader, passwordVerifier],
  );
  await client.query(command.rows[0].sql);
}

async function hardenDatabaseDefaults(client, databaseName, roleExists) {
  const additionalGrantee = roleExists ? `, ${safeIdentifier(reader)}` : '';
  await client.query('BEGIN');
  try {
    await client.query(`REVOKE TEMPORARY ON DATABASE ${safeIdentifier(databaseName)} FROM PUBLIC`);
    await client.query(`
      DO $metadata$
      DECLARE routine record;
      BEGIN
        FOR routine IN
          SELECT n.nspname, p.proname, p.prokind,
                 pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments
          FROM pg_catalog.pg_proc AS p
          JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND p.prokind IN ('f', 'p')
            AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
            AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER)
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE EXECUTE ON %s %I.%I(%s) FROM PUBLIC${additionalGrantee}',
            CASE routine.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
            routine.nspname, routine.proname, routine.identity_arguments
          );
        END LOOP;
      END;
      $metadata$
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function denyTemplateDatabaseAccess(client, templateDatabases, roleExists) {
  for (const databaseName of templateDatabases) {
    await client.query(`REVOKE CONNECT ON DATABASE ${safeIdentifier(databaseName)} FROM PUBLIC`);
    if (roleExists) {
      await client.query(`REVOKE CONNECT ON DATABASE ${safeIdentifier(databaseName)} FROM ${safeIdentifier(reader)}`);
    }
  }
}

async function provisionDatabase(client, databaseName) {
  await client.query('BEGIN');
  try {
    await client.query(`GRANT CONNECT ON DATABASE ${safeIdentifier(databaseName)} TO ${safeIdentifier(reader)}`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${safeIdentifier(helperSchema)} AUTHORIZATION CURRENT_USER`);
    await client.query(`REVOKE ALL ON SCHEMA ${safeIdentifier(helperSchema)} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA ${safeIdentifier(helperSchema)} FROM ${safeIdentifier(reader)}`);
    await client.query(`
      CREATE OR REPLACE FUNCTION ${safeIdentifier(helperSchema)}.${safeIdentifier(helperFunction)}(p_schema text, p_table text)
      RETURNS text
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      SET row_security = off
      AS $metadata$
      DECLARE result text;
      BEGIN
        IF p_schema IS NULL OR p_table IS NULL OR p_schema = 'information_schema' OR p_schema ~ '^pg_' OR p_schema = '${helperSchema}' THEN
          RAISE EXCEPTION 'unsupported_metadata_relation' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS c
          JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = p_schema AND c.relname = p_table AND c.relkind IN ('r', 'p')
        ) THEN
          RAISE EXCEPTION 'unsupported_metadata_relation' USING ERRCODE = '22023';
        END IF;
        EXECUTE pg_catalog.format('SELECT count(*)::text FROM %I.%I', p_schema, p_table) INTO result;
        RETURN result;
      END;
      $metadata$
    `);
    await client.query(`REVOKE ALL ON FUNCTION ${safeIdentifier(helperSchema)}.${safeIdentifier(helperFunction)}(text, text) FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA ${safeIdentifier(helperSchema)} TO ${safeIdentifier(reader)}`);
    await client.query(`GRANT EXECUTE ON FUNCTION ${safeIdentifier(helperSchema)}.${safeIdentifier(helperFunction)}(text, text) TO ${safeIdentifier(reader)}`);

    await readerPrivilegeCheck(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  let phase = 'configuration';
  const clients = [];
  try {
    const ca = assertConfiguration();
    const password = randomBytes(36).toString('base64url');
    const passwordVerifier = scramVerifier(password);
    phase = 'database-connect';
    const discoveryClient = adminClient('postgres', ca);
    clients.push(discoveryClient);
    await discoveryClient.connect();
    const databaseClients = new Map([['postgres', discoveryClient]]);
    phase = 'database-discovery';
    const databases = await inventoryDatabases(discoveryClient);
    const templateDatabases = await inventoryTemplateDatabases(discoveryClient);
    phase = 'reader-provision';
    const existingRole = await discoveryClient.query(
      'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [reader],
    );
    for (const databaseName of databases) {
      let client = discoveryClient;
      if (databaseName !== 'postgres') {
        client = adminClient(databaseName, ca);
        clients.push(client);
        await client.connect();
        databaseClients.set(databaseName, client);
      }
      await hardenDatabaseDefaults(client, databaseName, existingRole.rowCount > 0);
    }
    await denyTemplateDatabaseAccess(discoveryClient, templateDatabases, existingRole.rowCount > 0);
    if (existingRole.rowCount > 0) {
      for (const databaseName of databases) {
        await readerPrivilegeCheck(databaseClients.get(databaseName));
      }
    }
    await provisionRole(discoveryClient, passwordVerifier, existingRole.rowCount > 0);
    for (const databaseName of databases) {
      await provisionDatabase(databaseClients.get(databaseName), databaseName);
    }
    phase = 'reader-secret';
    const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });
    await secrets.send(new PutSecretValueCommand({
      SecretId: process.env.VAY2017_READER_SECRET_ARN,
      ClientRequestToken: randomUUID(),
      SecretString: JSON.stringify({ username: reader, password }),
    }));
    console.log(JSON.stringify({ status: 'OK', stage: 'complete' }));
  } catch (error) {
    console.error(JSON.stringify(safeFailure(phase, error)));
    process.exitCode = 1;
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
  }
}

if (process.env.VAY2017_RUN_MAIN === '1') await main();
