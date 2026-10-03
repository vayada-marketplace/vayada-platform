import pg from 'pg';
let client;
try {
  const url = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
      url.port !== '5432' || url.username !== 'vayada_admin' || !url.password || url.hash ||
      url.pathname !== '/postgres' || url.search !== '?sslmode=require' || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error();
  url.pathname = '/vayada_target_prod';
  client = new pg.Client({ connectionString: url.href.replace('?sslmode=require', ''),
    ssl: { rejectUnauthorized: true, ca: process.env.VAYADA_DB_RDS_CA_BUNDLE } });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  const rows = (await client.query(`SELECT version,status,failure_reason,checksum_sha256
    FROM platform.schema_migrations WHERE version=$1 ORDER BY applied_at DESC LIMIT 3`, ['0441'])).rows;
  await client.query('ROLLBACK');
  // Only reviewed diagnostic phrases leave the task, never a PostgreSQL payload.
  const failures = rows.map(row => ({version: row.version, status: row.status, checksum: row.checksum_sha256,
    reason: /permission denied to create role/i.test(row.failure_reason ?? '') ? 'role_creation_denied' :
      /must be owner of/i.test(row.failure_reason ?? '') ? 'object_ownership_denied' :
      /already exists/i.test(row.failure_reason ?? '') ? 'object_already_exists' : 'inspection_required'}));
  console.log(JSON.stringify({status: 'PASS', migration: '0441', failures}));
} catch {
  console.error(JSON.stringify({status: 'FAIL', code: 'hotel_setup_migration_audit_unavailable'}));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
