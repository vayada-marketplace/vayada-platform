import { createHash, X509Certificate } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };

const sourceId = 'vay2017-metadata-rehearsal-isolated-20260923';
const sourceResource = 'db-BB7GOFQ3BQTLTBG444I2Q75X6Y';
const controlId = 'vay2042-preservation-control-20260927';
const controlResource = 'db-KWO2HSCRBXNV75OK7LNIBZN7TQ';
const controlRestoreEvent = '7781e4d4-0024-4baa-85ea-0ec293175d8b';
const snapshot = 'vay2017-legacy-source-freeze-20260920';
const sourceUser = 'vay2042_source_reader_20260925';
const caFingerprint = '6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86';
const queryVersion = 'source-preservation-jsonb-v1';
const sourceProofSha256 = 'acf9fb92b78057919ea92b947533fe458fdc1efc40d54db232e45b19933e0eda';
const evidenceTable = 'vayada_migration_evidence.database_attestations';
const requireTrue = (condition, code) => { if (!condition) throw new Error(code); };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const relation = (name) => {
  requireTrue(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name), 'manifest_invalid');
  return name.split('.').map((part) => `"${part}"`).join('.');
};

export function configuration(env) {
  requireTrue(env.AWS_REGION === 'eu-west-1' && env.VAY2042_COMPARE_MAIN === '1' &&
    env.VAY2042_SOURCE_ID === sourceId && env.VAY2042_SOURCE_RESOURCE === sourceResource &&
    env.VAY2042_CONTROL_ID === controlId && env.VAY2042_CONTROL_RESOURCE === controlResource &&
    env.VAY2042_CONTROL_RESTORE_EVENT === controlRestoreEvent &&
    env.VAY2042_SNAPSHOT_ID === snapshot && env.VAY2042_SOURCE_USER === sourceUser &&
    env.VAY2042_CONTROL_USER === 'vayada_admin' && env.VAY2042_SOURCE_PASSWORD &&
    env.VAY2042_CONTROL_PASSWORD && manifest.restoreResourceId === sourceResource &&
    manifest.sourceSnapshotId === snapshot && manifest.sources.length === 4 &&
    manifest.sources.reduce((n, source) => n + source.tables.length, 0) === 83,
  'configuration_invalid');
  for (const [id, host] of [[sourceId, env.VAY2042_SOURCE_HOST], [controlId, env.VAY2042_CONTROL_HOST]]) {
    requireTrue(typeof host === 'string' && host.startsWith(`${id}.`) &&
      /^[a-z0-9]+\.eu-west-1\.rds\.amazonaws\.com$/.test(host.slice(id.length + 1)),
    'configuration_invalid');
  }
  let ca;
  try {
    ca = gunzipSync(Buffer.from(env.VAY2042_RDS_CA_BUNDLE_GZIP ?? '', 'base64'),
      { maxOutputLength: 16_384 }).toString('utf8');
    requireTrue(new X509Certificate(ca).fingerprint256 === caFingerprint, 'database_ca_invalid');
  } catch { throw new Error('database_ca_invalid'); }
  return { ca };
}

export async function checksumTable(client, table) {
  const name = relation(table);
  await client.query(`DECLARE vay2042_rows NO SCROLL CURSOR FOR
    SELECT to_jsonb(t)::text AS row_json FROM ${name} AS t ORDER BY to_jsonb(t)::text`);
  const digest = createHash('sha256');
  let count = 0;
  try {
    while (true) {
      const rows = (await client.query('FETCH FORWARD 500 FROM vay2042_rows')).rows;
      if (rows.length === 0) break;
      for (const row of rows) {
        requireTrue(typeof row.row_json === 'string', 'row_invalid');
        digest.update(`${sha256(row.row_json)}\n`);
        count += 1;
      }
    }
  } finally {
    await client.query('CLOSE vay2042_rows').catch(() => {});
  }
  return { count, sha256: digest.digest('hex') };
}

