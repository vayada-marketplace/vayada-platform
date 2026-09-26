import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { configuration } from './launch-vay2042-source-reader.mjs';
import { privilegeSql, reader } from './provision-vay2042-source-reader.mjs';
import { target, writer, attestor } from './provision-vay2042-target.mjs';

const requireTrue = (condition, code) => { if (!condition) throw new Error(code); };
const initialExpiry = new Map([
  [reader, ['2026-09-26T13:22:00Z', '2026-09-26T13:23:15Z']],
  [writer, ['2026-09-26T13:33:58Z', '2026-09-26T13:34:59Z']],
]);
const expectedDatabases = [...manifest.databases, target].sort();
const expectedSettings = [
  'default_transaction_read_only=on',
  'idle_in_transaction_session_timeout=60s',
  'statement_timeout=60s',
].sort();
const credentials = [
  { arn: 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925-4kTuiw',
    name: 'vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925',
    version: '91d7b931-e78e-419f-8a9f-b1aeb9c259ba' },
  { arn: 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925-mfr57v',
    name: 'vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925',
    version: '220507a8-4ac8-4bab-bd57-221862dd2dcc' },
];

export function checkSecretMetadata(metadata, expected) {
  const versions = metadata?.VersionIdsToStages ?? {};
  requireTrue(metadata?.ARN === expected.arn && metadata?.Name === expected.name &&
    !metadata.DeletedDate && Object.keys(versions).length === 1 &&
    JSON.stringify(versions[expected.version]) === JSON.stringify(['AWSCURRENT']),
  'credential_version_changed');
}

export function checkRole(row, name, now) {
  const window = initialExpiry.get(name);
  const expiry = new Date(row?.rolvaliduntil).getTime();
  requireTrue(row?.rolname === name && row.rolcanlogin === true && row.rolconnlimit === 4 &&
    [row.rolsuper, row.rolcreatedb, row.rolcreaterole, row.rolinherit,
      row.rolreplication, row.rolbypassrls].every((value) => value === false) &&
    Number.isFinite(expiry) && expiry >= Date.parse(window[0]) &&
    expiry <= Date.parse(window[1]) && expiry < now,
  'role_identity_or_expiry_mismatch');
}

async function checkPrivileges(client, name, tables, ignored = []) {
  const result = await client.query(privilegeSql, [name, tables]);
  requireTrue(result.rowCount === 1 && Object.entries(result.rows[0]).every(
    ([key, value]) => value === (key === 'attributes' || ignored.includes(key))),
  'role_privilege_mismatch');
}

async function checkOldDatabase(client, database) {
  const source = manifest.sources.find((entry) => entry.database === database);
  if (source) {
    const tables = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((row) => row.name);
    requireTrue(JSON.stringify(tables) === JSON.stringify(source.tables), 'source_table_inventory_changed');
  }
  await checkPrivileges(client, reader, source?.tables ?? []);
  await checkPrivileges(client, writer, [], ['database_write']);
  const defaults = await client.query(`SELECT count(*)::int AS grants FROM pg_default_acl d,
    LATERAL aclexplode(d.defaclacl) a
    WHERE a.grantee = 0 OR a.grantee IN
      (SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[]))`, [[reader, writer]]);
  requireTrue(defaults.rows[0]?.grants === 0, 'old_database_default_acl_mismatch');
  const boundary = await client.query(`SELECT NOT has_database_privilege($1, current_database(), 'CREATE')
    AND NOT has_database_privilege($1, current_database(), 'TEMP') AS writer_denied`, [writer]);
  requireTrue(boundary.rows[0]?.writer_denied === true, 'old_database_writer_privilege_mismatch');
}

