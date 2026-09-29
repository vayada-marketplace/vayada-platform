import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { reader } from './provision-vay2042-source-reader.mjs';
import { writer, target } from './provision-vay2042-target.mjs';
import { checkRole, checkSecretMetadata, runPreflight } from './vay2042-private-preflight.mjs';

const role = (name, expiry) => ({ rolname: name, rolcanlogin: true, rolconnlimit: 4,
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false,
  rolreplication: false, rolbypassrls: false, rolvaliduntil: expiry });
const now = Date.parse('2026-09-26T16:00:00Z');

test('only the original expired, unelevated logins qualify', () => {
  checkRole(role(reader, '2026-09-26T13:22:45Z'), reader, now);
  checkRole(role(writer, '2026-09-26T13:34:20Z'), writer, now);
  for (const bad of [
    { ...role(reader, '2026-09-26T13:22:45Z'), rolcanlogin: false },
    { ...role(reader, '2026-09-26T13:22:45Z'), rolcreatedb: true },
    { ...role(reader, '2026-09-26T13:22:45Z'), rolconnlimit: -1 },
    role(reader, '2026-09-27T13:22:45Z'),
    role(reader, '2026-09-26T13:21:59Z'),
  ]) assert.throws(() => checkRole(bad, reader, now), /role_identity_or_expiry_mismatch/);
});

test('pinned secret must still be its only current version', () => {
  const expected = { arn: 'exact-arn', name: 'exact-name', version: 'exact-version' };
  checkSecretMetadata({ ARN: expected.arn, Name: expected.name,
    VersionIdsToStages: { [expected.version]: ['AWSCURRENT'] } }, expected);
  assert.throws(() => checkSecretMetadata({ ARN: expected.arn, Name: expected.name,
    VersionIdsToStages: { [expected.version]: ['AWSPREVIOUS'] } }, expected),
  /credential_version_changed/);
});

function fakeDatabase({ drift = false, directFailure = false, oldWriterAccess = false,
  attestorElevated = false, commitFailure = false, extraColumn = false,
  defaultGrant = false } = {}) {
  const calls = [];
  let committed = false;
  const connect = async (database, identity) => {
    calls.push(['connect', database, identity]);
    if (directFailure && committed && identity !== 'admin') throw new Error('synthetic_login_denied');
    return {
      end: async () => calls.push(['end', database, identity]),
      query: async (sql, params = []) => {
        calls.push(['query', database, identity, sql]);
        const rows = (values) => ({ rowCount: values.length, rows: values });
        if (sql.startsWith('SELECT pg_try_advisory_lock')) return rows([{ locked: true }]);
        if (sql.startsWith('SELECT pg_advisory_unlock')) return rows([{ pg_advisory_unlock: true }]);
        if (sql.includes('FROM pg_database\n      WHERE datallowconn')) return rows(
          (drift ? ['postgres'] : [...manifest.databases, target].sort()).map((datname) => ({ datname })));
        if (sql.startsWith('SELECT rolname,rolcanlogin')) return rows([
          role(reader, '2026-09-26T13:22:45Z'), role(writer, '2026-09-26T13:34:20Z'),
        ]);
        if (sql.includes('FROM pg_db_role_setting')) return rows([{ rolname: reader, global: true,
          setconfig: ['default_transaction_read_only=on', 'statement_timeout=60s',
            'idle_in_transaction_session_timeout=60s'] }]);
        if (sql.includes('EXISTS (SELECT 1 FROM pg_auth_members m')) {
          const name = params[0];
          return rows([{ membership: false, ownership: false, attributes: true,
            database_write: name === writer, schema_write: database === target && name === writer,
            relation_privileges: false, sequence_privileges: false, definer_privileges: false,
            missing_read: false }]);
        }
        if (sql.includes("AND c.relkind IN ('r','p') ORDER BY 1")) return rows(
          manifest.sources.find((s) => s.database === database).tables.map((name) => ({ name })));
        if (sql.includes('AS writer_denied')) return rows([{ writer_denied: !oldWriterAccess }]);
        if (sql.includes('LATERAL aclexplode')) return rows([{ grants: defaultGrant ? 1 : 0 }]);
        if (sql.includes('SELECT nspname AS name FROM pg_namespace')) return rows([
          { name: 'public' }, { name: 'vayada_migration_evidence' },
        ]);
        if (sql.includes('FROM pg_class c\n    JOIN pg_namespace') && database === target) return rows([
          { name: 'vayada_migration_evidence.database_attestations' },
          { name: 'vayada_migration_evidence.database_attestations_pkey' },
        ]);
        if (sql.includes('format_type(a.atttypid')) return rows([
          { name: 'attestation_key', type: 'text', required: true, default_value: null },
          { name: 'attestation_value', type: 'text', required: true, default_value: null },
          { name: 'attested_at', type: 'timestamp with time zone', required: true, default_value: 'now()' },
          ...(extraColumn ? [{ name: 'extra', type: 'text', required: false, default_value: null }] : []),
        ]);
        if (sql.includes('FROM pg_constraint x JOIN pg_class')) return rows([{
          name: 'database_attestations_pkey', type: 'p', columns: '{1}', valid: true, deferrable: false,
        }]);
        if (sql.includes('AS routines,')) return rows([{ routines: 0, defaults: 0, types: 0,
          operators: 0, event_triggers: 0, triggers: 0, policies: 0, extensions: 0,
        }]);
        if (sql.startsWith('SELECT count(*)::int AS rows FROM vayada_migration_evidence')) return rows([{ rows: 0 }]);
        if (sql.includes('AS source_denied,')) return rows([{ source_denied: true, writer_boundary: true }]);
        if (sql.includes('AS owned_by_attestor,')) return rows([{ owned_by_attestor: true,
          safe_role: !attestorElevated, safe_membership: true, admin_can_set_role: true }]);
        if (sql.startsWith("SELECT format('ALTER ROLE")) return rows([{
          sql: `ALTER ROLE ${params[0]} VALID UNTIL '${params[1]}'`,
        }]);
        if (sql === 'COMMIT') {
          committed = true;
          if (commitFailure) throw new Error('synthetic_lost_commit_ack');
        }
        if (sql.startsWith('ALTER ROLE ') || sql.startsWith('SET LOCAL ROLE ') ||
          ['BEGIN', 'BEGIN READ ONLY', 'ROLLBACK', 'COMMIT'].includes(sql))
          return rows([]);
        throw new Error(`Unexpected synthetic SQL: ${sql.slice(0, 70)}`);
      },
    };
  };
  return { connect, calls };
}

