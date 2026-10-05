import pg from 'pg';

// Catalog evidence only. This never creates a role, grants a privilege or reads a secret value.
let client;
try {
  const url = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
      url.port !== '5432' || url.username !== 'vayada_admin' || !url.password || url.hash ||
      url.pathname !== '/postgres' || url.search !== '?sslmode=require' || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error();
  const [{ HOTEL_SETUP_CREATION_PRIVILEGES }, { HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES },
    { HOTEL_SETUP_CURRENCY_READY_PRIVILEGES }, { HOTEL_SETUP_FEATURE_HUB_PRIVILEGES }] = await Promise.all([
    import('/app/apps/api/dist/hotelSetupCreationPrivileges.js'),
    import('/app/apps/api/dist/hotelSetupLaunchSettingsPrivileges.js'),
    import('/app/apps/api/dist/hotelSetupCurrencyPrivileges.js'),
    import('/app/apps/api/dist/hotelSetupFeatureHubPrivileges.js'),
  ]);
  const inventories = [HOTEL_SETUP_CREATION_PRIVILEGES, HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES,
    HOTEL_SETUP_CURRENCY_READY_PRIVILEGES, HOTEL_SETUP_FEATURE_HUB_PRIVILEGES];
  url.pathname = '/vayada_target_prod';
  client = new pg.Client({ connectionString: url.href.replace('?sslmode=require', ''),
    connectionTimeoutMillis: 10000, query_timeout: 15000,
    ssl: { rejectUnauthorized: true, ca: process.env.VAYADA_DB_RDS_CA_BUNDLE } });
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  const identity = (await client.query(`SELECT current_user AS principal, session_user AS session,
    current_database() AS database, pg_is_in_recovery() AS replica,
    current_setting('transaction_read_only') AS read_only,
    current_setting('createrole_self_grant') AS self_grant,
    r.rolsuper, r.rolcreaterole, r.rolbypassrls,
    has_table_privilege(current_user,'pg_catalog.pg_authid','SELECT') AS protected_catalog_read
    FROM pg_catalog.pg_roles r WHERE rolname=current_user`)).rows;
  if (identity.length !== 1 || identity[0].principal !== 'vayada_admin' ||
      identity[0].session !== identity[0].principal || identity[0].database !== 'vayada_target_prod' ||
      identity[0].replica !== false || identity[0].read_only !== 'on') throw new Error();
  const missing = [];
  const requirePrivilege = async (sql, parameters, description) => {
    const rows = (await client.query(sql, parameters)).rows;
    if (rows.length !== 1 || rows[0].allowed !== true) missing.push(description);
  };
  await requirePrivilege("SELECT has_database_privilege(current_user,current_database(),'CONNECT WITH GRANT OPTION') AS allowed", [], 'database CONNECT grant');
  for (const parent of ['vayada_next_hotel_setup_scope', 'vayada_next_hotel_setup_property_scope'])
    await requirePrivilege(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
      WHERE m.member=current_user::regrole::oid AND r.rolname=$1 AND m.admin_option) AS allowed`, [parent], `${parent} ADMIN`);
  const schemas = new Set();
  const grants = new Set();
  for (const inventory of inventories)
    for (const [relation, privileges] of Object.entries(inventory)) {
      if (!/^[a-z_]+\.[a-z_]+$/.test(relation)) throw new Error();
      schemas.add(relation.split('.')[0]);
      for (const [privilege, columns] of Object.entries(privileges))
        for (const column of columns) {
          if (!['SELECT','INSERT','UPDATE','REFERENCES'].includes(privilege) || !/^[a-z_]+$/.test(column)) throw new Error();
          const key = `${relation}.${column} ${privilege}`;
          if (grants.has(key)) continue;
          grants.add(key);
          await requirePrivilege('SELECT has_column_privilege(current_user,$1,$2,$3) AS allowed',
            [relation, column, `${privilege} WITH GRANT OPTION`], key);
        }
    }
  for (const schema of schemas)
    await requirePrivilege("SELECT has_schema_privilege(current_user,$1,'USAGE WITH GRANT OPTION') AS allowed", [schema], `${schema} USAGE grant`);
  await requirePrivilege("SELECT has_table_privilege(current_user,'hotel_catalog.property_contact_channels','DELETE WITH GRANT OPTION') AS allowed", [], 'contact DELETE grant');
  for (const relation of ['platform.hotel_setup_creation_scopes', 'platform.hotel_setup_property_scopes',
    'platform.hotel_setup_reconciliation_cursors'])
    for (const privilege of ['SELECT','INSERT','UPDATE'])
      await requirePrivilege('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [relation, privilege], `${relation} ${privilege}`);
  const helpers = (await client.query(`SELECT p.oid::regprocedure::text AS signature,
    p.proowner='vayada_target_prod_user'::regrole::oid AS canonical_owner,
    NOT p.prosecdef AS invoker,
    has_function_privilege('vayada_target_prod_user',p.oid,'EXECUTE WITH GRANT OPTION') AS owner_grant
    FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY p.oid`, [[
    'platform.channex_management_worker_scope(text,text,uuid)',
    'platform.channex_management_worker_source(text,text,uuid)',
  ]])).rows;
  const owner = (await client.query(`SELECT NOT rolsuper AS nonsuperuser,
    NOT has_table_privilege(rolname,'pg_catalog.pg_authid','SELECT') AS no_protected_catalog_read
    FROM pg_catalog.pg_roles WHERE rolname='vayada_target_prod_user'`)).rows;
  const checks = {
    nonsuperuser: identity[0].rolsuper === false,
    createRole: identity[0].rolcreaterole === true,
    noProtectedCatalogRead: identity[0].protected_catalog_read === false,
    noSelfInheritanceOrSet: identity[0].self_grant === '',
    grants: missing.length === 0,
    helperOwner: helpers.length === 2 && helpers.every(row => row.canonical_owner === true && row.invoker === true && row.owner_grant === true) &&
      owner.length === 1 && owner[0].nonsuperuser === true && owner[0].no_protected_catalog_read === true,
  };
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ status: 'PASS', audit: 'hotel_setup_automatic_authority',
    catalogGrantAuthority: Object.values(checks).every(value => value === true), checks, missing,
    helperAuthentication: 'NOT_CHECKED', nativeProvisioning: 'NOT_EXECUTED', dataWrites: false }));
} catch {
  console.error(JSON.stringify({ status: 'FAIL', code: 'hotel_setup_automatic_authority_audit_unavailable' }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
