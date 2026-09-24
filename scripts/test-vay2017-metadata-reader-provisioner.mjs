import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { scramVerifier } from './vay2017-pg-scram.mjs';
const source = await readFile(new URL('./provision-vay2017-metadata-reader.mjs', import.meta.url), 'utf8');

test('bootstrap is fixed and never logs credentials', () => {
  for (const pattern of [/vay2017-metadata-rehearsal-isolated-20260923/, /vay2017-legacy-source-freeze-20260920/, /!\/\^10\\\.230\\\.0\\\./, /randomBytes\(36\)/, /PutSecretValueCommand/, /console\.(?:log|error)\s*\([\s\S]{0,120}?(?:password|SecretString)/i]) pattern instanceof RegExp && pattern.source.startsWith('console') ? assert.doesNotMatch(source, pattern) : assert.match(source, pattern);
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

test('count helper is fixed, definer-owned, and cannot expose row values', () => {
  for (const pattern of [/SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET row_security = off/, /pg_catalog\.format\('SELECT count\(\*\)::text FROM %I\.%I'/, /c\.relkind IN \('r', 'p'\)/, /p\.proargtypes\[0\] = 'pg_catalog\.text'::pg_catalog\.regtype::oid/, /p\.proargtypes\[1\] = 'pg_catalog\.text'::pg_catalog\.regtype::oid/, /REVOKE TEMPORARY ON DATABASE .* FROM PUBLIC/, /REVOKE CONNECT ON DATABASE .* FROM PUBLIC/]) assert.match(source, pattern);
});
