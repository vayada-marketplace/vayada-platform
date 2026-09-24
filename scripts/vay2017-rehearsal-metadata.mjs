import { createHash, X509Certificate } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const QUERY_VERSION = 'v2';

export const DATABASES_SQL = `
SELECT datname AS database_name
FROM pg_catalog.pg_database
WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin'
ORDER BY datname
`;

export const SCHEMAS_SQL = `
SELECT nspname AS schema_name
FROM pg_catalog.pg_namespace
WHERE nspname <> 'information_schema'
  AND nspname <> 'vay2017_metadata'
  AND nspname !~ '^pg_'
ORDER BY nspname
`;

// This query reads structural catalogs only. Exact counts come from a fixed
// definer function that exposes aggregates without granting table SELECT.
export const INVENTORY_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  a.attnum AS column_ordinal,
  a.attname AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
  a.attnotnull AS not_null,
  (pk.column_ordinal IS NOT NULL) AS primary_key,
  pk.column_ordinal AS primary_key_ordinal
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attribute AS a
  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN LATERAL (
  SELECT key_column.ordinality::integer AS column_ordinal
  FROM pg_catalog.pg_index AS i
  JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true
  WHERE i.indrelid = c.oid AND i.indisprimary AND key_column.attnum = a.attnum
) AS pk ON true
WHERE c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname <> 'vay2017_metadata'
  AND n.nspname !~ '^pg_'
