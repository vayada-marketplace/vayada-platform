import pg from "pg";

const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
let client;
try {
  const raw = process.env.TARGET_DATABASE_ADMIN_URL;
  if (!raw) throw new Error("cluster_database_acl_inspection_secret_missing");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" || url.hostname !== expectedHost ||
      url.port !== "5432" || url.pathname !== "/postgres" ||
      url.username !== "vayada_admin" || !url.password || url.hash ||
      url.search !== "?sslmode=require" || !process.env.VAYADA_DB_RDS_CA_BUNDLE)
    throw new Error("cluster_database_acl_inspection_endpoint_untrusted");
  url.pathname = "/vayada_target_prod";
  url.search = "";
  client = new pg.Client({
    connectionString: url.toString(),
    ssl: { ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true,
      servername: url.hostname },
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const result = await client.query(`
    SELECT d.datname, a.privilege_type
      FROM pg_catalog.pg_database d
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
     WHERE d.datallowconn AND a.grantee = 0
       AND ((d.datname = pg_catalog.current_database()
             AND a.privilege_type IN ('CREATE', 'TEMPORARY'))
         OR (d.datname <> pg_catalog.current_database()
             AND a.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')))
     ORDER BY d.datname, a.privilege_type
  `);
  const acl = await client.query(`
    SELECT d.datname, pg_catalog.pg_get_userbyid(d.datdba) AS owner,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
           pg_catalog.pg_get_userbyid(a.grantor) AS grantor,
           a.privilege_type, a.is_grantable
      FROM pg_catalog.pg_database d
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
     WHERE d.datallowconn
     ORDER BY d.datname, grantee, a.privilege_type
  `);
  const activity = await client.query(`
    SELECT datname, usename, count(*)::integer AS connections
      FROM pg_catalog.pg_stat_activity
     WHERE datname IS NOT NULL AND usename IS NOT NULL
     GROUP BY datname, usename
     ORDER BY datname, usename
  `);
  const effective = await client.query(`
    SELECT r.rolname, d.datname,
           pg_catalog.has_database_privilege(r.oid, d.oid, 'CONNECT') AS connect,
           pg_catalog.has_database_privilege(r.oid, d.oid, 'TEMPORARY') AS temporary
      FROM pg_catalog.pg_roles r
      CROSS JOIN pg_catalog.pg_database d
     WHERE r.rolcanlogin AND d.datallowconn
       AND r.rolname !~ '^rds'
     ORDER BY r.rolname, d.datname
  `);
  const roles = await client.query(`
    SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
           r.rolinherit, r.rolbypassrls
      FROM pg_catalog.pg_roles r
     WHERE r.rolcanlogin AND r.rolname !~ '^rds'
     ORDER BY r.rolname
  `);
  const memberships = await client.query(`
    SELECT member.rolname AS member, parent.rolname AS parent,
           m.admin_option, m.inherit_option, m.set_option
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles member ON member.oid = m.member
      JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
     WHERE member.rolname !~ '^rds'
     ORDER BY member.rolname, parent.rolname
  `);
  console.log(JSON.stringify({ status: "PASS", publicDatabasePrivileges: result.rows,
    databasePrivileges: acl.rows, activeConnections: activity.rows,
    effectiveLoginAccess: effective.rows, loginRoles: roles.rows,
    roleMemberships: memberships.rows }));
} catch (error) {
  const expected = new Set([
    "cluster_database_acl_inspection_secret_missing",
    "cluster_database_acl_inspection_endpoint_untrusted",
  ]);
  console.error(JSON.stringify({ status: "FAIL",
    code: expected.has(error.message) ? error.message : error.code ?? "cluster_database_acl_inspection_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
