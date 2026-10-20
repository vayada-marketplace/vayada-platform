import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cutoverTf = new URL('../infra/legacy_wave_cutover.tf', import.meta.url);
const albTf = readFileSync(new URL('../infra/alb.tf', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../docs/legacy-wave-cutover.md', import.meta.url), 'utf8');

// Evaluates only the cutover file offline: variables and locals, no providers or state.
const evaluate = (vars) => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-wave-cutover-'));
  try {
    copyFileSync(cutoverTf, join(dir, 'legacy_wave_cutover.tf'));
    writeFileSync(join(dir, 'fixture.tfvars.json'), JSON.stringify(vars));
    const result = spawnSync('terraform', ['console', '-no-color', '-var-file=fixture.tfvars.json'], {
      cwd: dir,
      input: 'jsonencode({blocks = local.legacy_booking_block_rules, redirects = local.legacy_booking_redirect_rules})\n',
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, 'terraform must be on PATH');
    const rejected = result.stderr.match(/Invalid value for variable[\s\S]*?var\.([a-z_]+)/);
    if (rejected) return { rejected: rejected[1] };
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(JSON.parse(result.stdout.trim()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('empty inputs add no listener rule, so the plan shows no change', () => {
  assert.deepEqual(evaluate({}), { blocks: {}, redirects: {} });
});

test('the documented wave-1 file blocks three slugs in one rule and redirects four hosts', () => {
  const waveFile = JSON.parse(doc.match(/```json\n([\s\S]*?)```/)?.[1] ?? 'null');
  assert.ok(waveFile, 'wave file missing from docs/legacy-wave-cutover.md');
  const declared = [...readFileSync(cutoverTf, 'utf8').matchAll(/^variable "([a-z_]+)"/gm)].map((m) => m[1]);
  for (const key of Object.keys(waveFile)) assert.ok(declared.includes(key), `${key} is not declared`);
  assert.deepEqual(evaluate(waveFile), {
    blocks: {
      0: {
        priority: 21,
        paths: [
          '/api/hotels/aetherhilltopvillas-a0ae2226/bookings*',
          '/api/hotels/dolcemareresort-9448d754/bookings*',
          '/api/hotels/haighahouse-aa2e01a9/bookings*',
        ],
      },
    },
    redirects: {
      'aetherhilltopvillas-a0ae2226.booking.vayada.com': { priority: 31, to: 'aetherhilltopvillas-a0ae2226.next-booking.vayada.com' },
      'dolcemareresort-9448d754.booking.vayada.com': { priority: 32, to: 'dolcemareresort-9448d754.next-booking.vayada.com' },
      'haighahouse-aa2e01a9.booking.vayada.com': { priority: 33, to: 'haighahouse-aa2e01a9.next-booking.vayada.com' },
      'www.booking.aetherhilltopvillas.com': { priority: 34, to: 'aetherhilltopvillas-a0ae2226.next-booking.vayada.com' },
    },
  });
});

test('more slugs take more rules, three per rule, in priority order', () => {
  const { blocks } = evaluate({ legacy_booking_blocked_slugs: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(blocks, {
    0: { priority: 21, paths: ['/api/hotels/a/bookings*', '/api/hotels/b/bookings*', '/api/hotels/c/bookings*'] },
    1: { priority: 22, paths: ['/api/hotels/d/bookings*'] },
  });
  const custom = evaluate({ legacy_booking_redirects: { 'book.example-hotel.com': 'example.next-booking.vayada.com' } });
  assert.deepEqual(custom.redirects, { 'book.example-hotel.com': { priority: 31, to: 'example.next-booking.vayada.com' } });
});

test('bad inputs are refused before any plan', () => {
  for (const slugs of [['Aether'], ['a', 'a'], ['a/b'], ['a*'], ['-a'], Array.from({ length: 25 }, (_, i) => `h${i}`)])
    assert.deepEqual(evaluate({ legacy_booking_blocked_slugs: slugs }), { rejected: 'legacy_booking_blocked_slugs' }, JSON.stringify(slugs));
  for (const redirects of [
    { 'a.booking.vayada.com': 'a.booking.vayada.com' },
    { 'a.booking.vayada.com': 'a.vayada.com' },
    { 'a.booking.vayada.com': 'evil.example.com' },
    { 'admin.booking.vayada.com': 'a.next-booking.vayada.com' },
    { 'booking.vayada.com': 'a.next-booking.vayada.com' },
    { 'pms-api.vayada.com': 'a.next-booking.vayada.com' },
    { 'a.next-booking.vayada.com': 'b.next-booking.vayada.com' },
    { '*.booking.vayada.com': 'a.next-booking.vayada.com' },
    Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`h${i}.booking.vayada.com`, `h${i}.next-booking.vayada.com`])),
  ])
    assert.deepEqual(evaluate({ legacy_booking_redirects: redirects }), { rejected: 'legacy_booking_redirects' }, JSON.stringify(redirects));
});

test('the reserved priorities never collide with the other listener rules', () => {
  const cutover = readFileSync(cutoverTf, 'utf8');
  const list = (name) => JSON.parse(cutover.match(new RegExp(`${name}\\s*=\\s*(\\[[^\\]]*\\])`))[1]);
  const blocks = list('legacy_booking_block_priorities');
  const redirects = list('legacy_booking_redirect_priorities');
  const taken = [...albTf.matchAll(/priority\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  for (const priority of [...blocks, ...redirects]) assert.ok(!taken.includes(priority), `priority ${priority} is taken`);
  assert.ok(taken.includes(35), 'the staging PMS API priority is still 35');
  assert.ok(blocks.every((p) => p < 30), 'blocks must come before pms-api.vayada.com (30)');
  assert.ok(redirects.every((p) => p < 50), 'redirects must come before *.booking.vayada.com (50) and the catch-all (99)');
  assert.equal(new Set([...blocks, ...redirects]).size, blocks.length + redirects.length);
});
