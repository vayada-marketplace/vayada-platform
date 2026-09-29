import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const HOST = 'vay2017-source-import-20260929.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com';
const SNAPSHOT = 'arn:aws:rds:eu-west-1:269416271598:snapshot:vay2017-legacy-source-20260929';
const RUN_ID = 'vay1351-61ec013e79ed2a042caadef8';
const READER = 'vay2017_source_reader_20260929';
const CA_FILE = '/tmp/vay2017-rds-ca.pem';
const REVISION = '215242008bb990c25f65bd5c03099d56015a29cb';
const DATABASES = {
  auth: ['vayada_auth_db', 'ebbf75656597007f4c5a736f74482c3e'],
  booking: ['vayada_booking_db', '0ae3f6e449708cfdfdd886be4541eb04'],
  marketplace: ['postgres', '97552844754fc30325143c7912273f52'],
  pms: ['vayada_pms_db', '4fe52548cc01dd331db33b9f714c677c'],
};
const fail = (code) => { throw new Error(code); };
const exactUrl = (raw, host, path, username) => {
  const url = new URL(raw ?? '');
  if (url.protocol !== 'postgresql:' || url.hostname !== host || url.port !== '5432' ||
      url.pathname !== path || (username && url.username !== username) || !url.password ||
      url.search !== '?sslmode=require' || url.hash) fail('source_import_url_invalid');
  return url;
};
const verifiedUrl = (url) => {
  url.search = '';
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', CA_FILE);
  return url.toString();
};

try {
  if (process.env.VAY2017_SOURCE_IMPORT_PHASE !== 'extract') fail('source_import_environment_invalid');
  const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE ?? '';
  if (new X509Certificate(ca).fingerprint256 !== '6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86')
    fail('source_import_ca_invalid');
  writeFileSync(CA_FILE, ca, { mode: 0o600 });
  const reader = exactUrl(process.env.VAY2017_SOURCE_READER_URL, HOST, '/postgres', READER);
  const target = exactUrl(
    process.env.TARGET_DATABASE_MIGRATION_URL,
    'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com',
    '/vayada_target_prod',
  );
  const manifest = '/tmp/vay2017-source-manifest.json';
  writeFileSync(manifest, JSON.stringify({
    version: 1,
    environment: 'preprod',
    sourceSchemaRevision: REVISION,
    historicalInventorySha256: '6f8b071328eb888c570a31dbc08f5dde2d68f4ff605611457b3ba23ebfba1e10',
    sources: Object.fromEntries(Object.entries(DATABASES).map(([source, [database, fingerprint]]) => [
      source,
      { snapshotIdentifier: SNAPSHOT, expectedDatabaseName: database, expectedSchemaFingerprint: fingerprint },
    ])),
  }), { mode: 0o600 });
  const env = { ...process.env, TARGET_DATABASE_URL: verifiedUrl(target) };
  for (const [source, [database]] of Object.entries(DATABASES)) {
    const url = new URL(reader);
    url.pathname = `/${database}`;
    env[`${source.toUpperCase()}_SOURCE_DATABASE_URL`] = verifiedUrl(url);
  }
  const result = spawnSync(process.execPath, [
    '/app/packages/backend-migration/dist/cli/sourceExtract.js',
    '--manifest', manifest,
    '--source-schema-revision', REVISION,
    ...Object.keys(DATABASES).flatMap((source) => [`--${source}-snapshot-arn`, SNAPSHOT]),
  ], { encoding: 'utf8', env, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) {
    const code = /^([A-Z][A-Z0-9_]{2,63}):/m.exec(result.stderr)?.[1]?.toLowerCase();
    fail(code ?? 'source_extraction_failed');
  }
  const report = JSON.parse(result.stdout);
  if (report.runId !== RUN_ID || report.status !== 'completed' || report.sources?.length !== 4)
    fail('source_extraction_report_invalid');
  console.log(JSON.stringify({
    status: 'complete',
    runId: report.runId,
    sources: report.sources.map(({ sourceDatabase, rowCount, checksumSha256 }) => ({
      sourceDatabase, rowCount, checksumSha256,
    })),
  }));
} catch (error) {
  const code = /^[a-z0-9_]{3,64}$/.test(error?.message ?? '') ? error.message : 'source_import_failed';
  console.error(JSON.stringify({ status: 'FAIL', code }));
  process.exitCode = 1;
}
