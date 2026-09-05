#!/usr/bin/env bash
set -euo pipefail

# Read-only deployed contract check; policy simulation never writes an object.
region=eu-west-1
account=269416271598
bucket="vayada-migration-rehearsal-media-${account}"
role="arn:aws:iam::${account}:role/vayada-migration-rehearsal-media-task-role"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$account" ]]
aws s3api get-public-access-block --bucket "$bucket" --region "$region" --output json |
  jq -e '.PublicAccessBlockConfiguration == {BlockPublicAcls:true, BlockPublicPolicy:true, IgnorePublicAcls:true, RestrictPublicBuckets:true}' >/dev/null
aws s3api get-bucket-versioning --bucket "$bucket" --region "$region" --output json |
  jq -e '.Status == "Enabled"' >/dev/null
aws s3api get-bucket-encryption --bucket "$bucket" --region "$region" --output json |
  jq -e '.ServerSideEncryptionConfiguration.Rules | length == 1 and .[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm == "AES256"' >/dev/null

assert_decision() {
  local expected="$1" resource="$2"; shift 2
  aws iam simulate-principal-policy --policy-source-arn "$role" \
    --action-names "$@" --resource-arns "$resource" --output json |
    jq -e --arg expected "$expected" --argjson count "$#" \
      '.EvaluationResults | length == $count and all(.[]; .EvalDecision == $expected and (.MissingContextValues | length) == 0)' >/dev/null
}

for prefix in public private; do
  assert_decision allowed "arn:aws:s3:::${bucket}/${prefix}/media/contract-check" \
    s3:GetObject s3:PutObject s3:DeleteObject
done
for resource in \
  arn:aws:s3:::vayada-media-production/public/media/contract-check \
  arn:aws:s3:::vayada-media-production/private/media/contract-check \
  arn:aws:s3:::vayada-uploads-prod/creators/contract-check \
  arn:aws:s3:::vayada-uploads-prod/listings/contract-check \
  arn:aws:s3:::vayada-creator-marketplace-images/contract-check; do
  assert_decision explicitDeny "$resource" s3:PutObject s3:DeleteObject s3:DeleteObjectVersion
done
for resource in \
  arn:aws:s3:::vayada-uploads-prod/creators/contract-check \
  arn:aws:s3:::vayada-uploads-prod/listings/contract-check \
  arn:aws:s3:::vayada-creator-marketplace-images/contract-check; do
  assert_decision allowed "$resource" s3:GetObject
done
assert_decision explicitDeny arn:aws:s3:::vayada-media-production s3:PutBucketPolicy s3:DeleteBucket
assert_decision implicitDeny "arn:aws:s3:::${bucket}" s3:ListBucket
echo 'Rehearsal bucket controls and task-role media isolation checks passed (read-only).'
