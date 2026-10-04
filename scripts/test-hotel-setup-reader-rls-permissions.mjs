import assert from 'node:assert/strict';
import pg from 'pg';
import { runReaderRlsPermissionCheck } from './hotel-setup-reader-rls-permissions.mjs';

const admin = new pg.Client('postgresql://postgres:postgres@reader-rls-db:5432/postgres');
const readers = ['vayada_next_hotel_setup_creation_reader', 'vayada_next_hotel_setup_reader'];
const scope = 'platform.channex_management_worker_scope(text,text,uuid)';
const source = 'platform.channex_management_worker_source(text,text,uuid)';
const functions = [scope, source];
// Exact deployed 0407/0408 invoker bodies; their hashes are enforced by the repair.
const definition = `CREATE FUNCTION platform.channex_management_worker_scope(kind text, resource text, parent uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' THEN RETURN true; END IF;
  CASE kind
    WHEN 'property' THEN RETURN EXISTS (
      SELECT 1 FROM platform.channex_management_worker_properties WHERE property_id::text = resource);
    WHEN 'job' THEN RETURN EXISTS (
      SELECT 1 FROM platform.jobs WHERE id::text = resource AND (parent IS NULL OR property_id = parent));
    WHEN 'management_key' THEN RETURN EXISTS (
      SELECT 1 FROM platform.jobs WHERE idempotency_key_hash = resource AND property_id = parent);
    WHEN 'attempt' THEN RETURN EXISTS (
      SELECT 1 FROM platform.job_attempts WHERE id::text = resource AND job_id = parent);
    ELSE RETURN false;
  END CASE;
END;
$$;
CREATE FUNCTION platform.channex_management_worker_source(kind text, resource text, parent uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' THEN RETURN true; END IF;
  CASE kind
    WHEN 'organization' THEN RETURN EXISTS (
      SELECT 1 FROM identity.organization_resource_links WHERE organization_id = resource::uuid);
    WHEN 'connection' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channel_connections WHERE id = resource::uuid AND (parent IS NULL OR property_id = parent));
    WHEN 'target' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_offer_targets WHERE id = resource::uuid AND (parent IS NULL OR connection_id = parent));
    WHEN 'creation' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_offer_create_attempts WHERE id = resource::uuid);
    WHEN 'ari' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_offer_ari_attempts WHERE id = resource::uuid);
    WHEN 'availability' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channex_room_availability_attempts WHERE id = resource::uuid);
    ELSE RETURN false;
  END CASE;
END;
$$;`;
await admin.connect();
try {
  await admin.query(`CREATE SCHEMA identity; CREATE SCHEMA platform;
    CREATE ROLE legacy_helper_owner NOLOGIN;
    CREATE ROLE unrelated_reader NOLOGIN;
    CREATE ROLE reader_creator NOLOGIN CREATEROLE NOINHERIT;
    CREATE TABLE identity.organizations(id integer PRIMARY KEY);
    INSERT INTO identity.organizations VALUES(1),(2);
    ALTER TABLE identity.organizations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_scope ON identity.organizations USING(id=1);`);
  await admin.query(definition);
  for (const fn of functions) await admin.query(`ALTER FUNCTION ${fn} OWNER TO legacy_helper_owner;
    REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${fn} TO unrelated_reader;`);
  for (const role of readers) await admin.query(`SET ROLE reader_creator;
    CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD 'fixture'; RESET ROLE;
    GRANT USAGE ON SCHEMA identity,platform TO ${role};
    GRANT SELECT(id) ON identity.organizations TO ${role};`);
  await admin.query(`CREATE POLICY worker_scope ON identity.organizations AS RESTRICTIVE
    USING(platform.channex_management_worker_source('organization',id::text));`);
  const relations = async () => (await admin.query(`SELECT c.relacl,c.relrowsecurity,c.relforcerowsecurity,
    p.polname,pg_get_expr(p.polqual,p.polrelid) AS predicate FROM pg_class c
    JOIN pg_policy p ON p.polrelid=c.oid WHERE c.oid='identity.organizations'::regclass ORDER BY p.polname`)).rows;
  for (const role of readers) {
    const client = new pg.Client(`postgresql://${role}:fixture@reader-rls-db:5432/postgres`);
    await client.connect();
    await assert.rejects(client.query('SELECT id FROM identity.organizations'), { code: '42501' });
    await client.end();
  }
  const inspect = () => runReaderRlsPermissionCheck(admin, 'inspect', undefined, 'postgres');
  const repair = fingerprint => runReaderRlsPermissionCheck(admin, 'apply', fingerprint, 'postgres');
  const initial = await inspect();
  assert.equal(initial.missingEdges, 4);
  const creatorEdges = async () => (await admin.query(`SELECT roleid,member,grantor,admin_option,inherit_option,set_option
    FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))
    ORDER BY roleid,member,grantor`, [readers])).rows;
  assert.equal((await creatorEdges()).length, 2);
  assert.ok((await creatorEdges()).every(edge => edge.admin_option && !edge.inherit_option && !edge.set_option));
  await assert.rejects(repair('0'.repeat(64)));
  assert.equal((await inspect()).missingEdges, 4);
  // Freeze denies role recreation even when the name and flags are unchanged.
  await admin.query(`DROP OWNED BY ${readers[0]}; DROP ROLE ${readers[0]};
    SET ROLE reader_creator; CREATE ROLE ${readers[0]} LOGIN NOINHERIT PASSWORD 'fixture'; RESET ROLE;
    GRANT USAGE ON SCHEMA identity,platform TO ${readers[0]};
    GRANT SELECT(id) ON identity.organizations TO ${readers[0]};`);
  await assert.rejects(repair(initial.fingerprint));
  const oldFunction = await inspect();
  await admin.query(`DROP FUNCTION ${source} CASCADE`);
  await admin.query(definition.slice(definition.indexOf('CREATE FUNCTION platform.channex_management_worker_source')));
  await admin.query(`ALTER FUNCTION ${source} OWNER TO legacy_helper_owner;
    REVOKE ALL ON FUNCTION ${source} FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${source} TO unrelated_reader;
    CREATE POLICY worker_scope ON identity.organizations AS RESTRICTIVE
      USING(platform.channex_management_worker_source('organization',id::text));`);
  await assert.rejects(repair(oldFunction.fingerprint));
  await admin.query(`GRANT unrelated_reader TO ${readers[0]}`);
  await assert.rejects(inspect());
  await admin.query(`REVOKE unrelated_reader FROM ${readers[0]}`);
  await admin.query('SET SESSION AUTHORIZATION unrelated_reader');
  await assert.rejects(runReaderRlsPermissionCheck(admin, 'inspect', undefined, 'unrelated_reader'));
  await admin.query('RESET SESSION AUTHORIZATION');
  await admin.query(`ALTER FUNCTION ${source} OWNER TO ${readers[0]}`);
  await assert.rejects(inspect());
  await admin.query(`ALTER FUNCTION ${source} OWNER TO legacy_helper_owner`);
  for (const mutation of [
    `ALTER FUNCTION ${source} SECURITY DEFINER`,
    `ALTER FUNCTION ${source} SET search_path=public`,
    `CREATE OR REPLACE FUNCTION platform.channex_management_worker_source(kind text,resource text,parent uuid DEFAULT NULL)
      RETURNS boolean LANGUAGE plpgsql STABLE
      SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN true; END;$$`,
  ]) {
    await admin.query('BEGIN');
    await admin.query(mutation);
    await admin.query('COMMIT');
    await assert.rejects(inspect());
    await admin.query(definition.replaceAll('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  }
  // A concurrent ACL edit also invalidates the frozen receipt; nothing else is repaired.
  const frozen = await inspect();
  await admin.query(`REVOKE EXECUTE ON FUNCTION ${source} FROM unrelated_reader`);
  await assert.rejects(repair(frozen.fingerprint));
  await admin.query(`GRANT EXECUTE ON FUNCTION ${source} TO unrelated_reader`);
  const membershipFrozen = await inspect();
  await admin.query(`GRANT ${readers[0]} TO unrelated_reader WITH INHERIT FALSE, SET FALSE`);
  await assert.rejects(repair(membershipFrozen.fingerprint));
  await admin.query(`REVOKE ${readers[0]} FROM unrelated_reader`);
  const beforeRelations = await relations();
  const beforeCreatorEdges = await creatorEdges();
  const ready = await inspect();
  await repair(ready.fingerprint);
  assert.equal((await inspect()).missingEdges, 0);
  assert.deepEqual(await relations(), beforeRelations);
  assert.deepEqual(await creatorEdges(), beforeCreatorEdges);
  for (const role of readers) {
    const client = new pg.Client(`postgresql://${role}:fixture@reader-rls-db:5432/postgres`);
    await client.connect();
    assert.deepEqual((await client.query('SELECT id FROM identity.organizations')).rows, [{ id: 1 }]);
    await assert.rejects(client.query('UPDATE identity.organizations SET id=3 WHERE id=1'), { code: '42501' });
    for (const fn of functions) {
      assert.equal((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS ok", [fn])).rows[0].ok, true);
      assert.equal((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE WITH GRANT OPTION') AS ok", [fn])).rows[0].ok, false);
    }
    await client.end();
  }
  assert.equal((await admin.query(`SELECT count(*)::int AS count FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=ANY($1::regprocedure[]) AND a.grantee=0`, [functions])).rows[0].count, 0);
  await repair((await inspect()).fingerprint); // Already repaired is a verified no-op.
  console.log('setup reader RLS permission hardened native checks PASS');
} finally { await admin.end(); }
