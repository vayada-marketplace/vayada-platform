import { readFileSync } from 'node:fs';
import pg from 'pg';

const PHASES = new Set(['prepare', 'cleanup']);
const PHASE = process.env.VAY2017_SOURCE_IMPORT_PHASE;
const HOST = 'vay2017-source-import-20260929.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com';
const SNAPSHOT = 'arn:aws:rds:eu-west-1:269416271598:snapshot:vay2017-legacy-source-20260929';
const RUN_ID = 'vay1351-61ec013e79ed2a042caadef8';
const READER = 'vay2017_source_reader_20260929';
const ATTESTOR = 'vayada_migration_attestor';
const DATABASES = {
  auth: 'vayada_auth_db',
  booking: 'vayada_booking_db',
  marketplace: 'postgres',
  pms: 'vayada_pms_db',
};
const MARKER = 'vayada:vay2017-source-import:20260929';
const ATTESTOR_MARKER = `${MARKER}:attestor`;
const INVENTORY = '/app/packages/backend-migration/source-inventory.tsv';
const HISTORICAL = '/app/packages/backend-migration/raw-source-dispositions.tsv';
const CA = process.env.VAYADA_DB_RDS_CA_BUNDLE;

const fail = (code) => {
  throw new Error(code);
};
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const relation = (value) => value.split('.').map(identifier).join('.');
const requireExactUrl = (raw, username) => {
  const url = new URL(raw ?? '');
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== HOST ||
    url.port !== '5432' ||
    url.pathname !== '/postgres' ||
    url.username !== username ||
    !url.password ||
    url.search !== '?sslmode=require' ||
    url.hash
  ) fail('source_import_url_invalid');
  return url;
};
const sourceAdminUrl = () => {
  const url = new URL(process.env.VAY2017_SOURCE_ADMIN_URL ?? '');
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
    url.port !== '5432' ||
    url.pathname !== '/postgres' ||
    url.username !== 'vayada_admin' ||
    !url.password ||
    url.search !== '?sslmode=require' ||
    url.hash
  ) fail('source_admin_url_invalid');
  url.hostname = HOST;
  return url;
};
const connect = async (base, database) => {
  const url = new URL(base);
  url.pathname = `/${database}`;
  url.search = '';
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: { ca: CA, rejectUnauthorized: true, servername: HOST },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
};
const sourceTables = () => {
  const result = Object.fromEntries(Object.keys(DATABASES).map((name) => [name, []]));
  for (const line of readFileSync(INVENTORY, 'utf8').trim().split('\n').slice(1)) {
    const [database, objectType, objectName, lifecycle] = line.split('\t');
    if (objectType === 'table' && lifecycle === 'active') result[database].push(objectName);
  }
  for (const line of readFileSync(HISTORICAL, 'utf8').trim().split('\n').slice(1)) {
    const [database, objectName] = line.split('\t');
    result[database].push(objectName);
  }
  for (const tables of Object.values(result)) tables.sort();
  if (Object.values(result).flat().length !== 83) fail('source_inventory_invalid');
  return result;
};

