import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

// This is only the reviewed pre-0463/0464 transition, never a migration runner.
const directory = '/app/packages/backend-migration/migrations';
const pending = new Map([
  ['0463_hotel_setup_credential_readiness.sql', '012e467055d3338bc3c7538edab1cda887877ca2dfc37052ac7cd421940681d3'],
  ['0464_hotel_setup_reconciliation_cursor.sql', 'a29545e48f2ba83d934e39db9c27ac5d9a0f2ee79422b19d36c60b1fea9d3fcb'],
]);
let client;
let stage='configuration',reason,version;
const failLedger = (value,row) => { reason=value; if (/^\d{4}$/.test(row?.version ?? '')) version=row.version; throw new Error(); };
try {
  const url = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
      url.port !== '5432' || url.username !== 'vayada_admin' || !url.password || url.hash ||
      url.pathname !== '/postgres' || url.search !== '?sslmode=require' || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error();
  stage='manifest';
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  if (files.length < 3 || files.length > 1000) throw new Error();
  const manifest = new Map();
  for (const filename of files) {
    const match = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/.exec(filename);
    if (!match || match[1] > '0464' || manifest.has(match[1])) throw new Error();
    const content = await readFile(`${directory}/${filename}`, 'utf8');
    const checksum = createHash('sha256').update(content, 'utf8').digest('hex');
    if (pending.has(filename) && checksum !== pending.get(filename)) throw new Error();
    manifest.set(match[1], { name: match[2], checksum });
  }
  if (!manifest.has('0001') || !manifest.has('0462') ||
      [...pending.keys()].some(name => !files.includes(name))) throw new Error();

  stage='connection';
  url.pathname = '/vayada_target_prod';
  client = new pg.Client({ connectionString: url.href.replace('?sslmode=require', ''),
    connectionTimeoutMillis: 10000, query_timeout: 15000,
    ssl: { rejectUnauthorized: true, ca: process.env.VAYADA_DB_RDS_CA_BUNDLE } });
  await client.connect();
  // Acquire before BEGIN so the repeatable-read snapshot cannot predate a
  // concurrent migrator's COMMIT. Connection close releases this session lock.
  stage='lock';
  const lock = (await client.query('SELECT pg_try_advisory_lock(8734516) AS locked')).rows;
  if (lock.length !== 1 || lock[0].locked !== true) throw new Error();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  stage='identity';
  const identity = (await client.query(`SELECT current_database() AS database, current_user AS principal,
    pg_is_in_recovery() AS replica, current_setting('transaction_read_only') AS read_only`)).rows;
  if (identity.length !== 1 || identity[0].database !== 'vayada_target_prod' ||
      identity[0].principal !== 'vayada_admin' || identity[0].replica !== false ||
      identity[0].read_only !== 'on') throw new Error();
  stage='ledger';
  const rows = (await client.query(`SELECT version, name, status, environment, checksum_sha256,
      failure_reason, duration_ms, statement_count, requires_rebuild,
      row_number() OVER (PARTITION BY version ORDER BY applied_at DESC, id DESC) AS history_order
    FROM platform.schema_migrations ORDER BY version, applied_at DESC, id DESC LIMIT 10001`)).rows;
  if (rows.length > 10000) failLedger('history_limit');
  const histories = new Map();
  for (const row of rows) {
    const history = histories.get(row.version) ?? [];
    history.push(row);
    histories.set(row.version, history);
  }
  const applied = new Set();
  let rejectedChecksums = 0;
  for (const [migrationVersion, history] of histories) {
    const row = history[0];
    const expected = manifest.get(migrationVersion);
    if (!expected) failLedger('unknown_version',row);
    if (row.version >= '0463') failLedger('transition_already_present',row);
    if (history.some((entry,index) => Number(entry.history_order) !== index + 1)) failLedger('history_order',row);
    const witnessIndex = history.findIndex(entry => entry.status === 'applied');
    if (witnessIndex < 0) failLedger('not_applied',row);
    const witness = history[witnessIndex];
    if (witness.environment !== 'production') failLedger('wrong_environment',witness);
    if (witness.name !== expected.name) failLedger('name_mismatch',witness);
    if (witness.checksum_sha256 !== expected.checksum) failLedger('checksum_mismatch',witness);
    // The canonical runner records checksum rejection before executing any DDL.
    // Every attempt after the applied witness must be that exact rejection;
    // a newer rejection cannot conceal an intervening unresolved DDL failure.
    for (const attempt of history.slice(0,witnessIndex)) {
      const filename = `${migrationVersion}_${expected.name}.sql`;
      const failure = `Checksum mismatch for ${filename}: ledger has ${expected.checksum}, file is ${attempt.checksum_sha256}`;
      if (attempt.status !== 'failed' || attempt.environment !== 'production' || attempt.name !== expected.name ||
          !/^[a-f0-9]{64}$/.test(attempt.checksum_sha256 ?? '') || attempt.checksum_sha256 === expected.checksum ||
          attempt.failure_reason !== failure || attempt.duration_ms !== 0 || attempt.statement_count !== null ||
          attempt.requires_rebuild !== false) failLedger('unresolved_history',attempt);
      rejectedChecksums++;
    }
    applied.add(migrationVersion);
  }
  if ([...manifest.keys()].filter(version => !applied.has(version)).join(',') !== '0463,0464') failLedger('pending_set_mismatch');
  stage='objects';
  const objects = (await client.query(`SELECT
    to_regclass('platform.hotel_setup_creation_scopes') IS NOT NULL AND
      to_regclass('platform.hotel_setup_property_scopes') IS NOT NULL AS scopes_present,
    to_regclass('platform.hotel_setup_reconciliation_cursors') IS NULL AS cursor_absent,
    NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN
      ('platform.hotel_setup_creation_scopes'::regclass, 'platform.hotel_setup_property_scopes'::regclass)
      AND attname IN ('credential_role_oid', 'credential_secret_version', 'credential_ready_at') AND NOT attisdropped) AS columns_absent,
    NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid IN
      ('platform.hotel_setup_creation_scopes'::regclass, 'platform.hotel_setup_property_scopes'::regclass)
      AND conname IN ('hotel_setup_creation_credential_ready', 'hotel_setup_property_credential_ready')) AS checks_absent`)).rows;
  if (objects.length !== 1 || ['scopes_present', 'cursor_absent', 'columns_absent', 'checks_absent']
      .some(key => objects[0][key] !== true)) throw new Error();
  stage='rollback';
  await client.query('ROLLBACK');
  const manifestSha256 = createHash('sha256').update(JSON.stringify([...manifest])).digest('hex');
  console.log(JSON.stringify({ status: 'PASS', audit: 'hotel_setup_readiness_migrations',
    appliedCount: applied.size, rejectedChecksums, manifestSha256, pending: ['0463', '0464'] }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', code: 'hotel_setup_readiness_migration_audit_unavailable',stage,
    ...(reason ? {reason} : {}),...(version ? {version} : {}),
    ...(/^[0-9A-Z]{5}$/.test(error?.code ?? '') ? {sqlState:error.code} : {}) }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
