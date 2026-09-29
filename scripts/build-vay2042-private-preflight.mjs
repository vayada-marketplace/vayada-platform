import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const binary = process.env.ESBUILD_BINARY ?? 'esbuild';
if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== '0.28.0') {
  throw new Error('Private preflight bundle requires esbuild 0.28.0');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = new URL('./generated/vay2042-private-preflight.mjs', import.meta.url);
const bundle = execFileSync(binary, ['scripts/vay2042-private-preflight.mjs', '--bundle',
  '--packages=external', '--platform=node', '--format=esm', '--target=node22', '--log-level=error'],
{ cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 });
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== bundle) throw new Error('Private preflight bundle is stale');
} else {
  writeFileSync(destination, bundle);
}
