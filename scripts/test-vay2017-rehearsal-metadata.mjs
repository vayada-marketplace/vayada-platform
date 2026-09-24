import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  collectMetadata,
  DATABASES_SQL,
  INVENTORY_SQL,
  SCHEMAS_SQL,
  sanitizeError,
  rowCountSql,
} from './vay2017-rehearsal-metadata.mjs';

const identity = {
  restoreInstanceId: 'vay2017-metadata-rehearsal-isolated-20260923',
  sourceSnapshotId: 'vay2017-legacy-source-freeze-20260920',
  restoreResourceId: 'db-NEWISOLATEDRESTORE123456',
  restoreInstanceArn: 'arn:aws:rds:eu-west-1:269416271598:db:vay2017-metadata-rehearsal-isolated-20260923',
  restoreAttestationChecksum: 'c'.repeat(64),
  imageDigest: `sha256:${'a'.repeat(64)}`,
  scannerSourceChecksum: 'b'.repeat(64),
  readerFunctionChecksum: 'd'.repeat(64),
};

function fakeConnect(calls, connections) {
  return async (databaseName) => {
    connections.push(databaseName);
    return {
      async query(sql, values) {
        calls.push({ databaseName, sql, values });
        if (sql.startsWith('SHOW')) return { rows: [{ transaction_read_only: 'on' }] };
        if (sql === DATABASES_SQL) return { rows: [{ database_name: 'app_db' }, { database_name: 'postgres' }] };
        if (sql === SCHEMAS_SQL) return { rows: [{ schema_name: 'empty_schema' }, { schema_name: 'public' }] };
        if (sql === INVENTORY_SQL) return { rows: [
          { schema_name: 'public', table_name: 'reservations', column_ordinal: 1, column_name: 'id', data_type: 'uuid', not_null: true, primary_key: true, primary_key_ordinal: 1 },
          { schema_name: 'public', table_name: 'reservations', column_ordinal: 2, column_name: 'guest_name', data_type: 'text', not_null: false, primary_key: false, primary_key_ordinal: null },
        ] };
        if (sql.startsWith('SELECT vay2017_metadata.count_table_rows(')) return { rows: [{ row_count: '10' }] };
        return { rows: [] };
      },
      async end() {},
    };
  };
}

