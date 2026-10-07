import assert from 'node:assert/strict';
import pg from 'pg';
import { BINDINGS, inspectLegacyHelpers } from './hotel-setup-legacy-helper-inspection.mjs';

const admin = new pg.Client('postgresql://postgres:postgres@legacy-helper-db:5432/postgres');
const helpers = ['platform.channex_management_worker_source(text,text,uuid)',
  'platform.channex_management_worker_scope(text,text,uuid)'];
const password = 'synthetic-legacy-password-32-characters';
const versions = ['1'.repeat(32),'2'.repeat(32)];
let descriptions=0,reads=0,connections=0;
const name = binding => `hotel-setup-command/prod/organization/${binding.login}`;
const describe = async secret => {
  descriptions++;
  const index=BINDINGS.findIndex(binding => name(binding) === secret);
  assert.ok(index >= 0);
  return {Name:secret,ARN:`arn:aws:secretsmanager:eu-west-1:269416271598:secret:${secret}-123abc`,
    VersionIdsToStages:{[versions[index]]:['AWSCURRENT']}};
};
const read = async (secret,version) => {
  reads++;
  const binding=BINDINGS.find(binding => name(binding) === secret);
  assert.ok(binding);assert.equal(version,versions[BINDINGS.indexOf(binding)]);
  return {username:binding.login,password};
};
const connectNative = async (login,secret) => {
  connections++;
  assert.ok(BINDINGS.some(binding => binding.login === login));assert.equal(secret,password);
  const client=new pg.Client({host:'legacy-helper-db',port:5432,database:'postgres',user:login,password:secret});
  await client.connect();return client;
};
const probe=(mode='inspect',frozen,overrides={}) => inspectLegacyHelpers({admin,mode,frozen,describe,read,
  connectNative,principal:'postgres',...overrides});
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
  assert.deepEqual(BINDINGS.map(b => [b.organizationId,b.actorUserId,b.login]),[
    ['6a717155-a188-45f3-87e5-5c8408f41a87','b9eec40b-2e2d-4ff1-b3d4-6d6e03bb58d9','vayada_next_hotel_setup_org_c0be02f6ee4d481aadb8c7eca98d74c1'],
    ['2734e584-022d-432a-9637-ccb0cce59c53','a729d719-2297-4be7-8f7a-12bdf87da1b3','vayada_next_hotel_setup_org_74adc91d74b84f11bacdf2b961cc8438'],
  ]);
  await admin.query(`CREATE SCHEMA identity;CREATE SCHEMA platform;
    CREATE ROLE vayada_next_hotel_setup_scope NOLOGIN NOINHERIT;
    CREATE ROLE unrelated_role NOLOGIN;
    CREATE TABLE identity.organizations(id uuid PRIMARY KEY);
    CREATE TABLE platform.hotel_setup_creation_scopes(database_login text PRIMARY KEY,organization_id uuid UNIQUE);
    CREATE TABLE platform.hotel_setup_property_scopes(database_login text PRIMARY KEY,property_id uuid UNIQUE);
    ALTER TABLE identity.organizations ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA platform TO vayada_next_hotel_setup_scope;
    GRANT SELECT ON platform.hotel_setup_creation_scopes TO vayada_next_hotel_setup_scope;
    CREATE POLICY owner_scope ON identity.organizations TO vayada_next_hotel_setup_scope USING(
      EXISTS(SELECT 1 FROM platform.hotel_setup_creation_scopes s
        WHERE s.database_login=session_user AND s.organization_id=id));`);
  await admin.query(definition);
  for (const fn of helpers) await admin.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`);
  await admin.query(`CREATE POLICY helper_scope ON identity.organizations AS RESTRICTIVE USING(
    platform.channex_management_worker_source('organization',id::text))`);
  for (const binding of BINDINGS) {
    await admin.query(`CREATE ROLE ${binding.login} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
      GRANT vayada_next_hotel_setup_scope TO ${binding.login} WITH INHERIT TRUE,SET FALSE;
      GRANT USAGE ON SCHEMA identity,platform TO ${binding.login};
      GRANT SELECT(id) ON identity.organizations TO ${binding.login}`);
    await admin.query('INSERT INTO identity.organizations VALUES($1)',[binding.organizationId]);
    await admin.query('INSERT INTO platform.hotel_setup_creation_scopes VALUES($1,$2)',[binding.login,binding.organizationId]);
  }
  const baseline=(await admin.query('SELECT * FROM identity.organizations ORDER BY id')).rows;
  const blocked=await probe();
  assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.permissions.filter(p => !p.execute).length,4);
  assert.equal(descriptions,0);assert.equal(reads,0);assert.equal(connections,0);
  assert.ok(blocked.organizations.every(o => o.secretVersion === null));
  assert.equal(blocked.creationScopesTableOwnerOid,(await admin.query(
    "SELECT relowner FROM pg_class WHERE oid='platform.hotel_setup_creation_scopes'::regclass")).rows[0].relowner);
  assert.ok(blocked.functions.every(fn => fn.helperOwnerMatches));
  assert.equal(blocked.propertyScopesTableOwnerOid,blocked.creationScopesTableOwnerOid);
  assert.ok(blocked.functions.every(fn => fn.helperPropertyOwnerMatches));
  for (const binding of BINDINGS)
    for (const fn of helpers) await admin.query(`GRANT EXECUTE ON FUNCTION ${fn} TO ${binding.login}`);
  await admin.query(`ALTER FUNCTION ${helpers[0]} OWNER TO unrelated_role`);
  const wrongOwner=await probe();
  assert.equal(wrongOwner.status,'BLOCKED');
  assert.equal(wrongOwner.functions.filter(fn => !fn.helperOwnerMatches).length,1);
  assert.ok(wrongOwner.permissions.every(p => p.schema_usage && p.execute && !p.grantable));
  assert.equal(descriptions,0);assert.equal(reads,0);assert.equal(connections,0);
  await admin.query(`ALTER FUNCTION ${helpers[0]} OWNER TO postgres`);
  await admin.query('ALTER TABLE platform.hotel_setup_property_scopes OWNER TO unrelated_role');
  const wrongPropertyOwner=await probe();
  assert.equal(wrongPropertyOwner.status,'BLOCKED');
  assert.ok(wrongPropertyOwner.functions.every(fn => fn.helperOwnerMatches && !fn.helperPropertyOwnerMatches));
  assert.ok(wrongPropertyOwner.permissions.every(p => p.schema_usage && p.execute && !p.grantable));
  assert.equal(descriptions,0);assert.equal(reads,0);assert.equal(connections,0);
  await admin.query('ALTER TABLE platform.hotel_setup_property_scopes OWNER TO postgres');
  const inspected=await probe();
  assert.equal(inspected.status,'PASS');assert.equal(descriptions,4);assert.equal(reads,0);
  let described=0;
  await assert.rejects(probe('inspect',undefined,{
    describe:async secret => {
      const metadata=await describe(secret);
      return ++described === 3 ? {...metadata,VersionIdsToStages:{['4'.repeat(32)]:['AWSCURRENT']}} : metadata;
    }}));
  assert.equal(reads,0);
  await assert.rejects(probe('verify','0'.repeat(64)));assert.equal(reads,0);
  versions[0]='3'.repeat(32);
  await assert.rejects(probe('verify',inspected.fingerprint));assert.equal(reads,0);
  versions[0]='1'.repeat(32);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${helpers[0]} TO unrelated_role`);
  await assert.rejects(probe('verify',inspected.fingerprint));assert.equal(reads,0);
  await admin.query(`REVOKE EXECUTE ON FUNCTION ${helpers[0]} FROM unrelated_role`);
  await admin.query(`ALTER ROLE ${BINDINGS[0].login} CONNECTION LIMIT 5`);
  await assert.rejects(probe('verify',inspected.fingerprint));assert.equal(reads,0);
  await admin.query(`ALTER ROLE ${BINDINGS[0].login} CONNECTION LIMIT -1`);
  await assert.rejects(probe('verify',inspected.fingerprint,{
    describe:async secret => ({...await describe(secret),VersionIdsToStages:{[versions[0]]:['AWSCURRENT','AWSPENDING']}})}));
  await assert.rejects(probe('verify',inspected.fingerprint,{
    read:async () => ({username:BINDINGS[1].login,password})}));
  await assert.rejects(probe('verify',inspected.fingerprint,{
    connectNative:async () => connectNative(BINDINGS[1].login,password)}));
  const proved=await probe('verify',inspected.fingerprint);
  assert.equal(proved.status,'PASS');assert.equal(proved.fingerprint,inspected.fingerprint);
  try {
    await assert.rejects(probe('verify',inspected.fingerprint,{
      read:async (secret,version) => {
        const payload=await read(secret,version);
        versions[0]='4'.repeat(32);
        return payload;
      }}));
  } finally {versions[0]='1'.repeat(32);}
  assert.equal((await probe()).fingerprint,inspected.fingerprint);
  for (const binding of BINDINGS) {
    const client=await connectNative(binding.login,password);
    try {
      assert.deepEqual((await client.query('SELECT id FROM identity.organizations')).rows,[{id:binding.organizationId}]);
      await assert.rejects(client.query('UPDATE identity.organizations SET id=id'),{code:'42501'});
    } finally {await client.end();}
  }
  assert.deepEqual((await admin.query('SELECT * FROM identity.organizations ORDER BY id')).rows,baseline);
  const frozen=await probe();
  await assert.rejects(probe('verify',frozen.fingerprint,{
    read:async (secret,version) => {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${helpers[0]} FROM ${BINDINGS[0].login}`);
      return read(secret,version);
    }}));
  assert.equal((await probe()).status,'BLOCKED');
  console.log('fixed legacy helper read-only native checks PASS');
} finally {await admin.end();}
