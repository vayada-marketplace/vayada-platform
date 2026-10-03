import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '/app/apps/api/dist/config.js';
const key = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555';
const env = {
  API_RUNTIME: 'next', PUBLIC_HOTEL_PROFILE_SOURCE: 'target',
  PMS_OPERATIONS_SOURCE: 'disabled', FINANCE_SOURCE: 'target',
  TARGET_DATABASE_URL: 'postgresql://api:fixture@localhost/target',
  PLATFORM_MEDIA_BUCKET: 'vayada-media-test',
  PLATFORM_MEDIA_CDN_BASE_URL: 'https://cdn.test.vayada.com',
  PLATFORM_MEDIA_CDN_ORIGIN_HOST: 'vayada-media-test.s3.eu-west-1.amazonaws.com',
  FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN: key,
  FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS: key,
  FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN: 'arn:aws:kms:eu-west-1:123456789012:key/99999999-8888-7777-6666-555555555555',
  FINANCE_EXPORT_WORKER_ENABLED: 'true',
  FINANCE_EXPORT_WORKER_DATABASE_URL: 'postgresql://vayada_next_finance_export_worker:fixture@localhost/target?sslmode=require',
  FINANCE_EXPORT_WORKER_PROPERTY_ID: '', FINANCE_EXPORT_WORKER_EXPORT_ID: '',
  FINANCE_EXPORT_WORKER_ACCEPTED_AFTER: '2026-09-25T00:00:00.000Z',
  NODE_EXTRA_CA_CERTS: '/synthetic/rds.pem',
};
const worker = loadConfig(env).financeExportWorker;
assert.equal(worker.acceptedAfter.toISOString(), env.FINANCE_EXPORT_WORKER_ACCEPTED_AFTER);
assert.match(worker.databaseUrl, /sslmode=verify-full/);
assert.throws(() => loadConfig({ ...env, NODE_EXTRA_CA_CERTS: '' }));
const launcher = readFileSync('/app/scripts/start-next-api.sh', 'utf8');
assert.match(launcher, /unset TARGET_DATABASE_MIGRATION_URL migration_database_url/);
assert.match(launcher, /exec node dist\/server\.js/);
console.log('PASS actual compiled ongoing export configuration and split launcher; synthetic credentials only');
