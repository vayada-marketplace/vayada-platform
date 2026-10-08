// VAY-1362: runs one allow-listed backend-migration CLI inside the pinned next-api image.
// Terraform embeds this file as the task command; the reviewed workflow only sets
// LEGACY_MIGRATION_COMMAND, LEGACY_MIGRATION_ARGS and LEGACY_MIGRATION_FILES.
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
  'target:cutover:dry-run': ['source', 'cutover.js', 'dry-run'],
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
let files;
try {
  args = JSON.parse(process.env.LEGACY_MIGRATION_ARGS ?? '');
  files = JSON.parse(process.env.LEGACY_MIGRATION_FILES || '{}');
} catch {
  refuse('inputs_invalid');
}
if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.length > 512 || /[\0\n]/.test(arg)))
  refuse('arguments_invalid');
if (!files || typeof files !== 'object' || Array.isArray(files)) refuse('files_invalid');

// Reviewed JSON inputs (manifest, reports) arrive gzip+base64 and are referenced as "@name".
const paths = {};
const directory = mkdtempSync(join(tmpdir(), 'legacy-migration-'));
for (const [name, encoded] of Object.entries(files)) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || typeof encoded !== 'string') refuse('files_invalid');
  let text;
  try {
    text = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 1024 * 1024 }).toString('utf8');
    JSON.parse(text);
  } catch {
    refuse('files_invalid');
  }
  paths[name] = join(directory, `${name}.json`);
  writeFileSync(paths[name], text, { mode: 0o600 });
}
const argv = args.map((arg) => {
  if (!arg.startsWith('@')) return arg;
  if (!Object.hasOwn(paths, arg.slice(1))) refuse('file_missing');
  return paths[arg.slice(1)];
});

console.log(JSON.stringify({ status: 'START', command, argv }));
const result = spawnSync(process.execPath, [join(CLI, script), ...subcommand, ...argv], { stdio: 'inherit' });
// Keep the CLI exit code: cutover uses 2 (NO-GO), 3 (review) and 4 (awaiting smoke).
process.exit(result.status ?? 1);