ORDER BY n.nspname, c.relname, a.attnum
`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const rowCountSql = () => (
  'SELECT vay2017_metadata.count_table_rows($1, $2) AS row_count'
);

const INTERNAL_ERROR_CODES = new Set([
  'read_only_transaction_required',
  'restore_identity_invalid',
  'snapshot_identity_invalid',
  'restore_resource_identity_invalid',
  'image_digest_invalid',
  'scanner_source_checksum_invalid',
  'restore_attestation_checksum_invalid',
  'row_count_invalid',
  'unsupported_metadata_relation',
  'database_ca_invalid',
]);
const RDS_CA_FINGERPRINT = '6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86';

const NODE_CONNECTION_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'DatabaseError', 'AggregateError']);
const SAFE_PHASES = new Set(['database-connect', 'database-discovery', 'schema-inventory', 'row-count']);

function trustedRdsCa() {
  try {
    const pem = gunzipSync(Buffer.from(process.env.VAY2017_RDS_CA_BUNDLE_GZIP ?? '', 'base64')).toString('utf8');
    if (new X509Certificate(pem).fingerprint256 !== RDS_CA_FINGERPRINT) throw new Error();
    return pem;
  } catch {
    throw new Error('database_ca_invalid');
  }
}

async function beginReadOnly(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const mode = await client.query('SHOW transaction_read_only');
  if (mode.rows?.[0]?.transaction_read_only !== 'on') {
    throw new Error('read_only_transaction_required');
  }
}

async function rollbackQuietly(client) {
  await client.query('ROLLBACK').catch(() => {});
}

async function inPhase(phase, operation) {
  try {
    return await operation();
  } catch (cause) {
    const error = new Error('metadata_read_failed', { cause });
    error.metadataPhase = phase;
    throw error;
  }
}

export function sanitizeError(error) {
  const cause = error?.cause ?? error;
  const driverCode = typeof cause?.code === 'string' ? cause.code : '';
  const code = /^[A-Z0-9]{5}$/.test(driverCode) || NODE_CONNECTION_ERROR_CODES.has(driverCode)
    ? driverCode
    : typeof cause?.message === 'string' && INTERNAL_ERROR_CODES.has(cause.message)
      ? cause.message
      : 'UNKNOWN';
  const errorClass = SAFE_ERROR_NAMES.has(cause?.name) ? cause.name : 'Other';
  const stage = SAFE_PHASES.has(error?.metadataPhase) ? error.metadataPhase : 'metadata-read';
  return { status: 'FAIL', stage, code, errorClass };
}

export async function collectMetadata(connect, identity, now = new Date().toISOString()) {
  const {
    restoreInstanceId,
    sourceSnapshotId,
    restoreResourceId,
    restoreInstanceArn,
    restoreAttestationChecksum,
    imageDigest,
    scannerSourceChecksum,
    readerFunctionChecksum,
  } = identity;
  if (restoreInstanceId !== 'vay2017-metadata-rehearsal-isolated-20260923') {
    throw new Error('restore_identity_invalid');
  }
  if (!/^vay2017-legacy-source-freeze-20260920$/.test(sourceSnapshotId)) {
    throw new Error('snapshot_identity_invalid');
  }
  if (!/^db-[A-Z0-9]+$/.test(restoreResourceId) || restoreInstanceArn !== `arn:aws:rds:eu-west-1:269416271598:db:${restoreInstanceId}`) {
    throw new Error('restore_resource_identity_invalid');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error('image_digest_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(scannerSourceChecksum)) {
    throw new Error('scanner_source_checksum_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(readerFunctionChecksum)) {
    throw new Error('reader_function_checksum_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(restoreAttestationChecksum)) {
    throw new Error('restore_attestation_checksum_invalid');
  }

  const discoveryClient = await inPhase('database-connect', () => connect('postgres'));
  let databaseNames;
  try {
    await inPhase('database-discovery', async () => {
      await beginReadOnly(discoveryClient);
      const result = await discoveryClient.query(DATABASES_SQL);
      databaseNames = result.rows.map((row) => row.database_name);
      await discoveryClient.query('COMMIT');
    });
  } catch (error) {
    await rollbackQuietly(discoveryClient);
    throw error;
  } finally {
    await discoveryClient.end().catch(() => {});
  }

  const databases = [];
  for (const databaseName of databaseNames) {
    const client = await inPhase('database-connect', () => connect(databaseName));
    try {
      const { schemaResult, tableResult } = await inPhase('schema-inventory', async () => {
        await beginReadOnly(client);
        return {
          schemaResult: await client.query(SCHEMAS_SQL),
          tableResult: await client.query(INVENTORY_SQL),
        };
      });
      const tables = [];
      for (const row of tableResult.rows) {
        let table = tables.at(-1);
        if (!table || table.schema !== row.schema_name || table.name !== row.table_name) {
          table = {
            schema: row.schema_name,
            name: row.table_name,
            rowCount: null,
            columns: [],
            primaryKey: [],
          };
          tables.push(table);
        }
        if (row.column_name !== null) {
          table.columns.push({
            name: row.column_name,
            ordinal: Number(row.column_ordinal),
            type: row.data_type,
            notNull: row.not_null,
          });
          if (row.primary_key) {
            table.primaryKey.push({
              name: row.column_name,
              ordinal: Number(row.primary_key_ordinal),
            });
          }
        }
      }

      if (tables.length > 0) {
        await client.query("SET LOCAL statement_timeout = '15min'");
      }
      for (const table of tables) {
        const countResult = await inPhase('row-count', () => client.query(
          rowCountSql(), [table.schema, table.name],
        ));
        table.rowCount = countResult.rows[0]?.row_count ?? null;
        if (table.rowCount === null || !/^\d+$/.test(table.rowCount)) {
          throw new Error('row_count_invalid');
        }
      }

      databases.push({ name: databaseName, schemas: schemaResult.rows.map((row) => row.schema_name), tables });
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  const schemaShape = databases.map(({ name, schemas, tables }) => ({
    name,
    schemas,
    tables: tables.map(({ schema, name: tableName, columns, primaryKey }) => ({
      schema, name: tableName, columns, primaryKey,
    })),
  }));
  return {
    artifactVersion: 2,
    collectedAt: now,
    sourceSnapshotId,
    restoreInstanceId,
    restoreResourceId,
    restoreInstanceArn,
    restoreAttestationChecksum,
    imageDigest,
    scannerSourceChecksum,
    readerFunctionChecksum,
    queryVersion: QUERY_VERSION,
    queryChecksum: sha256(`${DATABASES_SQL}\n${SCHEMAS_SQL}\n${INVENTORY_SQL}\n${rowCountSql()}\n${readerFunctionChecksum}`),
    schemaFingerprint: sha256(JSON.stringify(schemaShape)),
    rowCountSemantics: 'exact COUNT(*) from the fixed count-only function under read-only repeatable-read transactions',
    databases,
  };
}

async function main() {
  const required = [
    'VAY2017_DB_HOST',
    'VAY2017_DB_PORT',
    'VAY2017_DB_USER',
    'VAY2017_DB_PASSWORD',
    'VAY2017_RESTORE_INSTANCE_ID',
    'VAY2017_SOURCE_SNAPSHOT_ID',
    'VAY2017_RESTORE_RESOURCE_ID',
    'VAY2017_RESTORE_INSTANCE_ARN',
    'VAY2017_RESTORE_ATTESTATION_CHECKSUM',
    'VAY2017_IMAGE_DIGEST',
    'VAY2017_SCANNER_SOURCE_CHECKSUM',
    'VAY2017_READER_FUNCTION_CHECKSUM',
  ];
  if (required.some((key) => !process.env[key])) {
    console.error(JSON.stringify({ status: 'FAIL', stage: 'configuration', code: 'required_value_missing' }));
    process.exitCode = 1;
    return;
  }
  let caBundle;
  try {
    caBundle = trustedRdsCa();
  } catch {
    console.error(JSON.stringify({ status: 'FAIL', stage: 'configuration', code: 'database_ca_invalid' }));
    process.exitCode = 1;
    return;
  }

  const { default: pg } = await import('pg');
  const connect = async (databaseName) => {
    const client = new pg.Client({
      host: process.env.VAY2017_DB_HOST,
      port: Number(process.env.VAY2017_DB_PORT),
      database: databaseName,
      user: process.env.VAY2017_DB_USER,
      password: process.env.VAY2017_DB_PASSWORD,
      ssl: {
        ca: caBundle,
        rejectUnauthorized: true,
        servername: process.env.VAY2017_DB_HOST,
      },
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      application_name: 'vay2017-metadata-runner-v2',
    });
    await client.connect();
    return client;
  };
  try {
    const artifact = await collectMetadata(connect, {
      restoreInstanceId: process.env.VAY2017_RESTORE_INSTANCE_ID,
      sourceSnapshotId: process.env.VAY2017_SOURCE_SNAPSHOT_ID,
      restoreResourceId: process.env.VAY2017_RESTORE_RESOURCE_ID,
      restoreInstanceArn: process.env.VAY2017_RESTORE_INSTANCE_ARN,
      restoreAttestationChecksum: process.env.VAY2017_RESTORE_ATTESTATION_CHECKSUM,
      imageDigest: process.env.VAY2017_IMAGE_DIGEST,
      scannerSourceChecksum: process.env.VAY2017_SCANNER_SOURCE_CHECKSUM,
      readerFunctionChecksum: process.env.VAY2017_READER_FUNCTION_CHECKSUM,
    });
    console.log(`VAY2017_METADATA_ARTIFACT=${JSON.stringify(artifact)}`);
  } catch (error) {
    console.error(JSON.stringify(sanitizeError(error)));
    process.exitCode = 1;
  }
}

if (process.env.VAY2017_RUN_MAIN === '1') {
  await main();
}
