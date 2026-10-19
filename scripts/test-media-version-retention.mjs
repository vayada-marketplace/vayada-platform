import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const media = readFileSync(new URL('../infra/media.tf', import.meta.url), 'utf8');
const lifecycle = media.match(/resource "aws_s3_bucket_lifecycle_configuration" "private_profile_media" \{([\s\S]*?)\n\}/)?.[1];
const rules = [...(lifecycle ?? '').matchAll(/\n {2}rule \{([\s\S]*?)\n {2}\}/g)].map((m) => m[1]);
const rule = (id) => {
  const body = rules.find((candidate) => candidate.includes(`id     = "${id}"`));
  assert.ok(body, `lifecycle rule ${id} missing`);
  return body;
};

test('the media bucket stays versioned with exactly three lifecycle rules', () => {
  assert.ok(lifecycle, 'media lifecycle configuration missing');
  assert.match(media, /resource "aws_s3_bucket_versioning" "private_profile_media" \{[\s\S]*?status = "Enabled"/);
  assert.deepEqual(rules.map((body) => body.match(/id\s+=\s+"([^"]+)"/)[1]), [
    'expire-abandoned-staging-uploads', 'expire-replaced-public-versions', 'expire-replaced-private-versions',
  ]);
});

test('abandoned staging uploads still expire after one day', () => {
  const staging = rule('expire-abandoned-staging-uploads');
  assert.match(staging, /prefix = "staging\/"/);
  assert.match(staging, /expiration \{\s+days = 1\s+\}/);
  assert.match(staging, /noncurrent_days = 1\b/);
});

test('replaced and deleted public and private media leave after 30 days, current objects never expire', () => {
  for (const prefix of ['public', 'private']) {
    const body = rule(`expire-replaced-${prefix}-versions`);
    assert.match(body, /status = "Enabled"/);
    assert.match(body, new RegExp(`filter \\{\\s+prefix = "${prefix}/"\\s+\\}`));
    assert.match(body, /noncurrent_version_expiration \{\s+noncurrent_days = 30\s+\}/);
    assert.match(body, /expiration \{\s+expired_object_delete_marker = true\s+\}/);
    assert.doesNotMatch(body, /\bdays\s+=|\bdate\s+=|transition|newer_noncurrent_versions/);
  }
});
