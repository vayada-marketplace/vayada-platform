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
const owners = [
  {owner: 'animals', property: 'f4b1d762-7592-4182-b103-20b53014c171', organization: '2734e584-022d-432a-9637-ccb0cce59c53', actor: 'a729d719-2297-4be7-8f7a-12bdf87da1b3'},
  {owner: 'sri', property: '1dee5712-6074-4fb0-8b1d-ec3601943526', organization: '6a717155-a188-45f3-87e5-5c8408f41a87', actor: 'b9eec40b-2e2d-4ff1-b3d4-6d6e03bb58d9'},
];
const knownRoles = new Set([...roles, 'rdsadmin', 'rds_superuser', 'postgres']);
const digest = value => createHash('sha256').update(value).digest('hex');
for (const owner of owners) owner.prefix = `vayada_next_hotel_setup_logo_${digest(`${owner.property}:property_logo`).slice(0,16)}_`;
const roleName = name => knownRoles.has(name) || owners.some(owner => new RegExp(`^${owner.prefix}[a-f0-9]{12}$`).test(name)) ? {name} : {name: 'other', nameSha256: digest(name)};
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
  const inventoryPath = '/app/apps/api/dist/hotelSetupLogoPrivileges.js';
  if (digest(readFileSync(inventoryPath)) !== '65944cbb9cbed464fdd91b3052ce40c5422a09dc8bf3a98376d2340f74c91c22') throw new Error();
  // Reuse only the pinned immutable inventory; never invoke its command/proof functions.
  const {HOTEL_SETUP_LOGO_PRIVILEGES: inventory, HOTEL_SETUP_LOGO_RLS_HELPERS: helpers} = await import(inventoryPath);
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
  stage = 'bootstrap_capabilities';
  const requiredColumns = Object.entries(inventory).flatMap(([table, privileges]) => Object.entries(privileges)
    .flatMap(([privilege, columns]) => columns.map(column => ({table_name: table, privilege, column_name: column}))));
  inspection.bootstrapCapabilities = {
    databaseConnectGrant: (await client.query("SELECT pg_catalog.has_database_privilege(current_user,current_database(),'CONNECT WITH GRANT OPTION') AS allowed")).rows[0].allowed,
    parent: (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS present,
      EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members edge JOIN pg_catalog.pg_roles parent ON parent.oid=edge.roleid
        JOIN pg_catalog.pg_roles member ON member.oid=edge.member WHERE parent.rolname=$1 AND member.rolname=current_user AND edge.admin_option) AS direct_admin_edge`, [roles[2]])).rows[0],
    schemas: (await client.query(`SELECT name, pg_catalog.has_schema_privilege(current_user,namespace.oid,'USAGE WITH GRANT OPTION') AS usage_grant
      FROM pg_catalog.unnest($1::text[]) required(name) LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.nspname=name ORDER BY name`,
      [[...new Set(Object.keys(inventory).map(table => table.split('.')[0]))]])).rows,
    columns: (await client.query(`SELECT required.table_name,required.privilege,count(*)::int AS expected_columns,
      count(attribute.attnum)::int AS found_columns,
      count(*) FILTER(WHERE pg_catalog.has_column_privilege(current_user,relation.oid,attribute.attnum,required.privilege||' WITH GRANT OPTION'))::int AS grantable_columns
      FROM pg_catalog.jsonb_to_recordset($1::jsonb) required(table_name text,privilege text,column_name text)
      LEFT JOIN pg_catalog.pg_class relation ON relation.oid=pg_catalog.to_regclass(required.table_name)
      LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attname=required.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
      GROUP BY required.table_name,required.privilege ORDER BY required.table_name,required.privilege`, [JSON.stringify(requiredColumns)])).rows,
    mediaDeleteGrant: (await client.query("SELECT pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('hotel_catalog.property_media'),'DELETE WITH GRANT OPTION') AS allowed")).rows[0].allowed,
    helpers: (await client.query(`SELECT signature,procedure.oid IS NOT NULL AS present,
      procedure.proowner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='platform.hotel_setup_property_scopes'::regclass) AS expected_owner,
      pg_catalog.has_function_privilege(parent.oid,procedure.oid,'EXECUTE') AS parent_execute,
      pg_catalog.has_function_privilege(parent.oid,procedure.oid,'EXECUTE WITH GRANT OPTION') AS parent_grant
      FROM pg_catalog.unnest($1::text[]) required(signature)
      LEFT JOIN pg_catalog.pg_proc procedure ON procedure.oid=CASE WHEN signature='platform.hotel_setup_reader_audit_allowed(platform.product_audit_events)' AND pg_catalog.to_regclass('platform.product_audit_events') IS NULL THEN NULL ELSE pg_catalog.to_regprocedure(signature) END
      LEFT JOIN pg_catalog.pg_roles parent ON parent.rolname=$2 ORDER BY signature`, [helpers,roles[2]])).rows,
  };
  stage = 'bootstrap_attempts';
  const scopeColumns = ['database_login','property_id','organization_id','actor_user_id','operation_class','active','credential_role_oid','credential_secret_version','credential_ready_at'];
  const scopeCatalog = (await client.query(`SELECT count(*)::int AS columns,
    pg_catalog.has_table_privilege(current_user,'platform.hotel_setup_property_scopes','SELECT') AS readable
    FROM pg_catalog.pg_attribute WHERE attrelid='platform.hotel_setup_property_scopes'::regclass AND attname=ANY($1) AND attnum>0 AND NOT attisdropped`, [scopeColumns])).rows[0];
  const passwordReadable = (await client.query(`SELECT pg_catalog.has_column_privilege(current_user,'pg_catalog.pg_authid','oid','SELECT')
    AND pg_catalog.has_column_privilege(current_user,'pg_catalog.pg_authid','rolpassword','SELECT') AS allowed`)).rows[0].allowed;
  const authorityTables = {
    'identity.users': ['id','status'], 'identity.organizations': ['id','kind','status'],
    'identity.organization_memberships': ['id','user_id','organization_id','status','role_key','permission_overrides','role_definition_id','property_access_mode','access_origin','pms_access_enabled','booking_access_enabled'],
    'identity.organization_roles': ['id','organization_id','security_class','base_role_key','preset_key','default_permissions'],
    'identity.role_permission_grants': ['organization_kind','role_key','permission_key'],
    'identity.membership_property_assignments': ['membership_id','property_id'],
    'identity.organization_resource_links': ['organization_id','product','resource_type','resource_id','relationship','status'],
    'hotel_catalog.properties': ['id'],
  };
  const authorityColumns = Object.entries(authorityTables).flatMap(([table,columns]) => columns.map(column => ({table_name:table,column_name:column})));
  const authorityReadable = (await client.query(`SELECT bool_and(COALESCE(pg_catalog.has_column_privilege(current_user,relation.oid,attribute.attnum,'SELECT'),false)) AS allowed
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) required(table_name text,column_name text)
    LEFT JOIN pg_catalog.pg_class relation ON relation.oid=pg_catalog.to_regclass(required.table_name)
    LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attname=required.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped`, [JSON.stringify(authorityColumns)])).rows[0].allowed;
  inspection.logoBootstraps = [];
  for (const owner of owners) {
    const attempt = {owner: owner.owner, passwordPresenceReadable: passwordReadable, authorityReadable};
    if (authorityReadable) attempt.authority = (await client.query(`SELECT
      EXISTS(SELECT 1 FROM identity.users WHERE id=$3::uuid AND status='active') AS actor_active,
      EXISTS(SELECT 1 FROM identity.organizations WHERE id=$2::uuid AND kind='hotel_group' AND status='active') AS organization_active,
      EXISTS(SELECT 1 FROM hotel_catalog.properties WHERE id=$1::uuid) AS property_present,
      EXISTS(SELECT 1 FROM identity.organization_resource_links WHERE organization_id=$2::uuid AND product='hotel_catalog'
        AND resource_type='property' AND lower(resource_id)=$1::uuid::text AND relationship='owner' AND status='active') AS owner_link,
      (SELECT count(*)::int FROM identity.organization_memberships WHERE organization_id=$2::uuid AND user_id=$3::uuid AND status='active') AS membership_count,
      EXISTS(SELECT 1 FROM identity.organization_memberships WHERE organization_id=$2::uuid AND user_id=$3::uuid AND status='active'
        AND pms_access_enabled IS NOT NULL AND booking_access_enabled IS NOT NULL) AS product_flags_valid,
      EXISTS(SELECT 1 FROM identity.organization_memberships member LEFT JOIN identity.organization_roles definition
        ON definition.id=member.role_definition_id AND definition.organization_id=member.organization_id
        WHERE member.organization_id=$2::uuid AND member.user_id=$3::uuid AND member.status='active' AND member.role_key='hotel_owner'
        AND (member.permission_overrides IS NULL OR member.permission_overrides='{"grant":[],"deny":[]}'::jsonb)
        AND (member.role_definition_id IS NULL OR (definition.security_class='account_admin' AND definition.base_role_key='hotel_owner'
          AND definition.preset_key='account_admin' AND definition.default_permissions='[]'::jsonb))) AS exact_owner_membership,
      EXISTS(SELECT 1 FROM identity.organization_memberships member WHERE member.organization_id=$2::uuid AND member.user_id=$3::uuid AND member.status='active' AND member.access_origin='agency'
        AND (member.property_access_mode='all' OR (member.property_access_mode='assigned' AND EXISTS(
          SELECT 1 FROM identity.membership_property_assignments WHERE membership_id=member.id AND property_id=$1::uuid)))) AS property_access,
      EXISTS(SELECT 1 FROM identity.role_permission_grants WHERE organization_kind='hotel_group' AND role_key='hotel_owner'
        AND permission_key='hotel_catalog.setup.manage') AS setup_permission`, [owner.property,owner.organization,owner.actor])).rows[0];
    const staged = (await client.query(`SELECT role.oid,role.rolname,role.rolcanlogin,role.rolsuper,role.rolcreaterole,role.rolcreatedb,role.rolinherit,role.rolreplication,role.rolbypassrls,
      role.rolconfig IS NOT NULL AS has_settings,role.rolvaliduntil IS NOT NULL AS has_expiry,count(*) OVER()::int AS total,
      (SELECT count(*)::int FROM pg_catalog.pg_auth_members WHERE member=role.oid) AS outgoing_memberships,
      (SELECT count(*)::int FROM pg_catalog.pg_auth_members WHERE roleid=role.oid) AS incoming_memberships,
      (SELECT count(*)::int FROM pg_catalog.pg_auth_members edge JOIN pg_catalog.pg_roles parent ON parent.oid=edge.roleid
        WHERE edge.member=role.oid AND parent.rolname=$2 AND edge.inherit_option AND NOT edge.set_option AND NOT edge.admin_option) AS exact_scope_edges
      FROM pg_catalog.pg_roles role WHERE pg_catalog.left(role.rolname::text,length($1))=$1 ORDER BY role.oid LIMIT 5`, [owner.prefix,roles[2]])).rows;
    const passwords = passwordReadable && staged.length ? (await client.query('SELECT oid,rolpassword IS NOT NULL AS present FROM pg_catalog.pg_authid WHERE oid=ANY($1::oid[])', [staged.map(role => role.oid)])).rows : [];
    attempt.roles = {total: staged[0]?.total ?? 0, entries: staged.map(({rolname,total,...role}) => ({...role, ...roleName(rolname), passwordPresent: passwords.find(entry => entry.oid===role.oid)?.present ?? null}))};
    attempt.scopes = {columnsPresent: scopeCatalog.columns===scopeColumns.length, readable: scopeCatalog.readable};
    if (attempt.scopes.columnsPresent && attempt.scopes.readable) {
      const scopes = (await client.query(`SELECT scope.database_login::text AS login,scope.property_id=$1::uuid AS property_matches,
        scope.organization_id=$2::uuid AS organization_matches,scope.actor_user_id=$3::uuid AS actor_matches,
        scope.operation_class='property_logo' AS operation_matches,scope.active,scope.credential_role_oid AS credential_role_oid,
        scope.credential_role_oid=role.oid AS role_oid_matches,scope.credential_secret_version,
        scope.credential_ready_at IS NOT NULL AS ready_at_present,count(*) OVER()::int AS total
        FROM platform.hotel_setup_property_scopes scope LEFT JOIN pg_catalog.pg_roles role ON role.rolname=scope.database_login
        WHERE (scope.property_id=$1::uuid AND scope.operation_class='property_logo') OR pg_catalog.left(scope.database_login::text,length($4))=$4
        ORDER BY scope.database_login LIMIT 5`, [owner.property,owner.organization,owner.actor,owner.prefix])).rows;
      attempt.scopes.total = scopes[0]?.total ?? 0;
      attempt.scopes.entries = scopes.map(({login,total,credential_secret_version,...scope}) => ({...scope, login: roleName(login), secretVersionPresent: credential_secret_version!==null,
        secretVersion: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(credential_secret_version ?? '') ? credential_secret_version : null}));
    }
    inspection.logoBootstraps.push(attempt);
  }
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
