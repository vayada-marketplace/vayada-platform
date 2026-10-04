import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./diagnose-hotel-setup-approved-readiness.mjs', import.meta.url), 'utf8');
for (const fail of [false, true]) {
  const messages = [];
  class Client {
    async query(sql) {
      if (sql === 'private-check' && fail) throw Object.assign(new Error('secret-url password verifier'), { code: '42501' });
      return { rowCount: sql === 'private-check' ? 1 : null };
    }
  }
  globalThis.fixture = {
    pg: { Client }, createHash,
    parseApprovedReadinessConfiguration: () => ({ mode: 'inspect' }),
    inspectApprovedReadiness: async () => {
      const client = new Client();
      try { await client.query('BEGIN'); await client.query('private-check', ['secret-bound-password']); }
      finally { await client.query('ROLLBACK'); }
    },
    console: { log: (message) => messages.push(message) },
  };
  const program = source.replace(/^import .*;\n/gm, '')
    .replace(/^const pg =.*;\n/m, '')
    .replace("let phase =", 'const { pg, parseApprovedReadinessConfiguration, inspectApprovedReadiness, console, createHash } = globalThis.fixture;\nlet phase =');
  await import('data:text/javascript;base64,' + Buffer.from(program + `\n//${fail}`).toString('base64'));
  assert.equal(messages.length, 1);
  const result = JSON.parse(messages[0]);
  assert.deepEqual(result, { status: 'PASS', mode: 'diagnose', inspectionStatus: fail ? 'FAIL' : 'PASS',
    phase: fail ? 'query_02' : 'complete', rowCount: fail ? null : 1, sqlState: fail ? '42501' : null, statementSha256: createHash('sha256').update('private-check').digest('hex') });
  assert(!messages[0].includes('secret-url'));
  assert(!messages[0].includes('secret-bound-password'));
}
delete globalThis.fixture;
console.log('Diagnostic preserves failed check through rollback and redacts errors: PASS');
