import { createHash } from 'node:crypto';

export const QUERY_VERSION = 'v1';

export const DATABASES_SQL = `
SELECT datname AS database_name
FROM pg_catalog.pg_database
WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin'
ORDER BY datname
`;

export const SCHEMAS_SQL = `
SELECT nspname AS schema_name
FROM pg_catalog.pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
ORDER BY nspname
`;

// This query reads structural catalogs only. Exact row counts are collected
// separately with read-only COUNT(*) queries over catalog-discovered tables.
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
  AND n.nspname !~ '^pg_'
ORDER BY n.nspname, c.relname, a.attnum
`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
export const rowCountSql = (schema, table) => (
  `SELECT count(*)::text AS row_count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
);

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

export function sanitizeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9]{2,8}$/.test(error.code)
    ? error.code
    : 'UNKNOWN';
  return { status: 'FAIL', stage: 'metadata-read', code };
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
  if (!/^[a-f0-9]{64}$/.test(restoreAttestationChecksum)) {
    throw new Error('restore_attestation_checksum_invalid');
  }

  const discoveryClient = await connect('postgres');
  let databaseNames;
  try {
    await beginReadOnly(discoveryClient);
    const result = await discoveryClient.query(DATABASES_SQL);
    databaseNames = result.rows.map((row) => row.database_name);
    await discoveryClient.query('COMMIT');
  } catch (error) {
    await rollbackQuietly(discoveryClient);
    throw error;
  } finally {
    await discoveryClient.end().catch(() => {});
  }

  const databases = [];
  for (const databaseName of databaseNames) {
    const client = await connect(databaseName);
    try {
      await beginReadOnly(client);
      const schemaResult = await client.query(SCHEMAS_SQL);
      const tableResult = await client.query(INVENTORY_SQL);
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

      for (const table of tables) {
        const countResult = await client.query(rowCountSql(table.schema, table.name));
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
    artifactVersion: 1,
    collectedAt: now,
    sourceSnapshotId,
    restoreInstanceId,
    restoreResourceId,
    restoreInstanceArn,
    restoreAttestationChecksum,
    imageDigest,
    scannerSourceChecksum,
    queryVersion: QUERY_VERSION,
    queryChecksum: sha256(`${DATABASES_SQL}\n${SCHEMAS_SQL}\n${INVENTORY_SQL}\nSELECT count(*)::text FROM <quoted-catalog-identifier>`),
    schemaFingerprint: sha256(JSON.stringify(schemaShape)),
    rowCountSemantics: 'exact COUNT(*) under read-only repeatable-read transactions',
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
  ];
  if (required.some((key) => !process.env[key])) {
    console.error(JSON.stringify({ status: 'FAIL', stage: 'configuration', code: 'required_value_missing' }));
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
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      application_name: 'vay2017-metadata-runner-v1',
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
