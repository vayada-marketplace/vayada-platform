import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { scramVerifier } from './vay2017-pg-scram.mjs';

const source = await readFile(new URL('./provision-vay2017-metadata-reader.mjs', import.meta.url), 'utf8');

test('bootstrap is pinned to the isolated restore and stores no credential in logs', () => {
  assert.match(source, /vay2017-metadata-rehearsal-isolated-20260923/);
  assert.match(source, /vay2017-legacy-source-freeze-20260920/);
  assert.match(source, /!\/\^10\\\.230\\\.0\\\./);
  assert.match(source, /randomBytes\(36\)/);
  assert.match(source, /PutSecretValueCommand/);
  assert.doesNotMatch(source, /console\.(?:log|error)\s*\([\s\S]{0,120}?(?:password|SecretString)/i);
});

test('database receives only a SCRAM verifier while Secrets Manager receives the generated password', () => {
  const password = 'known-random-password';
  const verifier = scramVerifier(password, Buffer.from('0123456789abcdef'));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
  assert.doesNotMatch(verifier, new RegExp(password));
  assert.match(source, /provisionRole\(discoveryClient, passwordVerifier/);
  assert.match(source, /SecretString: JSON\.stringify\(\{ username: reader, password \}\)/);
});

test('reader role is fresh-or-verified, has no effective membership, and has no app-data write access', () => {
  assert.match(source, /NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2/);
  assert.match(source, /member_role\.rolname = \$1 OR granted_role\.rolname = \$1/);
  assert.match(source, /m\.grantor = 10::oid AND m\.admin_option[\s\S]*NOT m\.set_option AND NOT m\.inherit_option/);
  assert.match(source, /pg_catalog\.pg_shdepend/);
  assert.match(source, /has_table_privilege\(\$1, c\.oid, 'TRUNCATE'\)/);
  assert.match(source, /has_any_column_privilege\(\$1, c\.oid, 'UPDATE'\)/);
  assert.match(source, /has_sequence_privilege\(\$1, c\.oid, 'UPDATE'\)/);
  assert.match(source, /has_database_privilege\(\$1, d\.oid, 'CREATE'\)/);
  assert.match(source, /has_schema_privilege\(\$1, n\.oid, 'CREATE'\)/);
  assert.match(source, /can_execute_other_definer_routine/);
  assert.match(source, /existingRole\.rowCount > 0\)[\s\S]*readerPrivilegeCheck[\s\S]*provisionRole/);
});

test('role creation sends PostgreSQL a SCRAM verifier, never the generated plaintext password', () => {
  assert.match(source, /PASSWORD %L/);
  assert.match(source, /provisionRole\(discoveryClient, passwordVerifier/);
  const password = 'known-random-password';
  const verifier = scramVerifier(password, Buffer.from('0123456789abcdef'));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
  assert.doesNotMatch(verifier, new RegExp(password));
});

test('row counts use one exact fixed SECURITY DEFINER function with safe catalog validation', () => {
  assert.match(source, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET row_security = off/);
  assert.match(source, /pg_catalog\.format\('SELECT count\(\*\)::text FROM %I\.%I'/);
  assert.match(source, /c\.relkind IN \('r', 'p'\)/);
  assert.match(source, /p\.proargtypes\[0\] = 'pg_catalog\.text'::pg_catalog\.regtype::oid/);
  assert.match(source, /p\.proargtypes\[1\] = 'pg_catalog\.text'::pg_catalog\.regtype::oid/);
  assert.match(source, /REVOKE TEMPORARY ON DATABASE .* FROM PUBLIC/);
  assert.match(source, /REVOKE CONNECT ON DATABASE .* FROM PUBLIC/);
});
