import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./audit-hotel-setup-readiness-migrations.mjs', import.meta.url), 'utf8');
const directory = '/app/packages/backend-migration/migrations';
const contents = new Map([
  ['0001_identity.sql', '-- synthetic identity fixture'],
  ['0462_hotel_setup_launch_settings_scope.sql', '-- synthetic final prior migration'],
  ["0463_hotel_setup_credential_readiness.sql", "-- VAY-965: publication readiness, separate from active native proof authority.\n-- No runtime login, business policy or privilege is changed by this migration.\nALTER TABLE platform.hotel_setup_creation_scopes\n  ADD COLUMN credential_role_oid OID,\n  ADD COLUMN credential_secret_version TEXT,\n  ADD COLUMN credential_ready_at TIMESTAMPTZ,\n  ADD CONSTRAINT hotel_setup_creation_credential_ready CHECK (\n    (credential_role_oid IS NULL AND credential_secret_version IS NULL AND credential_ready_at IS NULL)\n    OR (credential_role_oid IS NOT NULL AND credential_secret_version IS NOT NULL\n      AND credential_secret_version ~ '^[A-Za-z0-9-]{32,64}$' AND credential_ready_at IS NOT NULL)\n  );\n\nALTER TABLE platform.hotel_setup_property_scopes\n  ADD COLUMN credential_role_oid OID,\n  ADD COLUMN credential_secret_version TEXT,\n  ADD COLUMN credential_ready_at TIMESTAMPTZ,\n  ADD CONSTRAINT hotel_setup_property_credential_ready CHECK (\n    (credential_role_oid IS NULL AND credential_secret_version IS NULL AND credential_ready_at IS NULL)\n    OR (credential_role_oid IS NOT NULL AND credential_secret_version IS NOT NULL\n      AND credential_secret_version ~ '^[A-Za-z0-9-]{32,64}$' AND credential_ready_at IS NOT NULL)\n  );\n"],
  ["0464_hotel_setup_reconciliation_cursor.sql", "-- VAY-965: isolated operational scan position, never serving authority.\nCREATE TABLE platform.hotel_setup_reconciliation_cursors (\n  mode TEXT PRIMARY KEY CHECK (mode IN ('organization', 'property')),\n  scope_id UUID,\n  organization_id UUID,\n  actor_user_id UUID,\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),\n  CHECK ((scope_id IS NULL AND organization_id IS NULL AND actor_user_id IS NULL)\n    OR (scope_id IS NOT NULL AND organization_id IS NOT NULL AND actor_user_id IS NOT NULL))\n);\nREVOKE ALL ON platform.hotel_setup_reconciliation_cursors FROM PUBLIC;\nINSERT INTO platform.hotel_setup_reconciliation_cursors(mode) VALUES ('organization'), ('property');\n"],
  ]);
