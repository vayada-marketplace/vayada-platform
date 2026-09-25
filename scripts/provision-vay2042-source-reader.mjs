import { randomBytes } from 'node:crypto';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { scramVerifier } from './vay2017-pg-scram.mjs';

export const reader = 'vay2042_source_reader_20260925';
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const relation = (value) => value.split('.').map(identifier).join('.');
const requireTrue = (condition, code) => { if (!condition) throw new Error(code); };
const applicationSchema = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";

// Evaluate effective privileges, including PUBLIC grants, not just this role's ACL entries.
export const privilegeSql = `
SELECT
  EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS membership,
  EXISTS (SELECT 1 FROM pg_shdepend s WHERE s.refclassid = 'pg_authid'::regclass
    AND s.refobjid = r.oid AND s.deptype = 'o') AS ownership,
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication
    OR r.rolbypassrls OR r.rolcanlogin OR r.rolconnlimit <> 4 AS attributes,
  EXISTS (SELECT 1 FROM pg_database d WHERE
    has_database_privilege(r.oid, d.oid, 'CREATE') OR
    (d.datallowconn AND has_database_privilege(r.oid, d.oid, 'TEMP'))) AS database_write,
  EXISTS (SELECT 1 FROM pg_namespace n WHERE ${applicationSchema}
    AND has_schema_privilege(r.oid, n.oid, 'CREATE')) AS schema_write,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${applicationSchema} AND c.relkind IN ('r','p','v','m','f') AND (
      has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES') OR
      ((has_table_privilege(r.oid, c.oid, 'SELECT') OR has_any_column_privilege(r.oid, c.oid, 'SELECT'))
       AND NOT (n.nspname || '.' || c.relname = ANY($2::text[])))
    )) AS relation_privileges,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE CASE WHEN ${applicationSchema} AND c.relkind = 'S'
      THEN has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END) AS sequence_privileges,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE ${applicationSchema} AND p.prosecdef AND p.prokind IN ('f','p')
      AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS definer_privileges,
  EXISTS (SELECT 1 FROM unnest($2::text[]) expected(name)
    WHERE NOT has_table_privilege(r.oid, expected.name, 'SELECT')) AS missing_read
FROM pg_roles r WHERE r.rolname = $1`;

async function verifyPrivileges(client, tables) {
  const result = await client.query(privilegeSql, [reader, tables]);
  requireTrue(result.rowCount === 1 && Object.values(result.rows[0]).every((v) => v === false),
    'source_reader_privilege_mismatch');
}

// The protected launcher supplies hostname-verified TLS clients bound to the exact
// restored RDS resource. No caller-supplied database, role or relation names.
export async function provisionSourceReader({ connect, persistCredential, now = () => Date.now() }) {
  const clients = new Map();
  const control = await connect('postgres');
  clients.set('postgres', control);
  const password = randomBytes(36).toString('base64url');
  let locked = false;
  try {
    locked = (await control.query('SELECT pg_try_advisory_lock(204220260925) AS locked')).rows[0]?.locked === true;
    requireTrue(locked, 'source_reader_bootstrap_busy');
    const databases = (await control.query(`SELECT datname FROM pg_database
      WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin' ORDER BY datname`)).rows.map((r) => r.datname);
    requireTrue(JSON.stringify(databases) === JSON.stringify(manifest.databases), 'restore_database_inventory_changed');
    requireTrue((await control.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [reader])).rowCount === 0,
      'source_reader_exists_inspect_prior_attempt');

    // Validate the complete four-source relation inventory before creating anything.
    for (const database of databases) {
      const client = database === 'postgres' ? control : await connect(database);
      clients.set(database, client);
      const source = manifest.sources.find((s) => s.database === database);
      if (!source) continue;
      const tables = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${applicationSchema} AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((r) => r.name);
      requireTrue(JSON.stringify(tables) === JSON.stringify(source.tables), 'source_table_inventory_changed');
    }
    await control.query('BEGIN');
    try {
      const expiresAt = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
      const command = (await control.query(`SELECT format(
        'CREATE ROLE %I NOLOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 VALID UNTIL %L',
        $1::text, $2::text, $3::text) AS sql`, [reader, scramVerifier(password), expiresAt])).rows[0].sql;
      await control.query(command);
      await control.query(`ALTER ROLE ${identifier(reader)} SET default_transaction_read_only = on`);
      await control.query(`ALTER ROLE ${identifier(reader)} SET statement_timeout = '60s'`);
      await control.query(`ALTER ROLE ${identifier(reader)} SET idle_in_transaction_session_timeout = '60s'`);
      await control.query('COMMIT');
    } catch (error) {
      await control.query('ROLLBACK');
      throw error;
    }
    // Never change PUBLIC ACLs or existing roles to force a passing check.
    for (const [database, client] of clients) {
      const source = manifest.sources.find((s) => s.database === database);
      await client.query('BEGIN');
      try {
        await verifyPrivileges(client, []);
        if (source) {
          await client.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(reader)}`);
          for (const schema of new Set(source.tables.map((t) => t.split('.')[0]))) {
            await client.query(`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(reader)}`);
          }
          await client.query(`GRANT SELECT ON TABLE ${source.tables.map(relation).join(',')} TO ${identifier(reader)}`);
        }
        await verifyPrivileges(client, source?.tables ?? []);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    // Partial failures retain a NOLOGIN role for explicit inspection, never an
    // active unverified account or a destructive automatic recovery.
    for (const [database, client] of clients) {
      await verifyPrivileges(client, manifest.sources.find((s) => s.database === database)?.tables ?? []);
    }
    await persistCredential({ username: reader, password });
    try {
      await control.query(`ALTER ROLE ${identifier(reader)} LOGIN`);
    } catch {
      // A lost acknowledgement may follow a committed activation. Never claim
      // NOLOGIN or permit an automatic retry after this indeterminate outcome.
      throw new Error('source_reader_activation_outcome_unknown');
    }
    return { status: 'OK', scope: 'isolated-source-reader', databases: 4, tables: 83 };
  } finally {
    if (locked) await control.query('SELECT pg_advisory_unlock(204220260925)').catch(() => {});
    await Promise.all([...clients.values()].map((client) => client.end().catch(() => {})));
  }
}
