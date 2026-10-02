import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const appRoot = process.env.VAYADA_HOTEL_SETUP_CREATION_TEST_APP_ROOT;
const raw = process.env.TEST_DATABASE_URL;
assert(appRoot && raw && process.env.NODE_EXTRA_CA_CERTS, "owned local app, database and CA required");
const url = new URL(raw);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/vay1092_vay965_creation_test");
const { default: pg } = await import(pathToFileURL(`${appRoot}/node_modules/pg/lib/index.js`).href);
const admin = new pg.Client({ connectionString: raw });
await admin.connect();
const script = `${appRoot}/scripts/.vay965-bootstrap-${randomUUID()}.mjs`;
const organizations = [randomUUID(), randomUUID()];
const actor = randomUUID();
const roles = [];
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const acls = (await admin.query(`SELECT d.datname AS name,
  COALESCE(array_agg(a.privilege_type) FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
  FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
  WHERE d.datallowconn GROUP BY d.datname`)).rows;
try {
  await copyFile(new URL("./provision-hotel-setup-creation-login.mjs", import.meta.url), script);
  for (const acl of acls) await admin.query(`REVOKE ALL ON DATABASE ${quote(acl.name)} FROM PUBLIC`);
  await admin.query("INSERT INTO identity.users(id,email,name) VALUES($1,$1::uuid::text || '@example.test','Bootstrap test')", [actor]);
  for (const id of organizations) {
    await admin.query("INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Bootstrap test',$1::uuid::text)", [id]);
    await admin.query(`INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin)
      VALUES($1,$2,'hotel_owner','agency')`, [id, actor]);
  }
  const snapshot = async () => (await admin.query(`SELECT
    (SELECT count(*)::text FROM hotel_catalog.properties) AS hotels,
    (SELECT count(*)::text FROM platform.product_audit_events) AS audits`)).rows;
  const before = await snapshot();
  url.search = "?sslmode=verify-full";
  const run = (organizationId, actorUserId = actor, lostCommit = false, purpose = "organization", vaultFault = "") => {
    const preload = `import {createRequire} from "node:module";
      const pg=createRequire(${JSON.stringify(appRoot + "/package.json")})("pg");
      const Client=pg.Client; let lost=false;
      pg.Client=class extends Client { async query(sql,...args) {
        const result=await super.query(sql,...args);
        if(sql==="COMMIT"&&!lost){lost=true;throw new Error("synthetic lost commit acknowledgement");}
        return result;
      }};`;
    const vaultPreload = `import {registerHooks} from "node:module";
      const fault=${JSON.stringify(vaultFault)};
      registerHooks({load(url,context,next){const result=next(url,context);
        if(url.endsWith("/platform/providerCredentialVault.js")){
          let source=result.source.toString();
          if(fault==="partial") source=source.replace("credentials.set(reference, JSON.stringify(value));",
            'if(reference.endsWith("/internal-token"))throw new Error("synthetic partial vault failure");credentials.set(reference, JSON.stringify(value));');
          if(fault==="existing") source=source.replace("const value = credentials.get(reference);",
            'if(reference.endsWith("/reader-database-url"))return "synthetic-existing-credential";const value = credentials.get(reference);');
          return {...result,source};
        }return result;}});`;
    const args = [];
    if (lostCommit) args.push("--import", "data:text/javascript," + encodeURIComponent(preload));
    if (vaultFault) args.push("--import", "data:text/javascript," + encodeURIComponent(vaultPreload));
    args.push(script);
    const result = spawnSync(process.execPath, args, {
      cwd: appRoot, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, TARGET_DATABASE_ADMIN_URL: url.toString(),
        VAYADA_HOTEL_SETUP_CREATION_LOCAL_FIXTURE: "1",
        HOTEL_SETUP_BOOTSTRAP_PURPOSE: purpose,
        HOTEL_SETUP_COMMAND_ORGANIZATION_ID: organizationId,
        HOTEL_SETUP_COMMAND_ACTOR_USER_ID: actorUserId,
        PGHOST: "untrusted.invalid", PGPORT: "1", PGOPTIONS: "-c role=postgres" },
    });
    const receipt = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
    if (receipt.role) roles.push(receipt.role);
    assert(!result.stdout.includes(url.password));
    assert(!result.stderr.includes(url.password));
    return { result, receipt };
  };
  const created = run(organizations[0]);
  assert.equal(created.result.status, 0);
  assert.equal(created.receipt.status, "PASS");
  assert.equal(created.receipt.organizationId, organizations[0]);
  assert.equal((await admin.query("SELECT organization_id FROM platform.hotel_setup_creation_scopes WHERE database_login=$1", [created.receipt.role])).rows[0].organization_id, organizations[0]);
  // Existing assignments are rejected rather than adopted or silently rotated.
  const repeat = run(organizations[0]);
  assert.equal(repeat.result.status, 1);
  assert.equal(repeat.receipt.code, "hotel_setup_creation_provision_failed");
  assert.equal((await admin.query("SELECT count(*)::integer AS count FROM platform.hotel_setup_creation_scopes WHERE organization_id=$1", [organizations[0]])).rows[0].count, 1);
  const denied = run(organizations[1], randomUUID());
  assert.equal(denied.result.status, 1);
  assert.equal(denied.receipt.code, "hotel_setup_creation_provision_failed");
  assert.equal((await admin.query("SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=$1", [denied.receipt.role])).rows[0].rolcanlogin, false);
  assert.equal((await admin.query("SELECT 1 FROM platform.hotel_setup_creation_scopes WHERE database_login=$1", [denied.receipt.role])).rowCount, 0);
  const uncertain = run(organizations[1], actor, true);
  assert.equal(uncertain.result.status, 1);
  assert.equal(uncertain.receipt.code, "hotel_setup_creation_provision_failed");
  assert.equal((await admin.query("SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=$1", [uncertain.receipt.role])).rows[0].rolcanlogin, false);
  assert.equal((await admin.query("SELECT 1 FROM platform.hotel_setup_creation_scopes WHERE database_login=$1", [uncertain.receipt.role])).rowCount, 0);
  const reader = run(organizations[0], actor, false, "creation_reader");
  assert.equal(reader.result.status, 0);
  assert.equal(reader.receipt.role, "vayada_next_hotel_setup_creation_reader");
  assert.equal(reader.receipt.purpose, "creation_reader");
  assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1)", [reader.receipt.role])).rows[0].count, 0);
  const existingReader = run(organizations[0], actor, false, "creation_reader");
  assert.equal(existingReader.result.status, 1);
  assert.equal(existingReader.receipt.code, "hotel_setup_creation_provision_failed");
  assert.equal((await admin.query("SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=$1", [reader.receipt.role])).rows[0].rolcanlogin, true);
  await admin.query(`DROP OWNED BY ${quote(reader.receipt.role)}`);
  await admin.query(`DROP ROLE ${quote(reader.receipt.role)}`);
  const partial = run(organizations[0], actor, false, "creation_reader", "partial");
  assert.equal(partial.result.status, 1);
  assert.equal(partial.receipt.code, "hotel_setup_creation_provision_failed");
  assert.equal((await admin.query("SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=$1", [partial.receipt.role])).rows[0].rolcanlogin, false);
  await admin.query(`DROP OWNED BY ${quote(partial.receipt.role)}`);
  await admin.query(`DROP ROLE ${quote(partial.receipt.role)}`);
  const existingSecret = run(organizations[0], actor, false, "creation_reader", "existing");
  assert.equal(existingSecret.result.status, 1);
  assert.equal(existingSecret.receipt.code, "hotel_setup_creation_provision_failed");
  assert.equal(existingSecret.receipt.role, undefined);
  assert.equal((await admin.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_creation_reader'")).rowCount, 0);
  assert.deepEqual(await snapshot(), before);
  console.log(JSON.stringify({ status: "PASS", scope: "local_creation_bootstrap" }));
} finally {
  await unlink(script).catch(() => undefined);
  for (const role of new Set(roles)) {
    assert(/^vayada_next_hotel_setup_org_[a-f0-9]+$/.test(role) || role === "vayada_next_hotel_setup_creation_reader");
    if (!(await admin.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1", [role])).rowCount) continue;
    await admin.query("DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1", [role]);
    await admin.query(`DROP OWNED BY ${quote(role)}`);
    await admin.query(`DROP ROLE ${quote(role)}`);
  }
  await admin.query("DELETE FROM identity.organization_memberships WHERE user_id=$1", [actor]);
  for (const id of organizations) await admin.query("DELETE FROM identity.organizations WHERE id=$1", [id]);
  await admin.query("DELETE FROM identity.users WHERE id=$1", [actor]);
  for (const acl of acls) if (acl.privileges.length)
    await admin.query(`GRANT ${acl.privileges.join(",")} ON DATABASE ${quote(acl.name)} TO PUBLIC`);
  await admin.end();
}
