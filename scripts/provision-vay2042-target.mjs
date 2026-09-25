import { randomBytes } from 'node:crypto';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { privilegeSql } from './provision-vay2042-source-reader.mjs';
import { scramVerifier } from './vay2017-pg-scram.mjs';

export const target = 'vay2042_target_rehearsal_20260925';
export const writer = 'vay2042_target_writer_20260925';
export const attestor = 'vayada_migration_attestor';
const ident = (v) => `"${v.replaceAll('"', '""')}"`;
const requireTrue = (v, code) => { if (!v) throw new Error(code); };

async function verifyOldDatabase(client) {
  // Reuse the source reader's effective ACL, membership, ownership and definer
  // checks with no readable relations. Only the fresh database may allow CREATE.
  const result = await client.query(privilegeSql, [writer, []]);
  const { database_write, ...checks } = result.rows[0] ?? {};
  requireTrue(result.rowCount === 1 && Object.values(checks).every((v) => v === false), 'target_writer_privilege_mismatch');
  requireTrue((await client.query(`SELECT 1 FROM pg_database WHERE datname <> $1 AND
    (has_database_privilege($2, oid, 'CREATE') OR
     (datallowconn AND has_database_privilege($2, oid, 'TEMP')))` , [target, writer])).rowCount === 0,
  'target_writer_other_database_write');
  requireTrue((await client.query(`SELECT 1 FROM pg_proc WHERE proowner =
    (SELECT oid FROM pg_roles WHERE rolname=$1)`, [attestor])).rowCount === 0, 'target_attestor_owns_routine');
}

async function verifyAttestor(client) {
  const result = await client.query(`SELECT NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
    OR rolinherit OR rolreplication OR rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid=r.oid AND inherit_option)
    AND pg_has_role(current_user, r.oid, 'SET') AS valid
    FROM pg_roles r WHERE rolname=$1`, [attestor]);
  requireTrue(result.rows[0]?.valid === true, 'target_attestor_untrusted');
}

// The separate protected launcher verifies the exact restored resource, private
// network and TLS. This core has no caller-selectable database or role names.
export async function provisionTarget({ connect, persistCredential, now = () => Date.now() }) {
  const clients = new Map();
  const control = await connect('postgres');
  clients.set('postgres', control);
  let locked = false;
  try {
    locked = (await control.query('SELECT pg_try_advisory_lock(204220260925) AS locked')).rows[0]?.locked === true;
    requireTrue(locked, 'target_bootstrap_busy');
    requireTrue((await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [writer])).rowCount === 0,
      'target_writer_exists_inspect_prior_attempt');
    requireTrue((await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount === 0,
      'target_database_exists_inspect_prior_attempt');
    const databases = (await control.query(`SELECT datname FROM pg_database
      WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin' ORDER BY datname`)).rows.map((r) => r.datname);
    requireTrue(JSON.stringify(databases) === JSON.stringify(manifest.databases), 'restore_database_inventory_changed');
    for (const database of databases) {
      if (database !== 'postgres') clients.set(database, await connect(database));
      requireTrue((await clients.get(database).query('SELECT current_database() AS name')).rows[0]?.name === database,
        'target_database_connection_mismatch');
    }
    const password = randomBytes(36).toString('base64url');
    await control.query('BEGIN');
    try {
      if ((await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [attestor])).rowCount === 0) {
        await control.query(`CREATE ROLE ${ident(attestor)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
        await control.query(`GRANT ${ident(attestor)} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
      }
      await verifyAttestor(control);
      const command = (await control.query(`SELECT format(
        'CREATE ROLE %I NOLOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 VALID UNTIL %L',
        $1::text,$2::text,$3::text) AS sql`, [writer, scramVerifier(password), new Date(now() + 86_400_000).toISOString()])).rows[0].sql;
      await control.query(command);
      await control.query('COMMIT');
    } catch (error) { await control.query('ROLLBACK'); throw error; }
    for (const client of clients.values()) await verifyOldDatabase(client);
    // template0 cannot copy a previous target. Deny connections until PUBLIC's
    // default CONNECT/TEMP privileges have been removed on this new database only.
    await control.query(`CREATE DATABASE ${ident(target)} TEMPLATE template0 ALLOW_CONNECTIONS false`);
    await control.query(`REVOKE ALL ON DATABASE ${ident(target)} FROM PUBLIC`);
    await control.query(`ALTER DATABASE ${ident(target)} ALLOW_CONNECTIONS true`);
    const fresh = await connect(target);
    clients.set(target, fresh);
    requireTrue((await fresh.query('SELECT current_database() AS name')).rows[0]?.name === target, 'target_database_connection_mismatch');
    requireTrue((await fresh.query(`SELECT 1 FROM pg_namespace WHERE nspname <> 'public'
      AND nspname <> 'information_schema' AND nspname !~ '^pg_'
      UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
      UNION ALL SELECT 1 FROM pg_default_acl`)).rowCount === 0, 'target_template_not_clean');
    await fresh.query('BEGIN');
    try {
      await fresh.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await fresh.query(`GRANT CONNECT, CREATE ON DATABASE ${ident(target)} TO ${ident(writer)}`);
      await fresh.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${ident(writer)}`);
      await fresh.query(`CREATE SCHEMA vayada_migration_evidence AUTHORIZATION ${ident(attestor)}`);
      await fresh.query(`SET LOCAL ROLE ${ident(attestor)}`);
      await fresh.query(`REVOKE ALL ON SCHEMA vayada_migration_evidence FROM PUBLIC;
        CREATE TABLE vayada_migration_evidence.database_attestations (
          attestation_key text PRIMARY KEY, attestation_value text NOT NULL,
          attested_at timestamptz NOT NULL DEFAULT now());
        REVOKE ALL ON vayada_migration_evidence.database_attestations FROM PUBLIC;
        GRANT USAGE ON SCHEMA vayada_migration_evidence TO ${ident(writer)};
        GRANT SELECT ON vayada_migration_evidence.database_attestations TO ${ident(writer)}`);
      await fresh.query('COMMIT');
    } catch (error) { await fresh.query('ROLLBACK'); throw error; }
    for (const database of databases) await verifyOldDatabase(clients.get(database));
    await verifyAttestor(fresh);
    const boundary = (await fresh.query(`SELECT
      NOT pg_has_role($1, $2, 'MEMBER')
      AND NOT has_schema_privilege($1, n.oid, 'CREATE')
      AND has_table_privilege($1, c.oid, 'SELECT')
      AND NOT has_table_privilege($1, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_any_column_privilege($1, c.oid, 'INSERT,UPDATE,REFERENCES')
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname=$2) AND n.nspowner=c.relowner
      AND has_database_privilege($1, current_database(), 'CONNECT')
      AND has_database_privilege($1, current_database(), 'CREATE')
      AND NOT has_database_privilege($1, current_database(), 'TEMP') AS valid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='vayada_migration_evidence' AND c.relname='database_attestations'`, [writer, attestor])).rows[0];
    requireTrue(boundary?.valid === true, 'target_evidence_boundary_mismatch');
    await persistCredential({ username: writer, password, database: target });
    try { await control.query(`ALTER ROLE ${ident(writer)} LOGIN`); }
    catch { throw new Error('target_writer_activation_outcome_unknown'); }
    return { status: 'OK', scope: 'isolated-fresh-target', bound: false };
  } finally {
    if (locked) await control.query('SELECT pg_advisory_unlock(204220260925)').catch(() => {});
    await Promise.all([...clients.values()].map((client) => client.end().catch(() => {})));
  }
}