async function checkTarget(client, admin = true) {
  const schemas = (await client.query(`SELECT nspname AS name FROM pg_namespace
    WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' ORDER BY 1`)).rows.map((row) => row.name);
  requireTrue(JSON.stringify(schemas) === JSON.stringify(['public', 'vayada_migration_evidence']),
    'target_not_clean');
  const relations = (await client.query(`SELECT n.nspname || '.' || c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' ORDER BY 1`)).rows.map((row) => row.name);
  requireTrue(JSON.stringify(relations) === JSON.stringify([
    'vayada_migration_evidence.database_attestations',
    'vayada_migration_evidence.database_attestations_pkey',
  ]), 'target_not_clean');
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='vayada_migration_evidence' AND c.relname='database_attestations'
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
  requireTrue(JSON.stringify(columns) === JSON.stringify([
    { name: 'attestation_key', type: 'text', required: true, default_value: null },
    { name: 'attestation_value', type: 'text', required: true, default_value: null },
    { name: 'attested_at', type: 'timestamp with time zone', required: true, default_value: 'now()' },
  ]), 'target_evidence_shape_mismatch');
  const constraints = (await client.query(`SELECT conname AS name, contype AS type,
    conkey::text AS columns, convalidated AS valid, condeferrable AS deferrable
    FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='vayada_migration_evidence' AND c.relname='database_attestations'`)).rows;
  requireTrue(JSON.stringify(constraints) === JSON.stringify([
    { name: 'database_attestations_pkey', type: 'p', columns: '{1}', valid: true, deferrable: false },
  ]), 'target_evidence_shape_mismatch');
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
  requireTrue(['routines', 'defaults', 'types', 'operators', 'event_triggers', 'triggers',
    'policies', 'extensions'].every((key) => objects.rows[0]?.[key] === 0), 'target_not_clean');
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
    requireTrue(owner.rowCount === 1 && Object.values(owner.rows[0]).every((value) => value === true),
      'target_attestor_mismatch');
    await client.query('BEGIN READ ONLY');
  }
  try {
    if (admin) await client.query(`SET LOCAL ROLE "${attestor}"`);
    await checkPrivileges(client, reader, []);
    await checkPrivileges(client, writer, ['vayada_migration_evidence.database_attestations'],
      ['database_write', 'schema_write']);
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
    requireTrue(boundary.rows[0]?.source_denied === true && boundary.rows[0]?.writer_boundary === true,
      'target_privilege_mismatch');
    const evidence = await client.query('SELECT count(*)::int AS rows FROM vayada_migration_evidence.database_attestations');
    requireTrue(evidence.rows[0]?.rows === 0, 'target_not_clean');
  } finally { if (admin) await client.query('ROLLBACK'); }
}

