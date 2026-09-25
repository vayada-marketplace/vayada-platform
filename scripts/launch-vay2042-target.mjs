import { randomUUID, X509Certificate } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import manifest from './fixtures/vay2042-source-reader.json' with { type: 'json' };
import { provisionTarget, target, writer } from './provision-vay2042-target.mjs';

const region = 'eu-west-1';
const account = '269416271598';
export const secretName = 'vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925';
const secretPrefix = `arn:aws:secretsmanager:${region}:${account}:secret:${secretName}-`;
const attestation = 'fe4c276728e025bb5b0ddf893042d4581a84b84317f7ce2f6e7080546d32ab16';
const caFingerprint = '6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86';
const requireTrue = (condition, code) => { if (!condition) throw new Error(code); };
const stages = new Set(['configuration', 'credential-destination', 'database-connect', 'target-bootstrap', 'credential-store']);
const codes = new Set([
  'configuration_invalid', 'database_ca_invalid', 'database_endpoint_invalid', 'credential_destination_not_empty',
  'target_bootstrap_busy', 'restore_database_inventory_changed', 'target_writer_exists_inspect_prior_attempt',
  'target_database_exists_inspect_prior_attempt', 'target_database_connection_mismatch', 'target_template_not_clean',
  'target_writer_privilege_mismatch', 'target_writer_other_database_write', 'target_attestor_untrusted',
  'target_attestor_owns_routine', 'target_evidence_boundary_mismatch', 'target_writer_activation_outcome_unknown',
  '22023', '42501', '28P01', '3D000', '25006', '42704', '42P01',
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const classes = new Set(['Error', 'TypeError', 'RangeError', 'DatabaseError', 'AggregateError', 'AccessDeniedException', 'InvalidRequestException']);
export function safeFailure(stage, cause) {
  return { status: 'FAIL', stage: stages.has(stage) ? stage : 'configuration',
    code: codes.has(cause?.code) ? cause.code : codes.has(cause?.message) ? cause.message : 'UNKNOWN',
    errorClass: classes.has(cause?.name) ? cause.name : 'Other' };
}

export function configuration(env) {
  const host = env.VAY2042_DB_HOST ?? '';
  const secretArn = env.VAY2042_WRITER_SECRET_ARN ?? '';
  const hostPrefix = `${manifest.restoreInstanceId}.`;
  requireTrue(
    env.AWS_REGION === region && env.VAY2042_RESTORE_INSTANCE_ID === manifest.restoreInstanceId &&
    env.VAY2042_RESTORE_RESOURCE_ID === manifest.restoreResourceId &&
    env.VAY2042_SOURCE_SNAPSHOT_ID === manifest.sourceSnapshotId &&
    env.VAY2042_RESTORE_INSTANCE_ARN === `arn:aws:rds:${region}:${account}:db:${manifest.restoreInstanceId}` &&
    env.VAY2042_RESTORE_ATTESTATION_CHECKSUM === attestation &&
    env.VAY2042_DB_PORT === '5432' && env.VAY2042_DB_USER && env.VAY2042_DB_PASSWORD &&
    host.startsWith(hostPrefix) && /^[a-z0-9]+\.eu-west-1\.rds\.amazonaws\.com$/.test(host.slice(hostPrefix.length)) &&
    secretArn.startsWith(secretPrefix) && /^[A-Za-z0-9]{6}$/.test(secretArn.slice(secretPrefix.length)),
    'configuration_invalid',
  );
  let ca;
  try {
    ca = gunzipSync(Buffer.from(env.VAY2042_RDS_CA_BUNDLE_GZIP ?? '', 'base64'), { maxOutputLength: 16_384 }).toString('utf8');
    const certificate = new X509Certificate(ca);
    requireTrue(certificate.toString().replace(/\s/g, '') === ca.replace(/\s/g, '') && certificate.fingerprint256 === caFingerprint,
      'database_ca_invalid');
  } catch { throw new Error('database_ca_invalid'); }
  return { host, secretArn, ca };
}

export async function bootstrap(env, { Client, SecretsManagerClient, DescribeSecretCommand, PutSecretValueCommand, provision = provisionTarget }) {
  let stage = 'configuration';
  let secrets;
  try {
    const { host, secretArn, ca } = configuration(env);
    secrets = new SecretsManagerClient({ region, endpoint: `https://secretsmanager.${region}.amazonaws.com` });
    stage = 'credential-destination';
    const destination = await secrets.send(new DescribeSecretCommand({ SecretId: secretArn }));
    requireTrue(destination.ARN === secretArn && destination.Name === secretName && !destination.DeletedDate &&
      Object.keys(destination.VersionIdsToStages ?? {}).length === 0, 'credential_destination_not_empty');
    await provision({
      connect: async (database) => {
        requireTrue([...manifest.databases, target].includes(database), 'configuration_invalid');
        stage = 'database-connect';
        const client = new Client({ host, port: 5432, database,
          user: env.VAY2042_DB_USER, password: env.VAY2042_DB_PASSWORD,
          ssl: { ca, rejectUnauthorized: true, servername: host },
          connectionTimeoutMillis: 10_000, statement_timeout: 60_000,
          application_name: 'vay2042-target-bootstrap-v1' });
        client.on('error', () => {}); // Never print pg's raw asynchronous errors.
        try {
          await client.connect();
          const { rows } = await client.query('SELECT host(inet_server_addr()) AS address, current_database() AS database');
          requireTrue(rows.length === 1 && rows[0].database === database &&
            /^10\.230\.0\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(rows[0].address),
          'database_endpoint_invalid');
          stage = 'target-bootstrap';
          return client;
        } catch (error) { await client.end().catch(() => {}); throw error; }
      },
      persistCredential: async (credential) => {
        stage = 'credential-store';
        requireTrue(credential.username === writer && credential.database === target &&
          typeof credential.password === 'string' && /^[A-Za-z0-9_-]{48}$/.test(credential.password), 'configuration_invalid');
        await secrets.send(new PutSecretValueCommand({ SecretId: secretArn,
          ClientRequestToken: randomUUID(), SecretString: JSON.stringify({ username: writer, password: credential.password, database: target }) }));
        stage = 'target-bootstrap';
      },
    });
    return { status: 'OK', stage: 'complete', scope: 'isolated-fresh-target', bound: false };
  } catch (error) { return safeFailure(stage, error); }
  finally { secrets?.destroy(); }
}

if (process.env.VAY2042_RUN_TARGET_MAIN === '1') {
  let result;
  try {
    configuration(process.env);
    const [{ default: pg }, sdk] = await Promise.all([import('pg'), import('@aws-sdk/client-secrets-manager')]);
    result = await bootstrap(process.env, { Client: pg.Client, ...sdk });
  } catch (error) { result = safeFailure('configuration', error); }
  console.log(JSON.stringify(result));
  if (result.status !== 'OK') process.exitCode = 1;
}
