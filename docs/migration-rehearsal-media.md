# Isolated migration rehearsal media

VAY-1470 separates the VAY-1361 rehearsal's media side effects from production.
The database and media destination must both be isolated. Never reuse the
production next-api task role or production bucket/CDN for a rehearsal apply.

## Administrator bootstrap

CI can inspect the new task role and configure the exact rehearsal bucket; it
cannot create/change the role or pass it to ECS. Follow the saved-plan IAM
administrator process in `environments.md`, with Terraform applies paused.
Target only `aws_iam_role_policy.github_actions_platform_deploy`,
`aws_iam_role.migration_rehearsal_media` and
`aws_iam_role_policy.migration_rehearsal_media`. Stop unless the plan contains
exactly those two role/inline-policy creates and one in-place base-policy update:
four existing IAM read actions gain the exact rehearsal role resource; only
`s3:PutBucketTagging` and `s3:PutBucketOwnershipControls` gain the exact rehearsal
bucket. No trust, PassRole or IAM-write grants may change. Preserve every other
independent inline policy. Review the aggregate inline-policy quota before apply.
Merge the same reviewed commit before resuming normal Terraform applies. Future
rehearsal role changes also require an administrator-reviewed saved plan. The
one-off launcher must independently have `iam:PassRole` for this exact task role.

## Runtime binding and verification

After the protected Terraform plan/apply, read the `migration_rehearsal_media`
output. Bind all three values together: `task_role_arn` on the one-off ECS task,
`bucket_name` as `PLATFORM_MEDIA_BUCKET`, and `cdn_base_url` as
`PLATFORM_MEDIA_CDN_BASE_URL`. Pin the reviewed application image by digest.
The execution role still retrieves the guarded isolated database connection
bundle; it is not the SDK task role. Keep the existing source bucket allowlist.

The dedicated task role reads only the VAY-1426 legacy source prefixes and
manages only `public/media/*` and `private/media/*` in the rehearsal bucket.
It has no provider, secrets, database administration or KMS permissions. The
migration CLI does not call Finance KMS; production key policies stay unchanged.
This is not a role for starting a production API or worker.

CloudFront reads only `public/media/*` using signed origin access. The bucket
is private, encrypted and versioned; private objects are never CDN-readable.
There is no automatic object expiry while rehearsal evidence awaits acceptance.
Keep earlier database/source/media evidence; versioning is a recovery measure,
not permission to overwrite or delete another accepted run's artifacts.

Before a fresh run, execute `scripts/check-migration-rehearsal-media.sh`, then
run an isolated ECS smoke using the dedicated task role: write unique synthetic
public/private objects, verify public CDN delivery and private denial, and
record the digest/role/bucket/distribution and results. Do not attempt a real
production write to test denial. Keep synthetic smoke objects until evidence
is accepted. A successful infrastructure smoke does not waive full migration
parity, target-only application smoke, rollback, final-freeze or human approval.
