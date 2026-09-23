import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./provision-vay2017-metadata-reader.mjs', import.meta.url), 'utf8');

test('bootstrap is pinned to the isolated restore and stores no credential in logs', () => {
  assert.match(source, /vay2017-metadata-rehearsal-isolated-20260923/);
  assert.match(source, /vay2017-legacy-source-freeze-20260920/);
  assert.match(source, /!\/\^10\\\.230\\\.0\\\./);
  assert.match(source, /randomBytes\(36\)/);
  assert.match(source, /PutSecretValueCommand/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(?:password|SecretString)/i);
});

test('reader role is fresh-or-verified, non-owner, non-member, and has no app-data write access', () => {
  assert.match(source, /NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2/);
  assert.match(source, /member_role\.rolname = \$1 OR granted_role\.rolname = \$1/);
  assert.match(source, /pg_catalog\.pg_shdepend/);
  assert.match(source, /has_table_privilege\(\$1, c\.oid, 'TRUNCATE'\)/);
  assert.match(source, /has_any_column_privilege\(\$1, c\.oid, 'UPDATE'\)/);
  assert.match(source, /has_sequence_privilege\(\$1, c\.oid, 'UPDATE'\)/);
  assert.match(source, /has_database_privilege\(\$1, d\.oid, 'CREATE'\)/);
  assert.match(source, /has_schema_privilege\(\$1, n\.oid, 'CREATE'\)/);
  assert.match(source, /can_execute_other_definer_routine/);
  assert.match(source, /existingRole\.rowCount > 0\)[\s\S]*readerPrivilegeCheck[\s\S]*provisionRole/);
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
