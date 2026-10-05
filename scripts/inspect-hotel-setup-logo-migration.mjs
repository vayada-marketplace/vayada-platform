import pg from 'pg';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const manifest = new Map([
  ['0464', ['0464_hotel_setup_reconciliation_cursor.sql', 'a29545e48f2ba83d934e39db9c27ac5d9a0f2ee79422b19d36c60b1fea9d3fcb']],
  ['0465', ['0465_hotel_setup_tenant_helpers.sql', '36681009d2deb805f3b1c4e1d6616786cce3bd0a48ea9cd89daa6593861e0db4']],
  ['0466', ['0466_hotel_setup_logo_scope.sql', 'c8b9a560a269e6a44c67dc5e8ed55dcfa5d1eb7acc71a120bba492bb7f121043']],
  ['0467', ['0467_hotel_setup_logo_session_binding.sql', '042b0121486012364ee1ebcbe3ad0ed537a0dc9663e32197a798b7fad231850e']],
  ['0468', ['0468_hotel_setup_logo_media_scope.sql', '844b9270844076bee6d323ca1e691d4d643bd010303825b84df2bfe9b7809b48']],
  ['0469', ['0469_hotel_setup_logo_projection.sql', '774808fd4e8fcd220d0ebaed02e8864684203cd34f67b792714e714e3d1023e5']],
]);
const roles = ['vayada_admin', 'vayada_target_prod_user', 'vayada_next_hotel_setup_logo_scope'];
const knownRoles = new Set([...roles, 'rdsadmin', 'rds_superuser', 'postgres']);
const digest = value => createHash('sha256').update(value).digest('hex');
const roleName = name => knownRoles.has(name) ? {name} : {name: 'other', nameSha256: digest(name)};
const validHash = value => /^[a-f0-9]{64}$/.test(value ?? '') ? value : null;
const selfGrant = value => {
  if (value === null || value === '') return value;
  if (typeof value !== 'string' || !/^(?:inherit|set)(?:\s*,\s*(?:inherit|set))*$/.test(value.trim())) return 'other';
  return [...new Set(value.split(',').map(option => option.trim()))].sort().join(',');
};
const settingSources = new Set(['default', 'dynamic default', 'environment variable', 'configuration file',
  'command line', 'global', 'database', 'user', 'database user', 'client', 'override', 'interactive', 'test', 'session']);