test('inventory queries read database, schema, and table catalogs; exact counts are isolated', () => {
  assert.match(DATABASES_SQL, /pg_catalog\.pg_database/);
  assert.match(DATABASES_SQL, /NOT datistemplate/);
  assert.match(SCHEMAS_SQL, /pg_catalog\.pg_namespace/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_class/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_namespace/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_attribute/);
  assert.match(INVENTORY_SQL, /pg_catalog\.pg_index/);
  assert.doesNotMatch(INVENTORY_SQL, /reltuples/);
  assert.doesNotMatch(INVENTORY_SQL, /\bSELECT\s+\*\b|\bFROM\s+(?!pg_catalog\.)[a-z_][\w.]*/i);
  assert.doesNotMatch(INVENTORY_SQL, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
  assert.match(SCHEMAS_SQL, /nspname <> 'vay2017_metadata'/);
  assert.match(INVENTORY_SQL, /n\.nspname <> 'vay2017_metadata'/);
  assert.equal(
    rowCountSql(),
    'SELECT vay2017_metadata.count_table_rows($1, $2) AS row_count',
  );
});

test('metadata collection inventories every database and empty schema with exact counts', async () => {
  const calls = [];
  const connections = [];
  const artifact = await collectMetadata(fakeConnect(calls, connections), identity, '2026-09-21T00:00:00.000Z');
  assert.deepEqual(connections, ['postgres', 'app_db', 'postgres']);
  assert.equal(calls.filter(({ sql }) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 3);
  assert.equal(calls.filter(({ sql }) => sql === "SET LOCAL statement_timeout = '15min'").length, 2);
  assert.deepEqual(calls.filter(({ sql }) => sql === rowCountSql()).map(({ values }) => values), [
    ['public', 'reservations'], ['public', 'reservations'],
  ]);
  assert.equal(calls.filter(({ sql }) => sql === 'COMMIT').length, 3);
  assert.deepEqual(artifact.databases.map(({ name }) => name), ['app_db', 'postgres']);
  assert.deepEqual(artifact.databases[0].schemas, ['empty_schema', 'public']);
  assert.deepEqual(artifact.databases[0].tables[0].primaryKey, [{ name: 'id', ordinal: 1 }]);
  assert.equal(artifact.databases[0].tables[0].rowCount, '10');
  assert.match(artifact.rowCountSemantics, /exact COUNT\(\*\)/);
  assert.equal(artifact.imageDigest, identity.imageDigest);
  assert.equal(artifact.scannerSourceChecksum, identity.scannerSourceChecksum);
  assert.equal(artifact.readerFunctionChecksum, identity.readerFunctionChecksum);
  assert.equal(artifact.artifactVersion, 2);
  assert.equal(artifact.queryVersion, 'v2');
  assert.equal(artifact.restoreResourceId, identity.restoreResourceId);
  assert.equal(artifact.restoreInstanceArn, identity.restoreInstanceArn);
  assert.equal(artifact.restoreAttestationChecksum, identity.restoreAttestationChecksum);
  assert.equal(JSON.stringify(artifact).includes(identity.sourceSnapshotId), true);
  assert.equal(JSON.stringify(artifact).includes('guest_name'), true);
  assert.equal(JSON.stringify(artifact).includes('customer@example.test'), false);
  assert.match(artifact.schemaFingerprint, /^[a-f0-9]{64}$/);
  assert.match(artifact.queryChecksum, /^[a-f0-9]{64}$/);
});

test('wrong restore, snapshot, and image identities fail before queries', async () => {
  for (const change of [
    { restoreInstanceId: 'vayada-database' },
    { sourceSnapshotId: 'another-snapshot' },
    { imageDigest: 'sha256:latest' },
    { readerFunctionChecksum: 'not-a-checksum' },
  ]) {
    const calls = [];
    const connections = [];
    await assert.rejects(collectMetadata(fakeConnect(calls, connections), { ...identity, ...change }));
    assert.equal(calls.length, 0);
    assert.equal(connections.length, 0);
  }
});

test('sanitized errors omit raw messages, hosts, and credentials but retain safe phase and class', () => {
  const output = JSON.stringify(sanitizeError(new Error('postgres://user:secret@db.example.test')));
  assert.deepEqual(JSON.parse(output), {
    status: 'FAIL', stage: 'metadata-read', code: 'UNKNOWN', errorClass: 'Error',
  });
  assert.doesNotMatch(output, /secret|db\.example|postgres:\/\//);
});

test('sanitized errors preserve only known internal, PostgreSQL, and connection error codes', () => {
  assert.equal(sanitizeError(new Error('row_count_invalid')).code, 'row_count_invalid');
  assert.equal(sanitizeError({ code: '23505', message: 'duplicate key details' }).code, '23505');
  assert.equal(sanitizeError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(sanitizeError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }).code, 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.equal(sanitizeError({ code: 'password-is-secret', message: 'password-is-secret' }).code, 'UNKNOWN');
  const phaseError = Object.assign(new Error('metadata_read_failed', {
    cause: Object.assign(new Error('password=secret host=db.private'), { code: '42501' }),
  }), { metadataPhase: 'schema-inventory' });
  const safe = sanitizeError(phaseError);
  assert.deepEqual(safe, {
    status: 'FAIL', stage: 'schema-inventory', code: '42501', errorClass: 'Error',
  });
  assert.doesNotMatch(JSON.stringify(safe), /secret|db\.private/);
});

test('failed catalog reads report their safe phase and SQLSTATE only', async () => {
  const calls = [];
  const connect = async () => ({
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SHOW')) return { rows: [{ transaction_read_only: 'on' }] };
      if (sql === DATABASES_SQL) return { rows: [{ database_name: 'app_db' }] };
      if (sql === SCHEMAS_SQL) {
        throw Object.assign(new Error('password=secret relation=private'), { code: '42501' });
      }
      return { rows: [] };
    },
    async end() {},
  });
  await assert.rejects(
    collectMetadata(connect, identity),
    (error) => {
      const safe = sanitizeError(error);
      assert.deepEqual(safe, {
        status: 'FAIL', stage: 'schema-inventory', code: '42501', errorClass: 'Error',
      });
      assert.doesNotMatch(JSON.stringify(safe), /secret|private/);
      return true;
    },
  );
  assert.equal(calls.includes('ROLLBACK'), true);
});

test('runner contains no row-value query or caller-controlled SQL', async () => {
  const source = await readFile(new URL('./vay2017-rehearsal-metadata.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env\.[A-Z0-9_]+\s*\|\|\s*['"`].*SELECT/i);
  assert.match(source, /transaction_timeout|statement_timeout/);
  assert.match(source, /SET LOCAL statement_timeout = '15min'/);
  assert.match(source, /rejectUnauthorized:\s*true/);
  assert.match(source, /VAY2017_RDS_CA_BUNDLE_GZIP/);
  assert.match(source, /ca:\s*caBundle,[\s\S]*rejectUnauthorized:\s*true[\s\S]*servername:\s*process\.env\.VAY2017_DB_HOST/);
});

test('scanner trusts only the pinned regional RDS root', async () => {
  const pem = await readFile(new URL('../rehearsal/rds-ca-rsa2048-g1.pem', import.meta.url), 'utf8');
  assert.equal(new X509Certificate(pem).fingerprint256, '6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86');
});

test('infrastructure keeps execution fixed and network access private and narrow', async () => {
  const tf = await readFile(new URL('../infra/vay2017-metadata-runner/runner.tf', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../infra/vay2017-metadata-runner/main.tf', import.meta.url), 'utf8');
  const lane = await readFile(new URL('../docs/vay2017-metadata-infrastructure-lane.md', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/vay2017-metadata-inventory.yml', import.meta.url), 'utf8');
  const runner = await readFile(new URL('./run-vay2017-rehearsal-metadata.sh', import.meta.url), 'utf8');
  const attestation = JSON.parse(await readFile(new URL('./fixtures/vay2017-isolated-restore-plan.json', import.meta.url), 'utf8'));
  const scannerTaskStart = tf.indexOf('resource "aws_ecs_task_definition" "vay2017_metadata"');
  const scannerTaskEnd = tf.indexOf('data "aws_iam_policy_document" "vay2017_state_machine_trust"', scannerTaskStart);
  const scannerTaskDefinition = tf.slice(scannerTaskStart, scannerTaskEnd);
  assert.match(tf, /AssignPublicIp\s*=\s*"DISABLED"/);
  assert.match(tf, /resource "aws_route_table_association" "vay2017_runner_private"/);
  assert.match(tf, /route_table_ids\s*=\s*\[aws_route_table\.vay2017_runner_private\.id\]/);
  assert.match(tf, /resource "aws_db_instance" "vay2017_isolated_restore"/);
  assert.match(tf, /snapshot_identifier\s*=\s*local\.vay2017_rehearsal_snapshot_id/);
  assert.match(tf, /manage_master_user_password\s*=\s*true/);
  assert.match(tf, /lifecycle\s*\{\s*prevent_destroy\s*=\s*true/s);
  assert.match(tf, /db_subnet_group_name\s*=\s*aws_db_subnet_group\.vay2017_isolated_restore\.name/);
  assert.match(tf, /vpc_security_group_ids\s*=\s*\[aws_security_group\.vay2017_rehearsal_database\.id\]/);
  assert.doesNotMatch(tf, /vay2017-legacy-rehearsal-20260921/);
  assert.match(tf, /resource "aws_vpc_endpoint" "vay2017_interface"/);
  assert.match(tf, /resource "aws_vpc_security_group_egress_rule" "vay2017_runner_postgres"/);
  assert.match(tf, /resource "aws_vpc_security_group_egress_rule" "vay2017_runner_https"/);
  assert.match(tf, /resource "aws_vpc_security_group_egress_rule" "vay2017_runner_ecr_s3"/);
  assert.doesNotMatch(tf, /0\.0\.0\.0\/0|nat_gateway|\bpublic_ip\s*=\s*true|assign_public_ip\s*=\s*true/i);
  assert.match(tf, /aws_secretsmanager_secret\.vay2017_reader_credentials\.arn}:username::/);
  assert.match(tf, /aws_secretsmanager_secret\.vay2017_reader_credentials\.arn}:password::/);
  assert.doesNotMatch(scannerTaskDefinition, /master_user_secret\[0\]\.secret_arn/);
  assert.match(scannerTaskDefinition, /execution_role_arn\s*=\s*aws_iam_role\.vay2017_inventory_execution\.arn/);
  assert.match(tf, /VAY2017_DB_HOST"\s*,\s*value\s*=\s*aws_db_instance\.vay2017_isolated_restore\.address/);
  assert.match(tf, /VAY2017_DB_PORT"\s*,\s*value\s*=\s*tostring\(aws_db_instance\.vay2017_isolated_restore\.port\)/);
  assert.doesNotMatch(tf, /VAY2017_DB_HOST"\s*,\s*valueFrom|VAY2017_DB_PORT"\s*,\s*valueFrom/);
  assert.match(tf, /"secretsmanager:GetSecretValue"/);
  assert.doesNotMatch(tf, /ec2:Describe|rds:Describe|ecr:DescribeImages/);
  assert.doesNotMatch(tf, /data "aws_(vpc|db_instance|db_snapshot|ecr_repository|prefix_list)"/);
  assert.match(tf, /vay2017-metadata-rehearsal-isolated-20260923/);
  assert.match(tf, /vay2017-legacy-source-freeze-20260920/);
  assert.match(tf, /filesha256\([\s\S]*vay2017-isolated-restore-plan\.json/);
  assert.doesNotMatch(tf, /aws_vpc_peering_connection|aws_route\s+"|vay2017_rehearsal_source_vpc/);
  assert.match(tf, /10\.230\.0\.0\/24/);
  assert.doesNotMatch(tf, /0\.0\.0\.0\/0|nat_gateway|publicly_accessible\s*=\s*true/i);
  assert.doesNotMatch(tf, /target-database-url|target-database-runtime-url|db-marketplace-url|vayada-database\.c7eiqkoq4as4/);
  assert.match(tf, /"taskArn\.\$"\s*=\s*"\$\.Tasks\[0\]\.TaskArn"/);
  assert.match(tf, /DescribeCompletedMetadataTask[\s\S]*aws-sdk:ecs:describeTasks[\s\S]*States\.Array\(\$\.result\.taskArn\)[\s\S]*"containerExitCode\.\$"\s*=\s*"\$\.Tasks\[0\]\.Containers\[0\]\.ExitCode"[\s\S]*"stopCode\.\$"\s*=\s*"\$\.Tasks\[0\]\.StopCode"[\s\S]*ResultPath\s*=\s*"\$\.completion"/);
  assert.match(tf, /TimeoutSeconds\s*=\s*3600/);
  assert.match(tf, /StepFunctionsGetEventsForECSTaskRule/);
  assert.doesNotMatch(tf, /sid\s*=\s*"ManageStepFunctionsCompletionRule"[\s\S]*resources\s*=\s*\["\*"\]/);
  assert.match(await readFile(new URL('../.github/workflows/tf-validate.yml', import.meta.url), 'utf8'), /docs\/vay2017-metadata-infrastructure-lane\.md/);
  assert.doesNotMatch(tf, /Overrides|commandOverrides|ecs:RunTask.*\*/i);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: vay2017-metadata-preflight/);
  assert.match(runner, /\.completion\.containerExitCode/);
  assert.match(runner, /\.completion\.stopCode/);
  assert.doesNotMatch(runner, /fromjson/);
  assert.match(runner, /deadline=\$\(\(SECONDS \+ 3900\)\)/);
  assert.match(await readFile(new URL('../.github/workflows/vay2017-metadata-inventory.yml', import.meta.url), 'utf8'), /timeout-minutes:\s*70/);
  assert.match(tf, /repo:vayada-marketplace\/vayada-platform:environment:vay2017-metadata-preflight/);
  assert.match(workflow, /role\/vayada-github-actions-vay2017-metadata/);
  assert.doesNotMatch(workflow, /vayada-github-actions-platform-deploy/);
  assert.doesNotMatch(workflow, /inputs:|workflow_call:/);
  assert.match(runner, /--input '\{\}'/);
  assert.doesNotMatch(runner, /check-vay2017-rehearsal-isolation\.sh/);
  const isolation = await readFile(new URL('./check-vay2017-rehearsal-isolation.sh', import.meta.url), 'utf8');
  assert.match(isolation, /describe-vpc-attribute/);
  assert.match(isolation, /describe-images/);
  assert.match(isolation, /describe-internet-gateways/);
  assert.match(isolation, /describe-nat-gateways/);
  assert.match(isolation, /describe-vpc-peering-connections/);
  assert.match(isolation, /restore still uses a shared or unexpected security group/);
  assert.equal(attestation.sourceDatabaseId, 'vayada-database');
  assert.equal(attestation.sourceSnapshotId, identity.sourceSnapshotId);
  assert.match(runner, /restoreAttestationChecksum/);
  assert.match(runner, /reader_function_checksum=.*provision-vay2017-metadata-reader\.mjs/);
  assert.match(runner, /\.readerFunctionChecksum == \$reader_function_checksum/);
  assert.equal(attestation.restoreInstanceId, identity.restoreInstanceId);
  assert.equal(attestation.targetVpcCidr, '10.230.0.0/24');
  assert.doesNotMatch(runner, /aws\s+(rds\s+modify|ec2\s+authorize|iam\s+|ecs\s+run-task)/);
  assert.match(backend, /key\s*=\s*"vay2017\/metadata-runner\/terraform\.tfstate"/);
  assert.doesNotMatch(backend, /key\s*=\s*"platform\/terraform\.tfstate"/);
  assert.match(backend, /allowed_account_ids\s*=\s*\[local\.vay2017_rehearsal_account_id\]/);
  assert.match(tf, /vay2017_rehearsal_account_id\s*=\s*"269416271598"/);
  assert.doesNotMatch(tf, /var\.aws_account_id/);
  assert.match(lane, /platform state address list\s+contains no `aws_\*` resource/i);
  assert.match(lane, /zero deletes or replacements/i);
});
