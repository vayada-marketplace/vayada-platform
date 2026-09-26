# VAY-2042 fresh rehearsal media preparation

Contract: [VAY-2042](https://linear.app/vayadacom/issue/VAY-2042) and
[retained-run isolation](migration-rehearsal-fixed-release.md).

`infra/vay2017-metadata-runner/media.tf` declares ten additive resources in
the isolated Terraform root: a bucket, ownership controls, public-access block,
encryption, versioning, CloudFront OAC/distribution, bucket policy, task role,
and inline policy. It does not modify the production root or grant CI access.
The destination is `vayada-rehearsal-vay2042-20260926-269416271598`. Its name
does not attest an execution date, accepted release, or reserved run.

For the initial storage apply, independently review the complete
saved plan from the reviewed release and obtain approval of that exact plan
and ongoing S3/CloudFront usage costs. Require exactly ten creates, no updates,
deletes, replacements, or imports, and unchanged existing resources. Keep all
four previous rehearsal destinations and reservations untouched. This bucket
has versioning, no automatic expiry, no force-destroy, and `prevent_destroy`;
versioning is not permission to reuse deterministic media keys across runs.
The endpoint-only follow-up has a separate plan gate below.

After an authorized apply, read `vay2042_media` and bind the returned bucket,
CDN, and task role together. Never substitute a production or retained tuple.
CloudFront allows public viewers to GET/HEAD only `public/media/*` through its
signed S3 origin. `private/media/*` has no CDN read grant. The media role can
Get/Put/Delete only those two destination paths; it has no provider, secret,
database administration, KMS, or PassRole permissions. No task uses it yet.

The reviewed source settings remain:

```text
LEGACY_PMS_MEDIA_BUCKET=vayada-uploads-prod
LEGACY_MEDIA_BUCKET_ALLOWLIST=vayada-uploads-prod,vayada-creator-marketplace-images
AWS_REGION=eu-west-1
```

Source reads are limited to `vayada-uploads-prod/creators/*`,
`vayada-uploads-prod/listings/*`, and `vayada-creator-marketplace-images/*`.
Any additional source prefixes require evidence and separate review.

## Separate blocked dependencies

The endpoint preparation uses `media-s3-endpoint-policy.json` in the isolated
root. It preserves the exact ECR image-layer grant and adds source
`s3:GetObject` for the three prefixes above plus destination
`s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` for this bucket's
`public/media/*` and `private/media/*` paths, restricted by `aws:PrincipalArn`
to the exact media role. No bucket listing, owner-reservation access,
production writes, NAT, route, IAM, task, database or secret changes are included.

Before an authorized apply, independently review a fresh saved plan: exactly
one in-place policy update to `aws_vpc_endpoint.vay2017_ecr_s3`, no creates,
deletes, replacements, imports or other changes. Preparing or merging this
source does not apply the isolated root or authorize media execution.

The isolation checker defaults to the exact deployed ECR-only policy; use
`bash scripts/check-vay2017-rehearsal-isolation.sh --s3-ecr-only` before the
endpoint change. After its separately approved apply, use `--s3-media` for
metadata or media preflight. Both modes reject broader, missing or mixed grants;
neither mode automatically accepts the other policy. The checker reads AWS
metadata only. Keep metadata credentials, IAM and task bindings unchanged.

For the fresh bucket/role's separate read-only preflight, run
`bash scripts/check-migration-rehearsal-media.sh --vay2042`. This reuses the
existing bucket-control and IAM-simulation checker with this exact tuple. It
checks encryption, versioning, public-access blocking, allowed source reads and
destination media operations, denied source/other-run mutations, and denied
reservation reads, object-version operations, listing and non-media authority.
It does not fetch an object or secret, copy photos, create a reservation, or
change IAM. Simulated decisions are not actual CDN-serving/private-denial proof
or a complete task/identity-policy attestation; retain the separate live smoke,
exact task binding and `--s3-media` endpoint/isolation gates below.

The future guarded runner needs exact PassRole/task binding, separate scoped
credential injection, a fresh immutable target/run/release binding, and a
reservation protocol before copying rows or media. No owner object is created
or readable through this role. Public CDN smoke requires a separately scoped
external check because the private runner has no CloudFront route. A later
authorized synthetic public/private smoke must prove serving and denial before
real objects are copied. This preparation does not authorize either smoke,
bootstrap repetition, real-row extraction, migration, or cleanup.
