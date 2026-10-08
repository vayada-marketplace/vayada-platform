// VAY-1362: runs one allow-listed backend-migration CLI inside the pinned next-api image.
// scripts/legacy-migration-oneoff.sh embeds this file as the command of a one-off task
// definition, together with LEGACY_MIGRATION_COMMAND, LEGACY_MIGRATION_ARGS and LEGACY_MIGRATION_FILES.
// target:cutover:dry-run is not here: it needs a preprod target, never production.
// Every database URL is pinned (host, port, database, user) and rewritten to verify-full
// against the pinned RDS CA, which the definition carries as VAYADA_DB_RDS_CA_BUNDLE.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const CLI = '/app/packages/backend-migration/dist/cli';
const CA_SHA256 = 'f5c5f92ae025987c76dc49bdb1ace8556fdf332b4788d719a923bc274779d869';
const TARGET = { host: 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com', database: 'vayada_target_prod', user: 'vayada_target_prod_user' };
// The sources are the attested restore of the frozen legacy databases, never production legacy.
const SOURCE_DATABASES = { AUTH: 'vayada_auth_db', BOOKING: 'vayada_booking_db', MARKETPLACE: 'postgres', PMS: 'vayada_pms_db' };
// command -> [task kind, CLI file, subcommand...]; "target" tasks never get source or media access.
const COMMANDS = {
  'target:migration-status': ['target', 'cutover.js', 'status'],
  'target:cutover:abort': ['target', 'cutover.js', 'abort'],
  'target:source:extract': ['source', 'sourceExtract.js'],
  'target:cutover': ['source', 'cutover.js', 'cutover'],
};

const refuse = (code) => {
  console.error(JSON.stringify({ status: 'REFUSED', code }));
  process.exit(64);
};

const command = process.env.LEGACY_MIGRATION_COMMAND ?? '';
if (!Object.hasOwn(COMMANDS, command)) refuse('command_not_allowed');
const [kind, script, ...subcommand] = COMMANDS[command];
if (process.argv.at(-1) !== kind) refuse('command_not_allowed_for_task');

let args;
try {
  args = JSON.parse(process.env.LEGACY_MIGRATION_ARGS ?? '');
} catch {
  refuse('arguments_invalid');
}
if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 512 || /[\0\n]/.test(arg)))
  refuse('arguments_invalid');

// Reviewed JSON inputs (manifest, reports) arrive as one gzip+base64 object and are referenced as "@name".
let files = {};
try {
  if (process.env.LEGACY_MIGRATION_FILES)
    files = JSON.parse(gunzipSync(Buffer.from(process.env.LEGACY_MIGRATION_FILES, 'base64'), { maxOutputLength: 4 * 1024 * 1024 }));
} catch {
  refuse('files_invalid');
}
if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).some((name) => !/^[a-z][a-z0-9-]{0,31}$/.test(name)))
  refuse('files_invalid');
if (args.some((arg) => arg.startsWith('@') && !Object.hasOwn(files, arg.slice(1)))) refuse('file_missing');

const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE ?? '';
if (createHash('sha256').update(ca).digest('hex') !== CA_SHA256) refuse('rds_ca_invalid');
const pins = { TARGET_DATABASE_URL: TARGET };
if (kind === 'source') {
  const host = process.env.LEGACY_MIGRATION_SOURCE_HOST ?? '';
  const user = process.env.LEGACY_MIGRATION_SOURCE_USER ?? '';
  if (!/^[a-z][a-z0-9-]{0,62}\.c7eiqkoq4as4\.eu-west-1\.rds\.amazonaws\.com$/.test(host) || host === TARGET.host || !/^[a-z][a-z0-9_]{2,62}$/.test(user))
    refuse('source_pin_invalid');
  for (const [name, database] of Object.entries(SOURCE_DATABASES)) pins[`${name}_SOURCE_DATABASE_URL`] = { host, database, user };
}
const urls = {};
for (const [variable, pin] of Object.entries(pins)) {
  let url;
  try {
    url = new URL(process.env[variable] ?? '');
  } catch {
    refuse('database_url_not_pinned');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== pin.host || (url.port || '5432') !== '5432' ||
      url.pathname !== `/${pin.database}` || decodeURIComponent(url.username) !== pin.user || !url.password || url.hash)
    refuse('database_url_not_pinned');
  urls[variable] = url;
}

const directory = mkdtempSync(join(tmpdir(), 'legacy-migration-'));
const caFile = join(directory, 'rds-ca.pem');
writeFileSync(caFile, ca, { mode: 0o600 });
const env = { ...process.env };
for (const [variable, url] of Object.entries(urls)) {
  url.search = '';
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', caFile);
  env[variable] = url.toString();
}
const paths = {};
for (const [name, value] of Object.entries(files)) {
  paths[name] = join(directory, `${name}.json`);
  writeFileSync(paths[name], JSON.stringify(value), { mode: 0o600 });
}
const argv = args.map((arg) => (arg.startsWith('@') ? paths[arg.slice(1)] : arg));

// Flag names only: values such as the operator stay out of the logs.
console.log(JSON.stringify({ status: 'START', command, flags: args.filter((arg) => arg.startsWith('--')) }));
const result = spawnSync(process.execPath, [join(CLI, script), ...subcommand, ...argv], { stdio: 'inherit', env });
// Keep the CLI exit code: 0 done, 4 awaiting smoke, 1 failed (including PARITY_NOT_GO).
process.exit(result.status ?? 1);
