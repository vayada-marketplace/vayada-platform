import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import proof from '../docs/vay2042-source-preservation-proof-20261001.json' with { type: 'json' };
import { configuration } from './launch-vay2042-source-reader.mjs';
import { privilegeSql, reader } from './provision-vay2042-source-reader.mjs';
import { attestor, target } from './provision-vay2042-target.mjs';

export const proofSha256 = 'acf9fb92b78057919ea92b947533fe458fdc1efc40d54db232e45b19933e0eda';
export const evidenceTable = 'vayada_migration_evidence.database_attestations';
const snapshot = proof.snapshotArn;
const requireTrue = (condition, code) => { if (!condition) throw new Error(code); };
const expectedDatabases = [...manifest.databases, target].sort();
const sourceDatabases = manifest.sources.map((source) => source.database);

async function verifySource(client, source, bound) {
  const hooks = (await client.query(`SELECT
    (SELECT count(*)::int FROM pg_event_trigger) AS event_triggers,
    (SELECT count(*)::int FROM pg_default_acl d JOIN pg_roles r ON r.oid=d.defaclrole
      WHERE r.rolname=$1) AS attestor_defaults`, [attestor])).rows[0];
  requireTrue(hooks?.event_triggers === 0 && hooks.attestor_defaults === 0,
    'source_ddl_hook_mismatch');
  const relations = (await client.query(`SELECT n.nspname || '.' || c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((row) => row.name);
  requireTrue(JSON.stringify(relations) === JSON.stringify(
    [...source.tables, ...(bound ? [evidenceTable] : [])].sort()), 'source_inventory_mismatch');
  const settings = await client.query(`SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) setting
    WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) AND s.setrole=0
      AND (setting LIKE 'vayada.source_snapshot_identifier=%'
        OR setting LIKE 'vayada.cutover_freeze_proof_sha256=%')`);
  requireTrue(settings.rowCount === 0, 'source_setting_conflict');
  const evidence = await client.query(`SELECT n.nspowner=r.oid AS schema_owner,
    c.relowner=r.oid AS table_owner, c.relkind='r' AND NOT c.relrowsecurity
      AND NOT c.relforcerowsecurity AS table_shape
    FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid
    JOIN pg_roles r ON r.rolname=$1
    WHERE n.nspname='vayada_migration_evidence' AND c.relname='database_attestations'`, [attestor]);
  requireTrue(evidence.rowCount === (bound ? 1 : 0), 'source_evidence_state_mismatch');
  if (bound) {
    requireTrue(Object.values(evidence.rows[0]).every((value) => value === true), 'source_evidence_owner_mismatch');
    await client.query('BEGIN READ ONLY');
    let rows;
    try {
      await client.query(`SET LOCAL ROLE "${attestor}"`);
      rows = (await client.query(`SELECT attestation_key,attestation_value
        FROM vayada_migration_evidence.database_attestations ORDER BY attestation_key`)).rows;
    } finally { await client.query('ROLLBACK'); }
    requireTrue(JSON.stringify(rows) === JSON.stringify([
      { attestation_key: 'vayada.cutover_freeze_proof_sha256', attestation_value: proofSha256 },
      { attestation_key: 'vayada.source_snapshot_identifier', attestation_value: snapshot },
    ]), 'source_evidence_value_mismatch');
  } else {
    const schema = await client.query("SELECT 1 FROM pg_namespace WHERE nspname='vayada_migration_evidence'");
    requireTrue(schema.rowCount === 0, 'source_evidence_state_mismatch');
  }
  const privileges = await client.query(privilegeSql, [reader,
    [...source.tables, ...(bound ? [evidenceTable] : [])]]);
  requireTrue(privileges.rowCount === 1 && Object.entries(privileges.rows[0]).every(
    ([key, value]) => value === (key === 'attributes')), 'source_reader_privilege_mismatch');
}

export async function bindSourceAttestation({ connect, now = () => Date.now() }) {
  const control = await connect('postgres', 'admin');
  let locked = false;
  let committed = 0;
  try {
    locked = (await control.query('SELECT pg_try_advisory_lock(204220260925) AS locked')).rows[0]?.locked === true;
    requireTrue(locked, 'source_binding_busy');
    const databases = (await control.query(`SELECT datname FROM pg_database
      WHERE datallowconn AND NOT datistemplate AND datname <> 'rdsadmin' ORDER BY datname`))
      .rows.map((row) => row.datname);
    requireTrue(JSON.stringify(databases) === JSON.stringify(expectedDatabases), 'database_inventory_mismatch');
    const roles = (await control.query(`SELECT rolname,rolcanlogin,rolconnlimit,rolsuper,rolcreatedb,
      rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolvaliduntil FROM pg_roles
      WHERE rolname = ANY($1::text[])`, [[reader, attestor]])).rows;
    const sourceRole = roles.find((role) => role.rolname === reader);
    const evidenceRole = roles.find((role) => role.rolname === attestor);
    requireTrue(roles.length === 2 && sourceRole?.rolcanlogin === true && sourceRole.rolconnlimit === 4 &&
      [sourceRole.rolsuper,sourceRole.rolcreatedb,sourceRole.rolcreaterole,sourceRole.rolinherit,
        sourceRole.rolreplication,sourceRole.rolbypassrls].every((value) => value === false) &&
      new Date(sourceRole.rolvaliduntil).getTime() > now() + 7_200_000 &&
      [evidenceRole?.rolcanlogin,evidenceRole?.rolsuper,evidenceRole?.rolcreatedb,
        evidenceRole?.rolcreaterole,evidenceRole?.rolinherit,evidenceRole?.rolreplication,
        evidenceRole?.rolbypassrls].every((value) => value === false), 'source_role_mismatch');
    const membership = (await control.query(`SELECT NOT EXISTS (
      SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AND
      (SELECT count(*)=1 AND bool_and(m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)
       FROM pg_auth_members m WHERE m.roleid=r.oid) AS safe
      FROM pg_roles r WHERE r.rolname=$1`, [attestor])).rows[0];
    requireTrue(membership?.safe === true, 'source_attestor_mismatch');
    for (const source of manifest.sources) {
      const client = source.database === 'postgres' ? control : await connect(source.database, 'admin');
      try { await verifySource(client, source, false); }
      finally { if (client !== control) await client.end(); }
    }
    for (const source of manifest.sources) {
      const client = source.database === 'postgres' ? control : await connect(source.database, 'admin');
      try {
        await client.query('BEGIN');
        try {
          await client.query(`CREATE SCHEMA vayada_migration_evidence AUTHORIZATION "${attestor}"`);
          await client.query(`SET LOCAL ROLE "${attestor}"`);
          await client.query(`REVOKE ALL ON SCHEMA vayada_migration_evidence FROM PUBLIC;
            CREATE TABLE ${evidenceTable} (
              attestation_key text PRIMARY KEY, attestation_value text NOT NULL,
              attested_at timestamptz NOT NULL DEFAULT now());
            REVOKE ALL ON ${evidenceTable} FROM PUBLIC`);
          await client.query(`INSERT INTO ${evidenceTable}(attestation_key,attestation_value)
            VALUES ('vayada.source_snapshot_identifier',$1),
              ('vayada.cutover_freeze_proof_sha256',$2)`, [snapshot, proofSha256]);
          await client.query(`GRANT USAGE ON SCHEMA vayada_migration_evidence TO "${reader}";
            GRANT SELECT ON ${evidenceTable} TO "${reader}"`);
          await client.query('COMMIT');
          committed += 1;
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        await verifySource(client, source, true);
        const sourceReader = await connect(source.database, 'source');
        try {
          await sourceReader.query('BEGIN READ ONLY');
          const rows = (await sourceReader.query(`SELECT attestation_key,attestation_value
            FROM ${evidenceTable} ORDER BY attestation_key`)).rows;
          requireTrue(rows.length === 2 && rows[0].attestation_value === proofSha256 &&
            rows[1].attestation_value === snapshot, 'source_reader_readback_mismatch');
          await sourceReader.query('COMMIT');
        } finally { await sourceReader.end(); }
      } finally { if (client !== control) await client.end(); }
    }
    return { status: 'OK', scope: 'isolated-source-attestation', databases: 4,
      tables: 83, proofSha256 };
  } catch (error) {
    if (committed) throw new Error('source_binding_partial_requires_inspection', { cause: error });
    throw error;
  } finally {
    if (locked) await control.query('SELECT pg_advisory_unlock(204220260925)').catch(() => {});
    await control.end().catch(() => {});
  }
}

export async function launch(env, { Client }) {
  let stage = 'configuration';
  try {
    const { host, ca } = configuration(env);
    requireTrue(env.VAY2042_BIND_SOURCE_MAIN === '1' && env.VAY2042_PROOF_SHA256 === proofSha256 &&
      env.VAY2042_SOURCE_USER === reader && env.VAY2042_SOURCE_PASSWORD &&
      proof.workflowRunId === 36847109009 && proof.snapshotArn.endsWith(manifest.sourceSnapshotId),
    'configuration_invalid');
    stage = 'database-connect';
    const connect = async (database, identity) => {
      requireTrue(sourceDatabases.includes(database) && ['admin','source'].includes(identity), 'configuration_invalid');
      const user = identity === 'admin' ? env.VAY2042_DB_USER : env.VAY2042_SOURCE_USER;
      const password = identity === 'admin' ? env.VAY2042_DB_PASSWORD : env.VAY2042_SOURCE_PASSWORD;
      const client = new Client({ host, port: 5432, database, user, password,
        ssl: { ca, rejectUnauthorized: true, servername: host }, connectionTimeoutMillis: 10_000,
        statement_timeout: 60_000, application_name: 'vay2042-source-attestation-v1' });
      client.on('error', () => {});
      try {
        await client.connect();
        const row = (await client.query(`SELECT current_database() AS database,session_user AS login,
          host(inet_server_addr()) AS address,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl`)).rows[0];
        requireTrue(row?.database === database && row.login === user && row.ssl === true &&
          /^10\.230\.0\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(row.address),
        'database_endpoint_invalid');
        stage = 'source-binding';
        return client;
      } catch (error) { await client.end().catch(() => {}); throw error; }
    };
    return await bindSourceAttestation({ connect });
  } catch (error) {
    const codes = new Set(['configuration_invalid','database_endpoint_invalid','source_binding_busy',
      'database_inventory_mismatch','source_role_mismatch','source_attestor_mismatch',
      'source_inventory_mismatch','source_setting_conflict','source_ddl_hook_mismatch',
      'source_evidence_state_mismatch',
      'source_evidence_owner_mismatch','source_evidence_value_mismatch',
      'source_reader_privilege_mismatch','source_reader_readback_mismatch',
      'source_binding_partial_requires_inspection']);
    return { status: 'FAIL', scope: 'isolated-source-attestation', stage,
      code: codes.has(error?.message) ? error.message : 'binding_failed' };
  }
}

if (process.env.VAY2042_BIND_SOURCE_MAIN === '1') {
  let result;
  try { result = await launch(process.env, { Client: (await import('pg')).default.Client }); }
  catch { result = { status: 'FAIL', scope: 'isolated-source-attestation', code: 'binding_failed' }; }
  console.log(JSON.stringify(result));
  if (result.status !== 'OK') process.exitCode = 1;
}