const checksum = content => createHash('sha256').update(content, 'utf8').digest('hex');
const ownerUrl = 'postgresql://vayada_admin:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require';
async function audit(change = () => {}) {
  const fixture = {
    files: new Map(contents), url: ownerUrl, connects: 0, ends: 0, queries: [], output: [],
    identity: {database:'vayada_target_prod',principal:'vayada_admin',replica:false,read_only:'on',locked:true},
    objects: {scopes_present:true,cursor_absent:true,columns_absent:true,checks_absent:true},
    rows: [...contents].filter(([name]) => name.slice(0,4) < '0463').map(([filename,content]) => ({
      version:filename.slice(0,4),name:filename.slice(5,-4),status:'applied',environment:'production',checksum_sha256:checksum(content),history_order:1
    })),
  };
  change(fixture);
  class Client {
    constructor(options) { fixture.options = options; }
    async connect() { fixture.connects++; }
    async end() { fixture.ends++; }
    async query(sql) {
      fixture.queries.push(sql);
      assert.match(sql, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL statement_timeout=|SELECT\s|ROLLBACK)/);
      if (fixture.databaseFailure) { const error=Error('synthetic secret must never leave task');error.code=fixture.databaseFailureCode;throw error; }
      if (sql.includes('pg_try_advisory_lock(8734516)')) return {rows:[{locked:fixture.identity.locked}]};
      if (sql.includes('current_database()')) return {rows:[fixture.identity]};
      if (sql.includes('row_number() OVER')) return {rows:fixture.rows};
      if (sql.includes('scopes_present')) return {rows:[fixture.objects]};
      return {rows:[]};
    }
  }
  const context = vm.createContext({ URL, process:{env:{HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL:fixture.url,VAYADA_DB_RDS_CA_BUNDLE:'synthetic-ca'},exitCode:0},
    console:{log:line=>fixture.output.push(JSON.parse(line)),error:line=>fixture.output.push(JSON.parse(line))} });
  const modules = {
    'node:crypto': {createHash},
    'node:fs/promises': {
      async readdir(path) { assert.equal(path,directory); return [...fixture.files.keys()]; },
      async readFile(path,encoding) { assert.equal(encoding,'utf8'); assert(path.startsWith(directory+'/')); return fixture.files.get(path.slice(directory.length+1)); }
    },
    pg: {default:{Client}},
  };
  const module = new vm.SourceTextModule(source,{context});
  await module.link(name => {
    assert(name in modules);
    const values=modules[name];
    return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});
  });
  await module.evaluate();
  return {...fixture,exitCode:context.process.exitCode};
}
const valid = await audit();
assert.equal(valid.exitCode,0);
assert.deepEqual(valid.output,[{status:'PASS',audit:'hotel_setup_readiness_migrations',appliedCount:2,rejectedChecksums:0,
  manifestSha256:checksum(JSON.stringify([...contents].map(([filename,content])=>[filename.slice(0,4),{name:filename.slice(5,-4),checksum:checksum(content)}]))),pending:['0463','0464']}]);
