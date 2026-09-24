import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { scramVerifier } from './vay2017-pg-scram.mjs';
const source = await readFile(new URL('./provision-vay2017-metadata-reader.mjs', import.meta.url), 'utf8');
const rdsCa = await readFile(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), 'utf8');

test('bootstrap is fixed and never logs credentials', () => {
  for (const pattern of [/vay2017-metadata-rehearsal-isolated-20260923/, /vay2017-legacy-source-freeze-20260920/, /!\/\^10\\\.230\\\.0\\\./, /randomBytes\(36\)/, /PutSecretValueCommand/, /console\.(?:log|error)\s*\([\s\S]{0,120}?(?:password|SecretString)/i]) pattern instanceof RegExp && pattern.source.startsWith('console') ? assert.doesNotMatch(source, pattern) : assert.match(source, pattern);
});

test('bootstrap pins the regional RDS root and verifies endpoint identity', () => {
  assert.equal(new X509Certificate(rdsCa).fingerprint256, '6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86');
  assert.match(source, /VAY2017_RDS_CA_BUNDLE_GZIP/);
  assert.match(source, /function adminClient\(database, ca\)[\s\S]*ca,[\s\S]*rejectUnauthorized:\s*true[\s\S]*servername:\s*process\.env\.VAY2017_DB_HOST/);
  assert.match(source, /SELF_SIGNED_CERT_IN_CHAIN/);
  assert.match(source, /database_ca_invalid/);
});

test('role is restricted and only the PG16+ admin-only creator edge is tolerated', () => {
  for (const pattern of [/NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2/, /member_role\.rolname = \$1 OR granted_role\.rolname = \$1/, /m\.grantor = 10::oid AND m\.admin_option[\s\S]*NOT m\.set_option AND NOT m\.inherit_option/, /pg_catalog\.pg_shdepend/, /has_table_privilege\(\$1, c\.oid, 'TRUNCATE'\)/, /has_any_column_privilege\(\$1, c\.oid, 'UPDATE'\)/, /has_sequence_privilege\(\$1, c\.oid, 'UPDATE'\)/, /has_database_privilege\(\$1, d\.oid, 'CREATE'\)/, /has_schema_privilege\(\$1, n\.oid, 'CREATE'\)/, /can_execute_other_definer_routine/, /existingRole\.rowCount > 0\)[\s\S]*readerPrivilegeCheck[\s\S]*provisionRole/]) assert.match(source, pattern);
});

test('database receives a SCRAM verifier; Secrets Manager receives the generated password', () => {
  assert.match(source, /PASSWORD %L/); assert.match(source, /provisionRole\(discoveryClient, passwordVerifier/);
  const password = 'known-random-password'; const verifier = scramVerifier(password, Buffer.from('0123456789abcdef'));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
  assert.doesNotMatch(verifier, new RegExp(password));
  assert.match(source, /SecretString: JSON\.stringify\(\{ username: reader, password \}\)/);
});

test('bootstrap source has no relative imports when run with Node -e', () => {
  assert.doesNotMatch(source, /\bfrom\s+['"]\.\//);
});

test('bootstrap failures identify a fixed safe substep without source names', () => {
  const diagnostics = source.slice(source.indexOf('const safeNetworkCodes'), source.indexOf('function trustedRdsCa'));
  const safeFailure = Function(`${diagnostics}\nreturn safeFailure;`)();
  assert.deepEqual(
    safeFailure('count-helper', { name: 'error', code: '42601', message: 'private database name and SQL' }),
    { status: 'FAIL', stage: 'count-helper', code: 'UNKNOWN', errorClass: 'Other' },
  );
  assert.equal(safeFailure('database-defaults', { name: 'DatabaseError', code: '42501' }).code, '42501');
  assert.match(source, /phase = 'database-connect';\s*await client\.connect\(\);[\s\S]*?phase = 'database-defaults';\s*await hardenDatabaseDefaults\(/);
  for (const [phase, operation] of [
    ['database-defaults', 'hardenDatabaseDefaults'],
    ['template-access', 'denyTemplateDatabaseAccess'],
    ['existing-reader-check', 'readerPrivilegeCheck'],
    ['reader-role-credential', 'provisionRole'],
    ['count-helper', 'provisionDatabase'],
  ]) {
    assert.match(source, new RegExp(`phase = '${phase}';[\\s\\S]*?await ${operation}\\(`));
  }
  assert.match(source, /stage: phases\.has\(phase\) \? phase : 'reader-role-discovery'/);
  assert.doesNotMatch(source, /console\.error\(error\)|console\.error\(error\.message\)/);
});

test('count helper is fixed, definer-owned, and cannot expose row values', () => {
  for (const pattern of [/SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET row_security = off/, /pg_catalog\.format\('SELECT count\(\*\)::text FROM %I\.%I'/, /c\.relkind IN \('r', 'p'\)/, /p\.proargtypes\[0\] = 'pg_catalog\.text'::pg_catalog\.regtype::oid/, /p\.proargtypes\[1\] = 'pg_catalog\.text'::pg_catalog\.regtype::oid/, /REVOKE TEMPORARY ON DATABASE .* FROM PUBLIC/, /REVOKE CONNECT ON DATABASE .* FROM PUBLIC/]) assert.match(source, pattern);
});