async function prepare() {
  const adminBase = sourceAdminUrl();
  const readerUrl = requireExactUrl(process.env.VAY2017_SOURCE_READER_URL, READER);
  const tables = sourceTables();
  const control = await connect(adminBase, 'postgres');
  let locked = false;
  try {
    locked = (await control.query('SELECT pg_try_advisory_lock(201720260929) AS locked')).rows[0]?.locked === true;
    if (!locked) fail('source_import_busy');
    const existing = await control.query(
      `SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
              shobj_description(oid,'pg_authid') AS marker
         FROM pg_roles WHERE rolname=$1`,
      [READER],
    );
    if (existing.rowCount) fail('source_reader_exists');
    const attestor = await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [ATTESTOR]);
    if (attestor.rowCount) fail('source_attestor_exists');
    await control.query('BEGIN');
    try {
      await control.query(
        `CREATE ROLE ${identifier(ATTESTOR)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await control.query(`COMMENT ON ROLE ${identifier(ATTESTOR)} IS '${ATTESTOR_MARKER}'`);
      await control.query(
        `GRANT ${identifier(ATTESTOR)} TO ${identifier('vayada_admin')} WITH INHERIT FALSE, SET TRUE`,
      );
      const expires = new Date(Date.now() + 75 * 60 * 1000).toISOString();
      const create = (
        await control.query(
          `SELECT format('CREATE ROLE %I NOLOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 VALID UNTIL %L', $1::text,$2::text,$3::text) AS sql`,
          [READER, decodeURIComponent(readerUrl.password), expires],
        )
      ).rows[0]?.sql;
      await control.query(create);
      await control.query(`COMMENT ON ROLE ${identifier(READER)} IS '${MARKER}'`);
      await control.query(`ALTER ROLE ${identifier(READER)} SET default_transaction_read_only=on`);
      await control.query(`ALTER ROLE ${identifier(READER)} SET statement_timeout='60s'`);
      await control.query(`ALTER ROLE ${identifier(READER)} SET idle_in_transaction_session_timeout='60s'`);
      await control.query('COMMIT');
    } catch (error) {
      await control.query('ROLLBACK');
      throw error;
    }

    for (const [source, database] of Object.entries(DATABASES)) {
      const client = database === 'postgres' ? control : await connect(adminBase, database);
      try {
        const present = await client.query(
          `SELECT n.nspname||'.'||c.relname AS name
             FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE c.relkind IN ('r','p') AND n.nspname<>ALL('{information_schema,pg_catalog,vayada_migration_evidence}'::text[])
              AND n.nspname!~'^pg_toast' ORDER BY 1`,
        );
        const expected = tables[source];
        if (JSON.stringify(present.rows.map((row) => row.name)) !== JSON.stringify(expected))
          fail('source_table_inventory_changed');
        await client.query('BEGIN');
        try {
          await client.query(`CREATE SCHEMA vayada_migration_evidence AUTHORIZATION ${identifier(ATTESTOR)}`);
          await client.query(`SET LOCAL ROLE ${identifier(ATTESTOR)}`);
          await client.query('REVOKE ALL ON SCHEMA vayada_migration_evidence FROM PUBLIC');
          await client.query(`CREATE TABLE vayada_migration_evidence.database_attestations (
            attestation_key text PRIMARY KEY, attestation_value text NOT NULL,
            attested_at timestamptz NOT NULL DEFAULT now())`);
          await client.query('REVOKE ALL ON vayada_migration_evidence.database_attestations FROM PUBLIC');
          await client.query(
            `INSERT INTO vayada_migration_evidence.database_attestations(attestation_key,attestation_value)
             VALUES ('vayada.source_snapshot_identifier',$1)`,
            [SNAPSHOT],
          );
          await client.query(`GRANT USAGE ON SCHEMA vayada_migration_evidence TO ${identifier(READER)}`);
          await client.query(
            `GRANT SELECT ON vayada_migration_evidence.database_attestations TO ${identifier(READER)}`,
          );
          await client.query('RESET ROLE');
          await client.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(READER)}`);
          for (const schema of new Set(expected.map((name) => name.split('.')[0])))
            await client.query(`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(READER)}`);
          await client.query(`GRANT SELECT ON TABLE ${expected.map(relation).join(',')} TO ${identifier(READER)}`);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } finally {
        if (client !== control) await client.end();
      }
    }
    await control.query(`ALTER ROLE ${identifier(READER)} LOGIN`);
    console.log(JSON.stringify({ status: 'prepared', runId: RUN_ID, databases: 4, tables: 83 }));
  } finally {
    if (locked) await control.query('SELECT pg_advisory_unlock(201720260929)').catch(() => {});
    await control.end().catch(() => {});
  }
}