assert.equal(valid.connects,1); assert.equal(valid.ends,1);
assert.equal(valid.options.ssl.rejectUnauthorized,true);
assert.equal(new URL(valid.options.connectionString).pathname,'/vayada_target_prod');
assert.equal(valid.queries.at(-1),'ROLLBACK');
assert.equal(valid.queries[0],'SELECT pg_try_advisory_lock(8734516) AS locked');
assert.equal(valid.queries[1],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
assert(valid.queries.find(sql=>sql.includes('ORDER BY version, applied_at DESC, id DESC')));
for(const change of [
  f=>f.files.delete('0463_hotel_setup_credential_readiness.sql'),
  f=>f.files.set('0463_hotel_setup_credential_readiness.sql','changed reviewed DDL'),
  f=>f.files.set('0463_duplicate.sql','duplicate'),
  f=>f.files.set('0465_future.sql','future'),
  f=>f.files.set('unversioned.sql','unexpected migration file'),
  f=>f.files.delete('0001_identity.sql'),
  f=>f.rows.pop(),
  f=>f.rows=Array.from({length:10001},()=>({...f.rows[0]})),
  f=>f.rows[0].checksum_sha256='f'.repeat(64),
  f=>f.rows[0].environment='staging',
  f=>f.rows[0].status='failed',
  f=>f.rows[0].name='wrong_name',
  f=>f.rows.push({...f.rows[0]}),
  f=>f.rows.push({...f.rows[0],version:'0463'}),
  f=>f.rows.push({...f.rows[0],version:'0464'}),
  f=>f.rows.push({...f.rows[0],version:'9999'}),
  f=>f.identity.database='wrong_database',
  f=>f.identity.principal='wrong_owner',
  f=>f.identity.replica=true,
  f=>f.identity.read_only='off',
  f=>f.identity.locked=false,
  ...['scopes_present','cursor_absent','columns_absent','checks_absent'].map(key=>f=>f.objects[key]=false),
  f=>f.databaseFailure=true,
  f=>f.objects={},
]) {
  const result=await audit(change);
  assert.equal(result.exitCode,1);
  assert.equal(result.output.length,1);
  const receipt=result.output[0];
  assert.equal(receipt.status,'FAIL');
  assert.equal(receipt.code,'hotel_setup_readiness_migration_audit_unavailable');
  assert(['manifest','connection','lock','identity','ledger','objects','rollback'].includes(receipt.stage));
  assert(Object.keys(receipt).every(key=>['status','code','stage','reason','version','sqlState','historyDiagnostic'].includes(key)));
  if(receipt.version) assert.match(receipt.version,/^\d{4}$/);
  assert(!JSON.stringify(receipt).includes('synthetic secret'));
  assert.equal(result.ends,result.connects);
}
function rejected(fixture, change = () => {}) {
  const witness = fixture.rows[0];
  const attempt = {...witness,status:'failed',checksum_sha256:'a'.repeat(64),duration_ms:0,statement_count:null,requires_rebuild:false};
  attempt.failure_reason = `Checksum mismatch for ${witness.version}_${witness.name}.sql: ledger has ${witness.checksum_sha256}, file is ${attempt.checksum_sha256}`;
  change(attempt,witness);
  witness.history_order=2;
  fixture.rows.unshift(attempt);
}
const diagnosed=await audit(f=>rejected(f,a=>{a.failure_reason='synthetic secret must never leave task';a.duration_ms=12;}));
assert.equal(diagnosed.output[0].historyDiagnostic.exactChecksumRejection,false);
assert.equal(diagnosed.output[0].historyDiagnostic.zeroDuration,false);
assert(Object.values(diagnosed.output[0].historyDiagnostic).every(value=>typeof value==='boolean'));
assert(!JSON.stringify(diagnosed.output).includes('synthetic secret'));
const rejection = await audit(f=>rejected(f));
assert.equal(rejection.exitCode,0);
assert.equal(rejection.output[0].rejectedChecksums,1);
for (const change of [
  a=>a.failure_reason+=' unexpected', a=>a.duration_ms=1, a=>a.statement_count=0,
  a=>a.requires_rebuild=true, a=>a.status='rolled_forward', a=>a.environment='staging',
  a=>a.name='wrong', a=>a.checksum_sha256='bad', (a,w)=>a.checksum_sha256=w.checksum_sha256,
  (a,w)=>w.checksum_sha256='b'.repeat(64), (a,w)=>w.status='failed',
  a=>a.history_order=2,
]) assert.equal((await audit(f=>rejected(f,change))).exitCode,1);
for (const status of ['failed','rolled_forward']) {
  const result=await audit(f=>{
    rejected(f);
    const witness=f.rows[1]; witness.history_order=3;
    f.rows.splice(1,0,{...f.rows[0],history_order:2,status,failure_reason:'unresolved execution failure'});
  });
  assert.equal(result.exitCode,1);
  assert.equal(result.output[0].reason,'unresolved_history');
}
const twice = await audit(f=>{
  rejected(f);f.rows[1].history_order=3;
  f.rows.splice(1,0,{...f.rows[0],history_order:2});
});
assert.equal(twice.exitCode,0);assert.equal(twice.output[0].rejectedChecksums,2);
for(const code of ['42501','synthetic secret must never leave task']) {
  const result=await audit(f=>{f.databaseFailure=true;f.databaseFailureCode=code;});
  assert.equal(result.output[0].stage,'lock');
  assert.equal(result.output[0].sqlState,code==='42501' ? code : undefined);
  assert(!JSON.stringify(result.output).includes('synthetic secret'));
}
for(const url of [ownerUrl.replace('rds.amazonaws.com','unsafe.invalid'),ownerUrl.replace('5432','5433'),
  ownerUrl.replace('vayada_admin:','other:'),ownerUrl.replace('/postgres?','/other?'),ownerUrl+'&options=unsafe',ownerUrl+'#fragment']) {
  const result=await audit(f=>f.url=url);
  assert.equal(result.exitCode,1); assert.equal(result.connects,0);
}
console.log('PASS: fixed pending hashes, full prior ledger parity, unresolved/unknown rows, partial schema, exclusive read-only snapshot, TLS destination and sanitized failures');
