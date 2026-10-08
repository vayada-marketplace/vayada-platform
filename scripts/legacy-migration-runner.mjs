// VAY-1362: runs one allow-listed backend-migration CLI inside the pinned next-api image.
// Terraform embeds this file as the task command; the reviewed workflow only sets
// LEGACY_MIGRATION_COMMAND, LEGACY_MIGRATION_ARGS and LEGACY_MIGRATION_FILES.
// target:cutover:dry-run is not here: it needs a preprod target, never production.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const CLI = '/app/packages/backend-migration/dist/cli';
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

const paths = {};
if (Object.keys(files).length > 0) {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-migration-'));
  for (const [name, value] of Object.entries(files)) {
    paths[name] = join(directory, `${name}.json`);
    writeFileSync(paths[name], JSON.stringify(value), { mode: 0o600 });
  }
}
const argv = args.map((arg) => (arg.startsWith('@') ? paths[arg.slice(1)] : arg));

// Flag names only: values such as the operator stay out of the logs.
console.log(JSON.stringify({ status: 'START', command, flags: args.filter((arg) => arg.startsWith('--')) }));
const result = spawnSync(process.execPath, [join(CLI, script), ...subcommand, ...argv], { stdio: 'inherit' });
// Keep the CLI exit code: 0 done, 4 awaiting smoke, 1 failed (including PARITY_NOT_GO).
process.exit(result.status ?? 1);