async function checkConnection(client, database, user) {
  if (user === sourceUser) {
    requireTrue((await client.query('SHOW default_transaction_read_only')).rows[0]
      ?.default_transaction_read_only === 'on', 'source_privilege_mismatch');
  } else {
    await client.query('SET default_transaction_read_only=on');
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const identity = (await client.query(`SELECT host(inet_server_addr()) AS address,
    current_database() AS database, current_user AS username, session_user AS session_username,
    current_setting('transaction_read_only') AS read_only`)).rows;
  requireTrue(identity.length === 1 && identity[0].database === database &&
    identity[0].username === user && identity[0].session_username === user &&
    identity[0].read_only === 'on' && /^10\.230\.0\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(identity[0].address),
  'database_identity_invalid');
}

async function checkInventory(client, expected, source = false) {
  const tables = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname <> 'vay2017_metadata'
      AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p') ORDER BY 1`))
    .rows.map((row) => row.name);
  const bound = source && tables.includes(evidenceTable);
  requireTrue(JSON.stringify(tables) === JSON.stringify(
    [...expected, ...(bound ? [evidenceTable] : [])].sort()), 'table_inventory_mismatch');
  if (bound) {
    const rows = (await client.query(`SELECT attestation_key,attestation_value
      FROM ${evidenceTable} ORDER BY attestation_key`)).rows;
    requireTrue(JSON.stringify(rows) === JSON.stringify([
      { attestation_key: 'vayada.cutover_freeze_proof_sha256', attestation_value: sourceProofSha256 },
      { attestation_key: 'vayada.source_snapshot_identifier',
        attestation_value: 'arn:aws:rds:eu-west-1:269416271598:snapshot:vay2017-legacy-source-freeze-20260920' },
    ]), 'source_attestation_mismatch');
  }
  return bound;
}

async function checkSourcePrivileges(client, expected, bound) {
  const role = (await client.query(`SELECT rolname, rolcanlogin, rolconnlimit, rolsuper,
    rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolvaliduntil
    FROM pg_roles WHERE rolname=$1`, [sourceUser])).rows;
  requireTrue(role.length === 1 && role[0].rolname === sourceUser && role[0].rolcanlogin === true &&
    role[0].rolconnlimit === 4 &&
    [role[0].rolsuper, role[0].rolcreatedb, role[0].rolcreaterole, role[0].rolinherit,
      role[0].rolreplication, role[0].rolbypassrls].every((value) => value === false) &&
    new Date(role[0].rolvaliduntil).getTime() > Date.now() + 7_200_000,
  'source_privilege_mismatch');
  const { privilegeSql } = await import('./provision-vay2042-source-reader.mjs');
  const result = await client.query(privilegeSql, [sourceUser,
    [...expected, ...(bound ? [evidenceTable] : [])]]);
  requireTrue(result.rowCount === 1 && Object.entries(result.rows[0]).every(
    ([key, value]) => value === (key === 'attributes')),
  'source_privilege_mismatch');
}

export async function compare({ connect }) {
  const tables = [];
  for (const source of manifest.sources) {
    const database = source.database;
    const control = await connect('control', database);
    const expected = [];
    try {
      await checkConnection(control, database, 'vayada_admin');
      await checkInventory(control, source.tables);
      for (const table of source.tables) {
        expected.push({ database, table, ...await checksumTable(control, table) });
      }
      await control.query('COMMIT');
    } catch (error) {
      await control.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await control.end().catch(() => {});
    }
    const current = await connect('source', database);
    try {
      await checkConnection(current, database, sourceUser);
      const bound = await checkInventory(current, source.tables, true);
      await checkSourcePrivileges(current, source.tables, bound);
      for (const original of expected) {
        const restored = await checksumTable(current, original.table);
        requireTrue(original.count === restored.count && original.sha256 === restored.sha256,
          'source_rows_mismatch');
        tables.push({ database, table: original.table, count: original.count, sha256: original.sha256 });
      }
      await current.query('COMMIT');
    } catch (error) {
      await current.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await current.end().catch(() => {});
    }
  }
  requireTrue(tables.length === 83, 'table_inventory_mismatch');
  const evidence = { queryVersion, snapshot, sourceId, sourceResource,
    controlId, controlResource, controlRestoreEvent, tables };
  return { status: 'OK', scope: 'isolated-source-preservation',
    databases: 4, tables: 83, rows: tables.reduce((n, row) => n + row.count, 0),
    evidenceSha256: sha256(JSON.stringify(evidence)), evidence };
}

if (process.env.VAY2042_COMPARE_MAIN === '1') {
  let stage = 'configuration';
  try {
    const { ca } = configuration(process.env);
    const { default: pg } = await import('pg');
    stage = 'comparison';
    const report = await compare({ connect: async (kind, database) => {
      const host = process.env[kind === 'source' ? 'VAY2042_SOURCE_HOST' : 'VAY2042_CONTROL_HOST'];
      const user = process.env[kind === 'source' ? 'VAY2042_SOURCE_USER' : 'VAY2042_CONTROL_USER'];
      const password = process.env[kind === 'source' ? 'VAY2042_SOURCE_PASSWORD' : 'VAY2042_CONTROL_PASSWORD'];
      const client = new pg.Client({ host, port: 5432, database, user, password,
        ssl: { ca, rejectUnauthorized: true, servername: host },
        connectionTimeoutMillis: 10_000, statement_timeout: 900_000,
        application_name: 'vay2042-source-preservation-v1' });
      client.on('error', () => {});
      try { await client.connect(); }
      catch (error) { await client.end().catch(() => {}); throw error; }
      return client;
    } });
    console.log(JSON.stringify(report));
  } catch (error) {
    const codes = new Set(['configuration_invalid', 'database_ca_invalid',
      'manifest_invalid', 'database_identity_invalid', 'table_inventory_mismatch',
      'row_invalid', 'source_rows_mismatch', 'source_privilege_mismatch',
      'source_attestation_mismatch']);
    console.error(JSON.stringify({ status: 'FAIL', scope: 'isolated-source-preservation',
      stage, code: codes.has(error?.message) ? error.message : 'comparison_failed' }));
    process.exitCode = 1;
  }
}
