import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const media = readFileSync(new URL('../infra/media.tf', import.meta.url), 'utf8');
const ecs = readFileSync(new URL('../infra/ecs.tf', import.meta.url), 'utf8');
const block = (tf, kind, type, name) => {
  const body = tf.match(new RegExp(`${kind} "${type}" "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(body, `${kind} ${type}.${name} missing`);
  return body;
};
const policy = block(media, 'resource', 'aws_iam_role_policy', 'next_api_media');

test('the next-api media role keeps its three statements and no version deletes', () => {
  assert.deepEqual([...policy.matchAll(/Sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]), [
    'ManagePlatformMediaObjects', 'ReadReviewedLegacyMediaObjects', 'InvalidatePublicMediaCache',
  ]);
  assert.match(policy, /Action = \[\s*"s3:GetObject",\s*"s3:PutObject",\s*"s3:DeleteObject",\s*\]\s+Resource = \[\s*"\$\{aws_s3_bucket\.private_profile_media\.arn\}\/staging\/\*",\s*"\$\{aws_s3_bucket\.private_profile_media\.arn\}\/public\/\*",\s*"\$\{aws_s3_bucket\.private_profile_media\.arn\}\/private\/\*",\s*\]/);
  assert.doesNotMatch(policy, /DeleteObjectVersion|s3:\*|cloudfront:\*|"\*"/);
});

test('the role may invalidate only the images.vayada.com distribution', () => {
  assert.match(policy, /Sid\s*=\s*"InvalidatePublicMediaCache"\s+Effect\s*=\s*"Allow"\s+Action\s*=\s*\["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"\]\s+Resource\s*=\s*aws_cloudfront_distribution\.private_profile_media\.arn\s+\}/);
  assert.equal([...policy.matchAll(/cloudfront:/g)].length, 2);
});

test('next-api gets the distribution ID and the purge switch, off by default', () => {
  assert.match(ecs, /name\s*=\s*"vayada-next-api"[\s\S]*?task_role_arn\s*=\s*aws_iam_role\.next_api_media\.arn/);
  assert.match(ecs, /\{ name = "PLATFORM_MEDIA_CDN_DISTRIBUTION_ID", value = aws_cloudfront_distribution\.private_profile_media\.id \}/);
  assert.match(ecs, /\{ name = "PLATFORM_MEDIA_RETIRED_PURGE_ENABLED", value = tostring\(var\.platform_media_retired_purge_enabled\) \}/);
  assert.match(media, /variable "platform_media_retired_purge_enabled" \{\s+type\s+=\s+bool\s+default\s+=\s+false\s/);
});
