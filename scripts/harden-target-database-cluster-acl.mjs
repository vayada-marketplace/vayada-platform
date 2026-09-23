import pg from "pg";

const expectedHost = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const productionDatabases = [
  ["postgres", "vayada_admin", ["CONNECT", "TEMPORARY"]],
  ["template1", "vayada_admin", ["CONNECT"]],
  ["vayada_auth_db", "vayada_auth_user", ["CONNECT", "TEMPORARY"]],
  ["vayada_booking_db", "vayada_admin", ["CONNECT", "TEMPORARY"]],
  ["vayada_pms_db", "vayada_admin", ["CONNECT", "TEMPORARY"]],
  ["vayada_pms_staging", "vayada_admin", ["CONNECT", "TEMPORARY"]],
  ["vayada_target_staging", "vayada_target_staging_user", ["CONNECT", "TEMPORARY"]],
  ["vayada_target_staging_12e19c65_01", "vayada_cutover_staging_20260903", ["CONNECT", "TEMPORARY"]],
  ["vayada_target_staging_12e19c65_02", "vayada_cutover_staging_20260903_02", ["CONNECT", "TEMPORARY"]],
];
const productionRoles = [
  "vayada_admin", "vayada_auth_user", "vayada_booking_user",
  "vayada_cutover_staging_20260903", "vayada_cutover_staging_20260903_02",
  "vayada_next_api_runtime", "vayada_pms_staging_user", "vayada_pms_user",
  "vayada_target_prod_user", "vayada_target_staging_user",
];
const productionAccess = new Map([
  ["vayada_auth_user", [["vayada_auth_db", true, true]]],
  ["vayada_booking_user", [["vayada_auth_db", true, false], ["vayada_booking_db", true, true]]],
  ["vayada_cutover_staging_20260903", [["vayada_target_staging_12e19c65_01", true, true]]],
  ["vayada_cutover_staging_20260903_02", [["vayada_target_staging_12e19c65_02", true, true]]],
  ["vayada_next_api_runtime", [["vayada_target_prod", true, false]]],
  ["vayada_pms_staging_user", [["vayada_pms_staging", true, true]]],
  ["vayada_pms_user", [["vayada_auth_db", true, false], ["vayada_pms_db", true, true]]],
  ["vayada_target_prod_user", [["vayada_target_prod", true, true]]],
  ["vayada_target_staging_user", [["vayada_target_staging", true, true]]],
]);

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const publicPrivileges = async (client) => (await client.query(`
  SELECT d.datname, pg_catalog.pg_get_userbyid(a.grantor) AS grantor,
         a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_database d
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
   WHERE d.datallowconn AND a.grantee = 0
     AND ((d.datname = pg_catalog.current_database()
           AND a.privilege_type IN ('CREATE', 'TEMPORARY'))
       OR (d.datname <> pg_catalog.current_database()
           AND a.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')))
   ORDER BY d.datname, a.privilege_type
`)).rows;

const assertExactAccess = async (client, roles, databases, access, admin) => {
  const expected = new Map();
  for (const role of roles) {
    for (const [database] of databases)
      expected.set(`${role}:${database}`, [role === admin, role === admin]);
    for (const [database, connect, temporary] of access.get(role) ?? [])
      expected.set(`${role}:${database}`, [connect, temporary]);
  }
  const actual = await client.query(`
    SELECT r.rolname, d.datname,
           pg_catalog.has_database_privilege(r.oid, d.oid, 'CONNECT') AS connect,
           pg_catalog.has_database_privilege(r.oid, d.oid, 'TEMPORARY') AS temporary
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d
     WHERE r.rolname = ANY($1::text[]) AND d.datname = ANY($2::text[])
  `, [roles, databases.map(([database]) => database)]);
  if (actual.rowCount !== expected.size) throw new Error("cluster_database_acl_matrix_incomplete");
  for (const { rolname, datname, connect, temporary } of actual.rows) {
    const wanted = expected.get(`${rolname}:${datname}`);
    if (!wanted || connect !== wanted[0] || temporary !== wanted[1])
      throw new Error("cluster_database_acl_effective_access_unexpected");
  }
};

