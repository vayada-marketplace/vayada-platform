# VAY-2042 fresh rehearsal media preparation

Contract: [VAY-2042](https://linear.app/vayadacom/issue/VAY-2042) and
[retained-run isolation](migration-rehearsal-fixed-release.md).

`infra/vay2017-metadata-runner/media.tf` declares ten additive resources in
the isolated Terraform root: a bucket, ownership controls, public-access block,
encryption, versioning, CloudFront OAC/distribution, bucket policy, task role,
and inline policy. It does not modify the production root or grant CI access.
The destination is `vayada-rehearsal-vay2042-20260926-269416271598`. Its name
does not attest an execution date, accepted release, or reserved run.

This is preparation only. Before any apply, independently review the complete
saved plan from the reviewed release and obtain approval of that exact plan
and ongoing S3/CloudFront usage costs. Require exactly ten creates, no updates,
deletes, replacements, or imports, and unchanged existing resources. Keep all
four previous rehearsal destinations and reservations untouched. This bucket
has versioning, no automatic expiry, no force-destroy, and `prevent_destroy`;
versioning is not permission to reuse deterministic media keys across runs.

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

The existing S3 gateway endpoint permits ECR image layers only. Before media
execution, a separate reviewed change must preserve that grant and add source
`s3:GetObject` for the three exact prefixes above plus destination
`s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` for this bucket's exact
`public/media/*` and `private/media/*` paths, restricted to the media role.
Do not add bucket listing, production writes, NAT, or internet routes. Update
the metadata isolation checker with that separately reviewed policy boundary;
this slice changes neither the endpoint nor metadata IAM.

The future guarded runner needs exact PassRole/task binding, separate scoped
credential injection, a fresh immutable target/run/release binding, and a
reservation protocol before copying rows or media. No owner object is created
or readable through this role. Public CDN smoke requires a separately scoped
external check because the private runner has no CloudFront route. A later
authorized synthetic public/private smoke must prove serving and denial before
real objects are copied. This preparation does not authorize either smoke,
bootstrap repetition, real-row extraction, migration, or cleanup.
