import pg from 'pg';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const checksum = '37e255918b5fd107c9ed6c9f9ed5aebd4818ab281d8c67c83755528f46235b9b';
let client;
let commitStarted = false;
try {
  if (createHash('sha256').update(readFileSync('/app/packages/backend-migration/migrations/0441_hotel_setup_property_financials_scope.sql')).digest('hex') !== checksum) throw new Error();
  const url = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
      url.port !== '5432' || url.username !== 'vayada_admin' || !url.password || url.hash ||
      url.pathname !== '/postgres' || url.search !== '?sslmode=require' || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error();
  url.pathname = '/vayada_target_prod';
  client = new pg.Client({connectionString: url.href.replace('?sslmode=require', ''),
    ssl: {rejectUnauthorized: true, ca: process.env.VAYADA_DB_RDS_CA_BUNDLE}});
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hotel-setup-migration-0441-scope',0))");
  const ledger = (await client.query(`SELECT status,checksum_sha256,failure_reason
    FROM platform.schema_migrations WHERE version=$1 ORDER BY applied_at DESC`, ['0441'])).rows;
  if (ledger.some(row => row.status !== 'failed') || !ledger.length || ledger.some(row =>
      row.checksum_sha256 !== checksum || !/permission denied to create role/i.test(row.failure_reason ?? ''))) throw new Error();
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname='vayada_next_hotel_setup_property_scope'");
  if (existing.rowCount) throw new Error();
  await client.query(`CREATE ROLE vayada_next_hotel_setup_property_scope NOLOGIN NOINHERIT
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const verified = await client.query(`SELECT 1 FROM pg_roles WHERE rolname='vayada_next_hotel_setup_property_scope'
    AND NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
    AND rolconfig IS NULL AND rolvaliduntil IS NULL AND rolconnlimit=-1`);
  if (verified.rowCount !== 1) throw new Error();
  commitStarted = true;
  await client.query('COMMIT');
  console.log(JSON.stringify({status:'PASS',migration:'0441',scopeRole:'vayada_next_hotel_setup_property_scope',login:false,businessGrantsAdded:false}));
} catch {
  await client?.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({status:'FAIL',code:commitStarted ? 'hotel_setup_scope_commit_inspection_required' : 'hotel_setup_scope_staging_unavailable'}));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