async function cleanup() {
  const adminBase = sourceAdminUrl();
  const tables = sourceTables();
  const control = await connect(adminBase, 'postgres');
  try {
    const role = await control.query(
      `SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
              shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1`,
      [READER],
    );
    const readerExists = role.rowCount === 1;
    if (readerExists) {
      const found = role.rows[0];
      if (
        found.rolsuper || found.rolcreatedb || found.rolcreaterole || found.rolinherit ||
        found.rolreplication || found.rolbypassrls || found.marker !== MARKER
      ) fail('source_reader_cleanup_unsafe');
      await control.query(`ALTER ROLE ${identifier(READER)} NOLOGIN`);
    }
    const attestor = await control.query(
      `SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
              shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1`,
      [ATTESTOR],
    );
    const attestorExists = attestor.rowCount === 1;
    if (attestorExists) {
      const found = attestor.rows[0];
      if (
        found.rolcanlogin || found.rolsuper || found.rolcreatedb || found.rolcreaterole || found.rolinherit ||
        found.rolreplication || found.rolbypassrls || found.marker !== ATTESTOR_MARKER
      ) fail('source_attestor_cleanup_unsafe');
      const memberships = await control.query(
        `SELECT role.rolname AS role, member.rolname AS member
           FROM pg_auth_members membership
           JOIN pg_roles role ON role.oid=membership.roleid
           JOIN pg_roles member ON member.oid=membership.member
          WHERE membership.roleid=$1 OR membership.member=$1`,
        [found.oid],
      );
      if (
        memberships.rowCount !== 1 || memberships.rows[0]?.role !== ATTESTOR ||
        memberships.rows[0]?.member !== 'vayada_admin'
      ) fail('source_attestor_membership_cleanup_unsafe');
    }
    for (const [source, database] of Object.entries(DATABASES)) {
      const client = database === 'postgres' ? control : await connect(adminBase, database);
      try {
        await client.query('BEGIN');
        if (readerExists) {
          const present = await client.query(
            `SELECT name FROM unnest($1::text[]) expected(name) WHERE to_regclass(name) IS NOT NULL`,
            [tables[source]],
          );
          if (present.rowCount)
            await client.query(`REVOKE SELECT ON TABLE ${present.rows.map((row) => relation(row.name)).join(',')} FROM ${identifier(READER)}`);
          const expectedSchemas = [...new Set(tables[source].map((name) => name.split('.')[0]))];
          const presentSchemas = await client.query(
            `SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])`,
            [expectedSchemas],
          );
          for (const { nspname: schema } of presentSchemas.rows)
            await client.query(`REVOKE USAGE ON SCHEMA ${identifier(schema)} FROM ${identifier(READER)}`);
          await client.query(`REVOKE CONNECT ON DATABASE ${identifier(database)} FROM ${identifier(READER)}`);
        }
        const evidence = await client.query(
          `SELECT namespace.nspowner::regrole::text AS schema_owner,
                  relation.relname AS object_name, relation.relkind AS object_kind,
                  relation.relowner::regrole::text AS object_owner
             FROM pg_namespace namespace
             LEFT JOIN pg_class relation ON relation.relnamespace=namespace.oid
            WHERE namespace.nspname='vayada_migration_evidence'`,
        );
        if (evidence.rowCount) {
          const objects = new Map(evidence.rows.filter((row) => row.object_name).map((row) => [row.object_name, row]));
          const table = objects.get('database_attestations');
          const index = objects.get('database_attestations_pkey');
          if (
            !attestorExists || evidence.rows.some((row) => row.schema_owner !== ATTESTOR) ||
            ![0, 2].includes(objects.size) ||
            (objects.size === 2 && (
              table?.object_kind !== 'r' || table?.object_owner !== ATTESTOR ||
              index?.object_kind !== 'i' || index?.object_owner !== ATTESTOR
            ))
          ) fail('source_evidence_cleanup_unsafe');
          if (objects.size) await client.query('DROP TABLE vayada_migration_evidence.database_attestations');
          await client.query('DROP SCHEMA vayada_migration_evidence');
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        if (client !== control) await client.end();
      }
    }
    if (readerExists) await control.query(`DROP ROLE ${identifier(READER)}`);
    if (attestorExists) {
      await control.query(`REVOKE ${identifier(ATTESTOR)} FROM ${identifier('vayada_admin')}`);
      await control.query(`DROP ROLE ${identifier(ATTESTOR)}`);
    }
    console.log(JSON.stringify({ status: 'clean' }));
  } finally {
    await control.end().catch(() => {});
  }
}

try {
  if (!PHASES.has(PHASE) || !CA) fail('source_import_environment_invalid');
  if (PHASE === 'prepare') await prepare();
  else await cleanup();
} catch (error) {
  const code = /^[a-z0-9_]{3,64}$/.test(error?.message ?? '') ? error.message : 'source_import_failed';
  console.error(JSON.stringify({ status: 'FAIL', code }));
  process.exitCode = 1;
}