test('a complete preflight extends only the two exact expiries and proves direct logins', async () => {
  const fake = fakeDatabase();
  const result = await runPreflight({ connect: fake.connect, now: () => now });
  assert.deepEqual({ status: result.status, scope: result.scope, databases: result.databases,
    tables: result.tables, bound: result.bound },
  { status: 'OK', scope: 'isolated-catalog-preflight', databases: 10, tables: 83, bound: false });
  assert.equal(fake.calls.filter((call) => call[3]?.startsWith('ALTER ROLE ')).length, 2);
  assert.equal(fake.calls.filter((call) => call[3] === 'COMMIT').length, 1);
  assert.equal(fake.calls.filter((call) => call[0] === 'connect' && call[2] === 'source').length, 4);
  assert.equal(fake.calls.filter((call) => call[0] === 'connect' && call[2] === 'writer').length, 1);
});

test('catalog drift refuses before any expiry write', async () => {
  const fake = fakeDatabase({ drift: true });
  await assert.rejects(runPreflight({ connect: fake.connect, now: () => now }), /database_inventory_mismatch/);
  assert.equal(fake.calls.filter((call) => call[3]?.startsWith('ALTER ROLE ')).length, 0);
});

test('credential version drift refuses before any expiry write', async () => {
  const fake = fakeDatabase();
  await assert.rejects(runPreflight({ connect: fake.connect, now: () => now,
    checkCredentials: async () => { throw new Error('credential_version_changed'); } }),
  /credential_version_changed/);
  assert.equal(fake.calls.filter((call) => call[3]?.startsWith('ALTER ROLE ')).length, 0);
});

test('extra write access or attestor elevation refuses before any expiry write', async () => {
  for (const options of [{ oldWriterAccess: true }, { attestorElevated: true },
    { extraColumn: true }, { defaultGrant: true }]) {
    const fake = fakeDatabase(options);
    await assert.rejects(runPreflight({ connect: fake.connect, now: () => now }),
      /old_database_writer_privilege_mismatch|target_attestor_mismatch|target_evidence_shape_mismatch|old_database_default_acl_mismatch/);
    assert.equal(fake.calls.filter((call) => call[3]?.startsWith('ALTER ROLE ')).length, 0);
  }
});

test('failed direct login after commit is never reported as a safe retry', async () => {
  const fake = fakeDatabase({ directFailure: true });
  await assert.rejects(runPreflight({ connect: fake.connect, now: () => now }),
    /renewal_committed_requires_inspection/);
  assert.equal(fake.calls.filter((call) => call[3]?.startsWith('ALTER ROLE ')).length, 2);
});

test('lost commit acknowledgement requires inspection, not a retry', async () => {
  const fake = fakeDatabase({ commitFailure: true });
  await assert.rejects(runPreflight({ connect: fake.connect, now: () => now }),
    /renewal_committed_requires_inspection/);
});