export async function runPreflight({ connect, checkCredentials = async () => {}, now = () => Date.now() }) {
  const control = await connect('postgres', 'admin');
  let locked = false;
  let committed = false;
  let commitAttempted = false;
  try {
    locked = (await control.query('SELECT pg_try_advisory_lock(204220260925) AS locked')).rows[0]?.locked === true;
    requireTrue(locked, 'preflight_busy');
    const databases = (await control.query(`SELECT datname FROM pg_database
      WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin' ORDER BY datname`))
      .rows.map((row) => row.datname);
    requireTrue(JSON.stringify(databases) === JSON.stringify(expectedDatabases), 'database_inventory_mismatch');
    const roles = (await control.query(`SELECT rolname,rolcanlogin,rolconnlimit,rolsuper,rolcreatedb,
      rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolvaliduntil
      FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [[reader, writer]])).rows;
    requireTrue(roles.length === 2, 'role_identity_or_expiry_mismatch');
    for (const name of [reader, writer]) checkRole(roles.find((role) => role.rolname === name), name, now());
    const settings = (await control.query(`SELECT r.rolname,s.setdatabase = 0 AS global,s.setconfig FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname = ANY($1::text[])`, [[reader, writer]])).rows;
    requireTrue(settings.length === 1 && settings[0].rolname === reader && settings[0].global === true &&
      JSON.stringify([...settings[0].setconfig].sort()) === JSON.stringify(expectedSettings),
    'role_settings_mismatch');
    for (const database of manifest.databases) {
      const client = database === 'postgres' ? control : await connect(database, 'admin');
      try { await checkOldDatabase(client, database); }
      finally { if (client !== control) await client.end(); }
    }
    const fresh = await connect(target, 'admin');
    try { await checkTarget(fresh); }
    finally { await fresh.end(); }
    await checkCredentials();
    const expiry = new Date(now() + 86_400_000).toISOString();
    await control.query('BEGIN');
    try {
      for (const name of [reader, writer]) {
        const sql = (await control.query(`SELECT format('ALTER ROLE %I VALID UNTIL %L', $1::text,$2::text) AS sql`,
          [name, expiry])).rows[0].sql;
        await control.query(sql);
      }
      commitAttempted = true;
      await control.query('COMMIT');
      committed = true;
    } catch (error) { await control.query('ROLLBACK').catch(() => {}); throw error; }
    for (const { database } of manifest.sources) {
      const client = await connect(database, 'source');
      try {
        await client.query('BEGIN READ ONLY');
        try { await checkPrivileges(client, reader, manifest.sources.find((s) => s.database === database).tables); }
        finally { await client.query('ROLLBACK'); }
      } finally { await client.end(); }
    }
    const writerClient = await connect(target, 'writer');
    try {
      await writerClient.query('BEGIN READ ONLY');
      try { await checkTarget(writerClient, false); }
      finally { await writerClient.query('ROLLBACK'); }
    } finally { await writerClient.end(); }
    return { status: 'OK', stage: 'complete', scope: 'isolated-catalog-preflight',
      databases: 10, tables: 83, bound: false, expiresAt: expiry };
  } catch (error) {
    if (committed || commitAttempted) throw new Error('renewal_committed_requires_inspection');
    throw error;
  } finally {
    if (locked) await control.query('SELECT pg_advisory_unlock(204220260925)').catch(() => {});
    await control.end().catch(() => {});
  }
}

const stages = new Set(['configuration', 'database-connect', 'preflight', 'credential-version']);
const codes = new Set([
  'configuration_invalid', 'database_ca_invalid', 'database_endpoint_invalid', 'preflight_busy',
  'credential_version_changed',
  'database_inventory_mismatch', 'role_identity_or_expiry_mismatch', 'role_settings_mismatch',
  'source_table_inventory_changed', 'role_privilege_mismatch', 'target_not_clean',
  'old_database_default_acl_mismatch', 'old_database_writer_privilege_mismatch',
  'target_evidence_shape_mismatch',
  'target_privilege_mismatch', 'target_attestor_mismatch', 'renewal_committed_requires_inspection',
  '42501', '28P01', '3D000', '25006', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const classes = new Set(['Error', 'TypeError', 'DatabaseError', 'AggregateError']);
const safeFailure = (stage, error) => ({ status: 'FAIL', stage: stages.has(stage) ? stage : 'preflight',
  code: codes.has(error?.code) ? error.code : codes.has(error?.message) ? error.message : 'UNKNOWN',
  errorClass: classes.has(error?.name) ? error.name : 'Other' });

export async function launch(env, { Client, SecretsManagerClient, DescribeSecretCommand }) {
  let stage = 'configuration';
  try {
    const { host, ca } = configuration(env);
    requireTrue(env.VAY2042_PRECHECK_MAIN === '1' &&
      env.VAY2042_READER_SECRET_ARN === credentials[0].arn &&
      env.VAY2042_SOURCE_USER === reader &&
      env.VAY2042_SOURCE_PASSWORD && env.VAY2042_TARGET_USER === writer &&
      env.VAY2042_TARGET_PASSWORD && env.VAY2042_TARGET_SECRET_ARN === credentials[1].arn,
    'configuration_invalid');
    stage = 'database-connect';
    const connect = async (database, identity) => {
      requireTrue(expectedDatabases.includes(database) &&
        (identity === 'admin' || identity === 'source' && manifest.sources.some((s) => s.database === database) ||
          identity === 'writer' && database === target),
        'configuration_invalid');
      const credentials = identity === 'admin'
        ? [env.VAY2042_DB_USER, env.VAY2042_DB_PASSWORD]
        : identity === 'source'
          ? [env.VAY2042_SOURCE_USER, env.VAY2042_SOURCE_PASSWORD]
          : [env.VAY2042_TARGET_USER, env.VAY2042_TARGET_PASSWORD];
      const client = new Client({ host, port: 5432, database, user: credentials[0], password: credentials[1],
        ssl: { ca, rejectUnauthorized: true, servername: host }, connectionTimeoutMillis: 10_000,
        statement_timeout: 60_000, application_name: 'vay2042-private-preflight-v1' });
      client.on('error', () => {});
      try {
        await client.connect();
        const result = await client.query(`SELECT current_database() AS database,session_user AS login,
          host(inet_server_addr()) AS address,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl`);
        requireTrue(result.rows[0]?.database === database && result.rows[0]?.login === credentials[0] &&
          result.rows[0]?.ssl === true && /^10\.230\.0\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(result.rows[0]?.address),
        'database_endpoint_invalid');
        stage = 'preflight';
        return client;
      } catch (error) { await client.end().catch(() => {}); throw error; }
    };
    return await runPreflight({ connect, checkCredentials: async () => {
      stage = 'credential-version';
      const secrets = new SecretsManagerClient({ region: 'eu-west-1',
        endpoint: 'https://secretsmanager.eu-west-1.amazonaws.com' });
      try {
        for (const expected of credentials) {
          const metadata = await secrets.send(new DescribeSecretCommand({ SecretId: expected.arn }));
          checkSecretMetadata(metadata, expected);
        }
      } finally { secrets.destroy(); }
      stage = 'preflight';
    } });
  } catch (error) { return safeFailure(stage, error); }
}

if (process.env.VAY2042_PRECHECK_MAIN === '1') {
  let result;
  try {
    const [{ default: pg }, sdk] = await Promise.all([
      import('pg'), import('@aws-sdk/client-secrets-manager')]);
    result = await launch(process.env, { Client: pg.Client, ...sdk });
  } catch (error) { result = safeFailure('configuration', error); }
  console.log(JSON.stringify(result));
  if (result.status !== 'OK') process.exitCode = 1;
}