let client;
let stage = 'configuration';
const inspection = {};
try {
  const url = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
      url.port !== '5432' || url.username !== 'vayada_admin' || !url.password || url.hash ||
      url.pathname !== '/postgres' || url.search !== '?sslmode=require' || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error();
  for (const [name, hash] of manifest.values()) {
    if (digest(readFileSync(`/app/packages/backend-migration/migrations/${name}`)) !== hash) throw new Error();
  }
  url.pathname = '/vayada_target_prod';
  client = new pg.Client({connectionString: url.href.replace('?sslmode=require', ''),
    connectionTimeoutMillis: 10000, query_timeout: 15000,
    ssl: {rejectUnauthorized: true, ca: process.env.VAYADA_DB_RDS_CA_BUNDLE}});
  stage = 'connection';
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  stage = 'identity';
  const identity = (await client.query(`SELECT current_database()='vayada_target_prod' AS database_matches,
    current_user='vayada_admin' AS principal_matches, pg_catalog.pg_is_in_recovery() AS replica,
    current_setting('transaction_read_only')='on' AS read_only, role.rolsuper, role.rolcreaterole,
    role.rolcreatedb, role.rolcanlogin FROM pg_catalog.pg_roles role WHERE role.rolname=current_user`)).rows;
  inspection.identity = identity[0] ?? null;
  if (identity.length !== 1 || !identity[0].database_matches || !identity[0].principal_matches ||
      identity[0].replica !== false || identity[0].read_only !== true || identity[0].rolsuper !== false) throw new Error();
  stage = 'server_settings';
  const server = (await client.query(`SELECT current_setting('server_version_num')::int AS server_version_num,
    current_setting('createrole_self_grant',true) AS self_grant,
    (SELECT source FROM pg_catalog.pg_settings WHERE name='createrole_self_grant') AS source,
    (SELECT reset_val FROM pg_catalog.pg_settings WHERE name='createrole_self_grant') AS reset_val,
    pg_catalog.has_function_privilege(current_user,'pg_catalog.pg_advisory_xact_lock(bigint)','EXECUTE') AS advisory_lock_execute,
    pg_catalog.has_function_privilege(current_user,'pg_catalog.hashtextextended(text,bigint)','EXECUTE') AS lock_hash_execute`)).rows[0];
  inspection.server = {serverVersionNum: server.server_version_num, createroleSelfGrant: selfGrant(server.self_grant),
    createroleSelfGrantSource: server.source === null ? null : settingSources.has(server.source) ? server.source : 'other',
    createroleSelfGrantReset: selfGrant(server.reset_val),
    advisoryLockExecute: server.advisory_lock_execute, lockHashExecute: server.lock_hash_execute};
  stage = 'roles';
  inspection.roles = (await client.query(`SELECT rolname AS name, rolsuper, rolcreaterole, rolcreatedb,
    rolcanlogin, rolinherit, rolreplication, rolbypassrls, rolconfig IS NOT NULL AS has_role_settings,
    rolvaliduntil IS NOT NULL AS has_expiry, rolconnlimit=-1 AS unlimited_connections,
    (SELECT count(*)::int FROM pg_catalog.pg_db_role_setting setting WHERE setting.setrole=role.oid) AS database_settings,
    (SELECT count(*)::int FROM pg_catalog.pg_auth_members edge WHERE edge.member=role.oid) AS outgoing_memberships,
    (SELECT count(*)::int FROM pg_catalog.pg_auth_members edge WHERE edge.roleid=role.oid) AS incoming_memberships
    FROM pg_catalog.pg_roles role WHERE rolname=ANY($1) ORDER BY rolname`, [roles])).rows;
  const ownership = (await client.query(`SELECT 'schema' AS object, role.rolname AS owner,
    role.rolsuper, role.rolcreaterole FROM pg_catalog.pg_namespace namespace
    JOIN pg_catalog.pg_roles role ON role.oid=namespace.nspowner WHERE namespace.nspname='platform'
    UNION ALL SELECT 'property_scopes' AS object, role.rolname AS owner, role.rolsuper, role.rolcreaterole
    FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN pg_catalog.pg_roles role ON role.oid=relation.relowner
    WHERE namespace.nspname='platform' AND relation.relname='hotel_setup_property_scopes'`)).rows;
  inspection.ownership = ownership.map(row => ({object: row.object, owner: roleName(row.owner),
    rolsuper: row.rolsuper, rolcreaterole: row.rolcreaterole}));
  const memberships = (await client.query(`SELECT parent.rolname AS parent, member.rolname AS member,
    grantor.rolname AS grantor, grantor.rolsuper AS grantor_superuser,
    edge.admin_option, edge.inherit_option, edge.set_option, count(*) OVER()::int AS total
    FROM pg_catalog.pg_auth_members edge JOIN pg_catalog.pg_roles parent ON parent.oid=edge.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=edge.member JOIN pg_catalog.pg_roles grantor ON grantor.oid=edge.grantor
    WHERE parent.rolname=ANY($1) OR member.rolname=ANY($1)
    ORDER BY (parent.rolname='vayada_next_hotel_setup_logo_scope' OR member.rolname='vayada_next_hotel_setup_logo_scope') DESC,
      parent.rolname,member.rolname,grantor.rolname LIMIT 20`, [roles])).rows;
  inspection.memberships = {total: memberships[0]?.total ?? 0, edges: memberships.map(row => ({
    parent: roleName(row.parent), member: roleName(row.member), grantor: roleName(row.grantor),
    grantorSuperuser: row.grantor_superuser, admin: row.admin_option, inherit: row.inherit_option, set: row.set_option}))};
  stage = 'ledger';
  inspection.ledger = [];
  for (const [version, [name, hash]] of manifest) {
    const rows = (await client.query(`SELECT status,environment,name,checksum_sha256,failure_reason,
      count(*) OVER()::int AS total, bool_or(coalesce(status='applied',false)) OVER() AS applied_seen,
      bool_and(coalesce(status='applied' AND environment='production' AND name=$2 AND checksum_sha256=$3,false)) OVER() AS all_applied_pinned,
      bool_and(coalesce(status='applied' AND environment='production' AND name=$4 AND checksum_sha256=$3,false)) OVER() AS all_applied_basename_pinned,
      bool_and(coalesce(status='failed' AND environment='production' AND name=$2 AND checksum_sha256=$3
        AND coalesce(failure_reason,'') ~* 'permission denied to create role',false)) OVER() AS all_create_role_denied_pinned,
      bool_and(coalesce(status='failed' AND environment='production' AND name=$4 AND checksum_sha256=$3
        AND coalesce(failure_reason,'') ~* 'permission denied to create role',false)) OVER() AS all_create_role_denied_basename_pinned
      FROM platform.schema_migrations WHERE version=$1 ORDER BY applied_at DESC,id DESC LIMIT 3`, [version, name, hash, name.slice(5,-4)])).rows;
    const summary = {version, total: rows[0]?.total ?? 0, appliedSeen: rows[0]?.applied_seen ?? false,
      allAppliedPinned: rows[0]?.all_applied_pinned ?? true,
      allAppliedBasenamePinned: rows[0]?.all_applied_basename_pinned ?? true,
      allCreateRoleDeniedPinned: rows[0]?.all_create_role_denied_pinned ?? true,
      allCreateRoleDeniedBasenamePinned: rows[0]?.all_create_role_denied_basename_pinned ?? true,
      latest: rows.map(row => ({applied: row.status==='applied', failed: row.status==='failed',
        production: row.environment==='production', filenameMatches: row.name===name,
        basenameMatches: row.name===name.slice(5,-4), checksum: validHash(row.checksum_sha256), checksumMatches: row.checksum_sha256===hash,
        reason: /checksum mismatch/i.test(row.failure_reason ?? '') ? 'checksum_rejection' :
          /permission denied to create role/i.test(row.failure_reason ?? '') ? 'create_role_denied' : 'inspection_required'}))};
    if (version === '0464' || version === '0465') {
      summary.appliedWitness = (await client.query(`WITH history AS (
        SELECT *, row_number() OVER(ORDER BY applied_at DESC,id DESC) AS ordinal
        FROM platform.schema_migrations WHERE version=$1
      ), classified AS (
        SELECT *, coalesce(status='failed' AND environment='production'
          AND name ~ '^[a-z][a-z0-9_]{0,199}$' AND checksum_sha256 ~ '^[a-f0-9]{64}$'
          AND checksum_sha256<>$3 AND duration_ms=0 AND statement_count IS NULL AND requires_rebuild=false
          AND failure_reason='Checksum mismatch for '||$1||'_'||name||'.sql: ledger has '||$3||', file is '||checksum_sha256,
          false) AS exact_rejection FROM history
      ), witness AS (SELECT * FROM classified WHERE status='applied' ORDER BY ordinal LIMIT 1)
      SELECT EXISTS(SELECT 1 FROM witness) AS present,
        (SELECT coalesce(environment='production' AND name=$2 AND checksum_sha256=$3,false) FROM witness) AS canonical_pinned,
        (SELECT count(*)::int FROM classified WHERE ordinal<(SELECT ordinal FROM witness)) AS newer_attempts,
        (SELECT count(*)::int FROM classified WHERE ordinal<(SELECT ordinal FROM witness) AND NOT exact_rejection) AS newer_unresolved,
        (SELECT count(*)::int FROM classified WHERE ordinal>(SELECT ordinal FROM witness)) AS older_total,
        (SELECT count(*)::int FROM classified WHERE ordinal>(SELECT ordinal FROM witness) AND status='failed') AS older_failed,
        (SELECT count(*)::int FROM classified WHERE ordinal>(SELECT ordinal FROM witness) AND status='failed' AND NOT exact_rejection) AS older_other_failure,
        (SELECT count(*)::int FROM classified WHERE ordinal>(SELECT ordinal FROM witness) AND status='applied'
          AND NOT coalesce(environment='production' AND name=$2 AND checksum_sha256=$3,false)) AS older_applied_mismatch`,
        [version, name.slice(5,-4), hash])).rows[0];
    }
    inspection.ledger.push(summary);
  }
  inspection.laterMigrationPresent = (await client.query(`SELECT EXISTS(
    SELECT 1 FROM platform.schema_migrations WHERE version>'0469') AS present`)).rows[0].present;
  inspection.unlistedMigrationAtOrAfterLogoPresent = (await client.query(`SELECT EXISTS(
    SELECT 1 FROM platform.schema_migrations WHERE version>='0466' AND NOT(version=ANY($1))) AS present`,
    [['0466','0467','0468','0469']])).rows[0].present;
  stage = 'rollback';
  await client.query('ROLLBACK');
  console.log(JSON.stringify({status: 'PASS', audit: 'hotel_setup_logo_migration_inspection', inspection}));
} catch {
  await client?.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({status: 'FAIL', code: 'hotel_setup_logo_migration_inspection_unavailable', stage, inspection}));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
