import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const freezeTf = new URL('../infra/legacy_pms_freeze.tf', import.meta.url);
const ecsTf = readFileSync(new URL('../infra/ecs.tf', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../docs/legacy-pms-freeze.md', import.meta.url), 'utf8');

// Evaluates only the freeze file offline: variables and locals, no providers or state.
const evaluate = (vars) => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-pms-freeze-'));
  try {
    copyFileSync(freezeTf, join(dir, 'legacy_pms_freeze.tf'));
    writeFileSync(join(dir, 'fixture.tfvars.json'), JSON.stringify(vars));
    const result = spawnSync('terraform', ['console', '-no-color', '-var-file=fixture.tfvars.json'], {
      cwd: dir,
      input: 'jsonencode(local.legacy_pms_freeze_environment)\n',
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, 'terraform must be on PATH');
    const rejected = result.stderr.match(/Invalid value for variable[\s\S]*?var\.([a-z_]+)/);
    if (rejected) return { rejected: rejected[1] };
    assert.equal(result.status, 0, result.stderr);
    return { environment: JSON.parse(JSON.parse(result.stdout.trim())) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('no switch set adds nothing, so the task definition stays a no-op', () => {
  assert.deepEqual(evaluate({}), { environment: [] });
});

test('the documented go-day freeze file sets exactly the four freeze entries', () => {
  const freezeFile = JSON.parse(doc.match(/```json\n([\s\S]*?)```/)?.[1] ?? 'null');
  assert.ok(freezeFile, 'freeze file missing from docs/legacy-pms-freeze.md');
  // Terraform only warns about an undeclared key, so a typo would silently leave a switch unset.
  const declared = [...readFileSync(freezeTf, 'utf8').matchAll(/^variable "([a-z_]+)"/gm)].map((m) => m[1]);
  for (const key of Object.keys(freezeFile)) assert.ok(declared.includes(key), `${key} is not declared`);
  assert.deepEqual(evaluate(freezeFile), {
    environment: [
      { name: 'PMS_SCHEDULER_ENABLED', value: 'false' },
      { name: 'PMS_LEGACY_WEBHOOK_MODE', value: 'proxy_to_target' },
      { name: 'CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE', value: 'disabled' },
      { name: 'CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE', value: 'disabled' },
    ],
  });
});

test('every switch maps to the exact legacy PMS setting name', () => {
  assert.deepEqual(evaluate({
    legacy_pms_scheduler_enabled: true,
    legacy_pms_webhook_mode: 'mutating',
    legacy_pms_stripe_webhook_mode: 'proxy_to_target',
    legacy_pms_xendit_webhook_mode: 'proxy_to_target',
    legacy_pms_channex_webhook_mode: 'mutating',
    legacy_pms_channex_admin_manual_booking_sync_mode: 'target-owned',
    legacy_pms_channex_admin_manual_ari_sync_mode: 'read-only',
  }).environment.map(({ name, value }) => `${name}=${value}`), [
    'PMS_SCHEDULER_ENABLED=true',
    'PMS_LEGACY_WEBHOOK_MODE=mutating',
    'PMS_LEGACY_STRIPE_WEBHOOK_MODE=proxy_to_target',
    'PMS_LEGACY_XENDIT_WEBHOOK_MODE=proxy_to_target',
    'PMS_LEGACY_CHANNEX_WEBHOOK_MODE=mutating',
    'CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned',
    'CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE=read-only',
  ]);
});

test('unknown modes and the event-dropping ack-only mode are rejected', () => {
  for (const vars of [
    { legacy_pms_webhook_mode: '' },
    { legacy_pms_webhook_mode: 'ack_only_with_receipt' },
    { legacy_pms_stripe_webhook_mode: 'ack_only_with_receipt' },
    { legacy_pms_xendit_webhook_mode: 'ack_only_with_receipt' },
    { legacy_pms_channex_webhook_mode: 'PROXY_TO_TARGET' },
    { legacy_pms_channex_admin_manual_booking_sync_mode: 'disable' },
    { legacy_pms_channex_admin_manual_ari_sync_mode: 'proxy_to_target' },
  ]) {
    assert.deepEqual(evaluate(vars), { rejected: Object.keys(vars)[0] }, JSON.stringify(vars));
  }
});

test('only the production pms-backend receives the switches', () => {
  assert.equal(ecsTf.match(/local\.legacy_pms_freeze_environment/g)?.length, 1);
  const pmsBackend = ecsTf.match(/\n    pms-backend = \{([\s\S]*?)\n    pms-frontend = \{/)?.[1];
  assert.ok(pmsBackend, 'pms-backend service block missing');
  assert.match(pmsBackend, /name\s+= "vayada-pms-backend"/);
  assert.match(pmsBackend, /environment = concat\(\[[\s\S]*?\], local\.legacy_pms_freeze_environment\)\n      secrets = \[/);
});