let client;
try {
  const raw = process.env.TARGET_DATABASE_ADMIN_URL;
  if (!raw) throw new Error("cluster_database_acl_secret_missing");
  const url = new URL(raw);
  const local = process.env.VAYADA_CLUSTER_ACL_LOCAL_FIXTURE === "1" &&
    url.hostname === "vayada-cluster-acl-db" && url.search === "";
  if (!local && (url.protocol !== "postgresql:" || url.hostname !== expectedHost ||
      url.port !== "5432" || url.pathname !== "/postgres" ||
      url.username !== "vayada_admin" || !url.password || url.hash ||
      url.search !== "?sslmode=require" || !process.env.VAYADA_DB_RDS_CA_BUNDLE))
    throw new Error("cluster_database_acl_endpoint_untrusted");
  if (local && (url.protocol !== "postgresql:" || url.pathname !== "/vayada_target_prod" ||
      url.username !== "cluster_admin" || !url.password || url.hash))
    throw new Error("cluster_database_acl_endpoint_untrusted");
  const admin = local ? "cluster_admin" : "vayada_admin";
  const databases = local ? [
    ["postgres", admin, ["CONNECT", "TEMPORARY"]],
    ["template1", admin, ["CONNECT"]],
    ["service_db", "service_owner", ["CONNECT", "TEMPORARY"]],
  ] : productionDatabases;
  const roles = local ? [admin, "blocked_user", "service_user"] : productionRoles;
  const access = local ? new Map([["service_user", [["service_db", true, true]]]]) : productionAccess;
  const matrixDatabases = [...databases, ["vayada_target_prod", admin, []]];
  if (!local) {
    url.pathname = "/vayada_target_prod";
    url.search = "";
  }
  client = new pg.Client({ connectionString: url.toString(), ssl: local ? undefined : {
    ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname,
  }, connectionTimeoutMillis: 10_000, query_timeout: 15_000, statement_timeout: 15_000 });
  await client.connect();
  await client.query("SET search_path TO pg_catalog");
  const actualRoles = await client.query(`
    SELECT rolname FROM pg_catalog.pg_roles
     WHERE rolcanlogin AND rolname !~ '^rds' ${local ? "AND rolname <> 'postgres'" : ""}
     ORDER BY rolname
  `);
  if (JSON.stringify(actualRoles.rows.map(({ rolname }) => rolname)) !== JSON.stringify([...roles].sort()))
    throw new Error("cluster_database_acl_login_roles_unexpected");
  const owners = await client.query(`
    SELECT d.datname, pg_catalog.pg_get_userbyid(d.datdba) AS owner
      FROM pg_catalog.pg_database d WHERE d.datname = ANY($1::text[])
  `, [matrixDatabases.map(([database]) => database)]);
  const actualOwners = new Map(owners.rows.map(({ datname, owner }) => [datname, owner]));
  if (matrixDatabases.some(([database, owner]) => actualOwners.get(database) !== owner))
    throw new Error("cluster_database_acl_owner_unexpected");
  for (const owner of new Set(databases.map(([, owner]) => owner).filter((owner) => owner !== admin))) {
    const membership = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles member ON member.oid = m.member
        JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
        WHERE member.rolname = $1 AND parent.rolname = $2 AND m.set_option
      ) AS allowed
    `, [admin, owner]);
    if (!membership.rows[0]?.allowed) throw new Error("cluster_database_acl_owner_authority_missing");
  }
  const expectedPublic = databases.flatMap(([database, owner, privileges]) =>
    privileges.map((privilege) => `${database}:${owner}:${privilege}:false`)).sort();
  const before = await publicPrivileges(client);
  if (before.length === 0) {
    await assertExactAccess(client, roles, matrixDatabases, access, admin);
    console.log(JSON.stringify({ status: "PASS", changed: false, revoked: 0 }));
  } else {
    const actualPublic = before.map(({ datname, grantor, privilege_type, is_grantable }) =>
      `${datname}:${grantor}:${privilege_type}:${is_grantable}`).sort();
    if (JSON.stringify(actualPublic) !== JSON.stringify(expectedPublic))
      throw new Error("cluster_database_acl_unexpected");
    await client.query("BEGIN");
    for (const [database, owner, privileges] of databases) {
      if (owner !== admin) await client.query(`SET LOCAL ROLE ${quoteIdentifier(owner)}`);
      await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(admin)}`);
      await client.query(`REVOKE ${privileges.join(", ")} ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
      if (owner !== admin) await client.query("RESET ROLE");
    }
    if ((await publicPrivileges(client)).length)
      throw new Error("cluster_database_acl_public_access_remaining");
    await assertExactAccess(client, roles, matrixDatabases, access, admin);
    await client.query("COMMIT");
    console.log(JSON.stringify({ status: "PASS", changed: true, revoked: expectedPublic.length }));
  }
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  const expected = new Set([
    "cluster_database_acl_secret_missing", "cluster_database_acl_endpoint_untrusted",
    "cluster_database_acl_login_roles_unexpected", "cluster_database_acl_owner_unexpected",
    "cluster_database_acl_owner_authority_missing", "cluster_database_acl_unexpected",
    "cluster_database_acl_matrix_incomplete", "cluster_database_acl_effective_access_unexpected",
    "cluster_database_acl_public_access_remaining",
  ]);
  console.error(JSON.stringify({ status: "FAIL",
    code: expected.has(error.message) ? error.message : error.code ?? "cluster_database_acl_hardening_failed" }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
