import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tf = readFileSync(new URL('../infra/vay2017-metadata-runner/media.tf', import.meta.url), 'utf8');
const block = (kind, type, name = 'vay2042_media') => {
  const body = tf.match(new RegExp(`${kind} "${type}" "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(body, `${kind} ${type}.${name} missing`);
  return body;
};
const resource = (type) => block('resource', type);

test('media preparation adds only ten isolated resources and no live binding', () => {
  assert.deepEqual([...tf.matchAll(/resource "([^"]+)" "([^"]+)"/g)].map((m) => m.slice(1)), [
    'aws_s3_bucket', 'aws_s3_bucket_ownership_controls', 'aws_s3_bucket_public_access_block',
    'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_versioning',
    'aws_cloudfront_origin_access_control', 'aws_cloudfront_distribution', 'aws_s3_bucket_policy',
    'aws_iam_role', 'aws_iam_role_policy',
  ].map((type) => [type, 'vay2042_media']));
  assert.match(tf, /vayada-rehearsal-vay2042-20260926-\$\{local\.vay2017_rehearsal_account_id\}/);
  assert.doesNotMatch(tf, /rehearsal-control|owner\.json|Release\s*=|RunId\s*=|PassRole|secretsmanager:|kms:|rds:/);
  assert.doesNotMatch(tf, /lifecycle_configuration|expiration|force_destroy\s*=\s*true/);
  assert.match(resource('aws_s3_bucket'), /prevent_destroy\s*=\s*true/);
  assert.match(resource('aws_s3_bucket'), /force_destroy\s*=\s*false/);
});

test('storage stays private, encrypted, versioned and without ACLs', () => {
  for (const key of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) {
    assert.match(resource('aws_s3_bucket_public_access_block'), new RegExp(`${key}\\s*=\\s*true`));
  }
  assert.match(resource('aws_s3_bucket_ownership_controls'), /object_ownership\s*=\s*"BucketOwnerEnforced"/);
  assert.match(resource('aws_s3_bucket_server_side_encryption_configuration'), /sse_algorithm\s*=\s*"AES256"/);
  assert.match(resource('aws_s3_bucket_versioning'), /status\s*=\s*"Enabled"/);
});

test('only the new CloudFront distribution may read public media through signed origin access', () => {
  const cdn = resource('aws_cloudfront_distribution');
  assert.match(cdn, /origin_path\s*=\s*"\/public"/);
  assert.match(cdn, /origin_access_control_id\s*=\s*aws_cloudfront_origin_access_control\.vay2042_media\.id/);
  assert.match(cdn, /allowed_methods\s*=\s*\["GET", "HEAD"\]/);
  assert.match(cdn, /viewer_protocol_policy\s*=\s*"redirect-to-https"/);
  assert.match(resource('aws_cloudfront_origin_access_control'), /signing_behavior\s*=\s*"always"/);
  const policy = block('data', 'aws_iam_policy_document', 'vay2042_media_bucket');
  assert.equal([...policy.matchAll(/statement \{/g)].length, 2);
  assert.match(policy, /actions\s*=\s*\["s3:GetObject"\]\s+resources\s*=\s*\["\$\{aws_s3_bucket\.vay2042_media\.arn\}\/public\/media\/\*"\]/);
  assert.match(policy, /identifiers\s*=\s*\["cloudfront.amazonaws.com"\]/);
  assert.match(policy, /variable\s*=\s*"AWS:SourceArn"\s+values\s*=\s*\[aws_cloudfront_distribution\.vay2042_media\.arn\]/);
  assert.match(policy, /effect\s*=\s*"Deny"[\s\S]*"aws:SecureTransport"\s+values\s*=\s*\["false"\]/);
});

test('task policy bounds source reads and destination mutations without touching retained runs', () => {
  assert.match(tf, /vay2042_media_objects\s*=\s*\[\s*"arn:aws:s3:::\$\{local\.vay2042_media_bucket\}\/public\/media\/\*",\s*"arn:aws:s3:::\$\{local\.vay2042_media_bucket\}\/private\/media\/\*",\s*\]/);
  const role = resource('aws_iam_role');
  assert.match(role, /Principal\s*=\s*\{ Service = "ecs-tasks.amazonaws.com" \}/);
  assert.match(role, /"aws:SourceAccount" = local\.vay2017_rehearsal_account_id/);
  assert.match(role, /"aws:SourceArn" = "arn:aws:ecs:\$\{local\.vay2017_rehearsal_region\}:\$\{local\.vay2017_rehearsal_account_id\}:\*"/);
  const policy = resource('aws_iam_role_policy');
  assert.equal([...policy.matchAll(/Sid\s*=/g)].length, 3);
  assert.match(policy, /Action\s*=\s*\["s3:GetObject", "s3:PutObject", "s3:DeleteObject"\]\s+Resource\s*=\s*local\.vay2042_media_objects/);
  assert.match(policy, /Action\s*=\s*"s3:GetObject"\s+Resource\s*=\s*\[\s*"arn:aws:s3:::vayada-uploads-prod\/creators\/\*",\s*"arn:aws:s3:::vayada-uploads-prod\/listings\/\*",\s*"arn:aws:s3:::vayada-creator-marketplace-images\/\*",\s*\]/);
  assert.match(policy, /Effect\s*=\s*"Deny"\s+NotAction\s*=\s*\["s3:Get\*", "s3:List\*", "s3:Describe\*"\]\s+NotResource\s*=\s*local\.vay2042_media_objects/);
});
