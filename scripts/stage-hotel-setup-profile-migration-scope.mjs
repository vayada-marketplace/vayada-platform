import pg from 'pg';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
// VAY-965: pre-stage only the fixed NOLOGIN parent consumed by migration 0470.
const checksum = '065464209d9d0f32bb20465c3f511bf7feb7a15199617a2d7ad06c135334e536';
let client;
let commitStarted = false;
let stage = 'configuration';
let parentPosture = null;
try {
  if (createHash('sha256').update(readFileSync('/app/packages/backend-migration/migrations/0470_hotel_setup_profile_edit_scope.sql')).digest('hex') !== checksum) throw new Error();
  const url = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
      url.port !== '5432' || url.username !== 'vayada_admin' || !url.password || url.hash ||
      url.pathname !== '/postgres' || url.search !== '?sslmode=require' || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error();
  url.pathname = '/vayada_target_prod';
  client = new pg.Client({connectionString: url.href.replace('?sslmode=require', ''),
    ssl: {rejectUnauthorized: true, ca: process.env.VAYADA_DB_RDS_CA_BUNDLE}});
  stage = 'connection';
  await client.connect();
  stage = 'lock';
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hotel-setup-migration-0470-scope',0))");
  stage = 'identity';
  const identity = (await client.query(`SELECT current_database() AS database, current_user AS principal,
    pg_catalog.pg_is_in_recovery() AS replica,
    role.rolsuper,role.rolcreaterole FROM pg_catalog.pg_roles role WHERE role.rolname=current_user`)).rows;
  if (identity.length !== 1 || identity[0].database !== 'vayada_target_prod' ||
      identity[0].principal !== 'vayada_admin' || identity[0].replica !== false ||
      identity[0].rolsuper !== false || identity[0].rolcreaterole !== true) throw new Error();
  stage = 'owner';
  const owner = (await client.query(`SELECT role.rolname,role.rolsuper,role.rolcreaterole
    FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN pg_catalog.pg_roles role ON role.oid=relation.relowner
    WHERE namespace.nspname='platform' AND relation.relname='hotel_setup_property_scopes'`)).rows;
  if (owner.length !== 1 || owner[0].rolname !== 'vayada_target_prod_user' ||
      owner[0].rolsuper !== false || owner[0].rolcreaterole !== false) throw new Error();
  stage = 'ledger';
  // 0470 rewrites constraints created by the logo family; every predecessor must be exactly applied.
  const manifest = {
    "0466": ["0466_hotel_setup_logo_scope.sql", "c8b9a560a269e6a44c67dc5e8ed55dcfa5d1eb7acc71a120bba492bb7f121043"],
    "0467": ["0467_hotel_setup_logo_session_binding.sql", "042b0121486012364ee1ebcbe3ad0ed537a0dc9663e32197a798b7fad231850e"],
    "0468": ["0468_hotel_setup_logo_media_scope.sql", "844b9270844076bee6d323ca1e691d4d643bd010303825b84df2bfe9b7809b48"],
    "0469": ["0469_hotel_setup_logo_projection.sql", "774808fd4e8fcd220d0ebaed02e8864684203cd34f67b792714e714e3d1023e5"]};
  for (const [version,[name,hash]] of Object.entries(manifest)) {
    if (createHash('sha256').update(readFileSync(`/app/packages/backend-migration/migrations/${name}`)).digest('hex') !== hash) throw new Error();
    const rows = (await client.query(`SELECT status,environment,name,checksum_sha256 FROM platform.schema_migrations
      WHERE version=$1 ORDER BY applied_at DESC,id DESC`,[version])).rows;
    if (!rows.some(row=>row.status==='applied')) throw new Error();
    if (rows.some(row=>row.status!=='applied' || row.environment!=='production' || row.name!==name.slice(5,-4) || row.checksum_sha256!==hash)) throw new Error();
  }
  // 0470 may be absent (pre-merge) or hold only exact CREATE ROLE denials; nothing later may exist.
  const ledger = (await client.query(`SELECT version,name,status,environment,checksum_sha256,failure_reason
    FROM platform.schema_migrations WHERE version >= '0470' ORDER BY applied_at DESC,id DESC`)).rows;
  if (ledger.some(row=>row.version!=='0470' || row.name!=='hotel_setup_profile_edit_scope' || row.status!=='failed' || row.environment!=='production' ||
      row.checksum_sha256!==checksum || !/permission denied to create role/i.test(row.failure_reason??''))) throw new Error();
  stage = 'parent_absent';
  const existing = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_profile_scope'");
  if (existing.rowCount) throw new Error();
  stage = 'parent_create';
  await client.query(`CREATE ROLE vayada_next_hotel_setup_profile_scope NOLOGIN NOINHERIT
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  stage = 'parent_verify';
  parentPosture = (await client.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
    rolconfig IS NOT NULL AS has_role_settings,rolvaliduntil IS NOT NULL AS has_expiry,rolconnlimit=-1 AS unlimited_connections,
    (SELECT count(*)::int FROM pg_catalog.pg_auth_members WHERE member=role.oid) AS outgoing_memberships,
    (SELECT count(*)::int FROM pg_catalog.pg_auth_members WHERE roleid=role.oid) AS incoming_memberships,
    (SELECT count(*)::int FROM pg_catalog.pg_db_role_setting WHERE setrole=role.oid) AS database_settings,
    (SELECT json_agg(edge) FROM (SELECT creator.rolname='vayada_admin' AS creator_matches,
      membership.admin_option,membership.inherit_option,membership.set_option,grantor.rolsuper AS grantor_superuser
      FROM pg_catalog.pg_auth_members membership JOIN pg_catalog.pg_roles creator ON creator.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
      WHERE membership.roleid=role.oid ORDER BY membership.member,membership.grantor LIMIT 3) edge) AS creator_edges
    FROM pg_catalog.pg_roles role WHERE rolname='vayada_next_hotel_setup_profile_scope'`)).rows[0] ?? null;
  // RDS can omit the stock PostgreSQL creator edge; an edge present must remain ADMIN-only.
  const verified = await client.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_profile_scope'
    AND NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
    AND rolconfig IS NULL AND rolvaliduntil IS NULL AND rolconnlimit=-1
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members edge
      WHERE edge.member=pg_catalog.pg_roles.oid)
    AND ((SELECT count(*) FROM pg_catalog.pg_auth_members edge WHERE edge.roleid=pg_catalog.pg_roles.oid)=0 OR (
    (SELECT count(*) FROM pg_catalog.pg_auth_members edge WHERE edge.roleid=pg_catalog.pg_roles.oid)=1
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members edge
      JOIN pg_catalog.pg_roles creator ON creator.oid=edge.member
      JOIN pg_catalog.pg_roles bootstrap ON bootstrap.oid=edge.grantor
      WHERE edge.roleid=pg_catalog.pg_roles.oid AND creator.rolname='vayada_admin'
        AND edge.admin_option AND NOT edge.inherit_option AND NOT edge.set_option AND bootstrap.rolsuper)))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_db_role_setting setting
      WHERE setting.setrole=pg_catalog.pg_roles.oid)`);
  if (verified.rowCount !== 1) throw new Error();
  stage = 'commit';
  commitStarted = true;
  await client.query('COMMIT');
  console.log(JSON.stringify({status:'PASS',migration:'0470',scopeRole:'vayada_next_hotel_setup_profile_scope',login:false,businessGrantsAdded:false,migrationOwner:'vayada_target_prod_user',migrationOwnerCanCreateRole:false,creatorAdminOnlyMembership:true,scopeIncomingMemberships:parentPosture.incoming_memberships}));
} catch (error) {
  await client?.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({status:'FAIL',code:commitStarted ? 'hotel_setup_scope_commit_inspection_required' : 'hotel_setup_scope_staging_unavailable',
    stage,sqlstate:/^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null,parentPosture}));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
