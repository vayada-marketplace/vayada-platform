import pg from 'pg';
let client;
try {
  const email = process.env.HOTEL_SETUP_OWNER_EMAIL;
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error();
  const url = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
      url.port !== '5432' || url.username !== 'vayada_admin' || !url.password || url.hash ||
      url.pathname !== '/postgres' || url.search !== '?sslmode=require' || !process.env.VAYADA_DB_RDS_CA_BUNDLE) throw new Error();
  url.pathname = '/vayada_target_prod';
  // Explicit trusted root avoids relying on process-start NODE_EXTRA_CA_CERTS in this injected script.
  client = new pg.Client({ connectionString: url.href.replace('?sslmode=require', ''),
    ssl: { rejectUnauthorized: true, ca: process.env.VAYADA_DB_RDS_CA_BUNDLE } });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  const users = (await client.query('SELECT id,email FROM identity.users WHERE lower(email)=lower($1)', [email])).rows;
  const memberships = (await client.query(`SELECT membership.user_id,membership.organization_id,membership.role_key,
      membership.property_access_mode,membership.pms_access_enabled
    FROM identity.organization_memberships membership JOIN identity.users account ON account.id=membership.user_id
    WHERE lower(account.email)=lower($1) ORDER BY membership.organization_id`, [email])).rows;
  const properties = (await client.query(`SELECT DISTINCT property.id AS property_id,link.organization_id
    FROM identity.users account JOIN identity.organization_memberships member ON member.user_id=account.id
    JOIN identity.organization_resource_links link ON link.organization_id=member.organization_id
    JOIN hotel_catalog.properties property ON lower(link.resource_id)=property.id::text
    WHERE lower(account.email)=lower($1) AND link.product='hotel_catalog' AND link.resource_type='property'
      AND link.relationship='owner' AND link.status='active' ORDER BY property.id`, [email])).rows;
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ status: 'PASS', email, users, memberships, properties }));
} catch {
  console.error(JSON.stringify({ status: 'FAIL', code: 'hotel_setup_owner_audit_unavailable' }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
