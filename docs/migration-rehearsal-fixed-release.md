# Fresh isolated rehearsal after Finance scope fixes

VAY-1361: the user approved a fresh isolated rehearsal with temporary test access
after VAY-1518/1519/1520 merged. Candidate application release is
`2d1ef4ef77b7bd977dd0c57203e4e0714127ba9a`, image digest
`sha256:d61c42f9891f9f8ab897284855dc682b69a5f3e8cda58eef1e36d2afeb4648d5`.
The new storage is reserved for one fresh run; its name is not execution proof.

## Preserve the previous run

Keep run `vay1360-b074ab30e0ff1559080d6942`, its `824c10d8` release, target,
snapshot evidence, bucket, CDN, roles, keys and current reservation untouched.
Media object IDs do not include a run ID. Fresh target imports unconditionally
write the same deterministic keys and may delete them after an import failure.
Bucket versioning does not make reuse safe. Do not update the previous
`rehearsal-control/owner.json` or extend its expired application reader again.

The additive `migration_rehearsal_fixed_media` resources provide another private,
encrypted, versioned bucket, public-only CloudFront origin and migration role.
There are no production hostname, service, key or previous-resource edits.
No lifecycle expiry or force-destroy is permitted while evidence is retained.

## Administrator bootstrap and deployment

Follow the administrator saved-plan procedure in `environments.md`. Coordinate
the platform apply queue first; do not cancel another task's deployment.
Use non-secret placeholders only for unrelated required Terraform variables.
Target the twelve new managed resources in `migration_rehearsal_fixed_media.tf`.
Require exactly twelve creates, zero updates, zero deletes, no replacements or
imports, and unchanged previous resources. Independently review the saved plan
and all embedded source before applying it. Check managed-policy attachment quota.

The new managed CI policy adds only read access to the exact new role and itself,
plus tagging/ownership configuration for the new bucket. It grants no IAM writes,
PassRole, object access, secrets or cryptographic use; the base inline policy and
independent policies stay unchanged. Bootstrap before merge, then merge the same
reviewed source before resuming automatic applies. A partial apply stays retained
for inspection; never delete state or create replacement resources blindly.

After deployment, run `bash scripts/check-migration-rehearsal-media.sh --fixed-release`
and a reviewed live synthetic public/private storage smoke with the new exact
role/bucket/CDN and digest. Conditionally create a new reservation in the new
bucket, pinning the new run ID, release and target; do not overwrite an owner.

## Execution gates remain

Create a fresh target database and evidence binding on the isolated RDS restore.
Use verified immutable source snapshots, not live source writes or target clones.
Rebuild with reviewed transformations; do not revive old permissions, publication,
payment/provider readiness or stale states merely to satisfy smoke tests.
Temporary existing-user test access requires exact provider/ID verification,
independent boundary review, read-only app credentials and exact cleanup proof.
The old run-specific application scripts cannot be silently repinned or replayed.

This storage slice launches no task and does not complete the rehearsal. Full
parity, authenticated-domain/browser/job/rollback checks, positive public media,
final-delta timing and named approvals remain required. VAY-1283's identified
legacy check-in/out range preservation gap must be reconciled before final
migration acceptance; source compilation alone does not close that gap.

## Post-midnight-fix rerun

The first fixed-release run `vay1360-794408820af79d3f3c63aa6d` stopped safely
before Catalog committed because two valid legacy `14:00–00:00` check-in windows
were rejected. Preserve its target, owner reservation, object versions, secret,
roles and logs unchanged. Target migrations `0171` and `0172` mean that target
must not be resumed after the application fix.

Release `0118fd1f61b01e94dad63590a4452afb3cebac32` contains the reviewed midnight
semantics from `9bb02329325d018adfc68c5b4b3244ab4d569e14` and is the exact descendant
used by the final live acceptance. Its fresh full rehearsal uses the additive
`migration_rehearsal_midnight_media` resources: another private, encrypted,
versioned bucket, public-only CloudFront origin and isolated task role. Apply the
same saved-plan/bootstrap rules above, requiring exactly twelve creates and no
changes, deletes, replacements or imports. Run the deployed media checker with
`--midnight-release`, reserve a new owner without overwriting either existing
owner, and bind a new run ID, database, role, secret, image digest and storage
tuple before starting ETL.

## Post-Inbox-classifier-fix rerun

The post-midnight run `vay1360-ff36172f0b07d84e5782856b` stopped safely at
PMS after Schema, Extraction, Identity, Catalog, and Booking completed. Its PMS
transaction rolled back because 21 ordinary Channex messages carried the generic
`meta.live_feed_event_id` envelope field and were incorrectly classified as
inquiries. Preserve that run's target, owner reservation, 4,224 object versions,
secret, roles, and logs unchanged; it must not be resumed after the application
fix.

Release `7200a43a8ced02df98c518bf72a4101060434337`, immutable image digest
`sha256:fab6bafdd04009d5807b9e9362b2c0e0974e15077592343a02d23f18f27c8689`,
contains the reviewed migration-only classifier repair. Its fresh rehearsal uses
the additive `migration_rehearsal_inbox_media` resources. Apply the same
administrator bootstrap and saved-plan gates above: exactly twelve creates, no
changes, deletes, replacements, or imports, with every prior boundary unchanged.
After deployment, run the checker with `--inbox-release` and complete the live
public/private storage smoke before atomically reserving a new owner. Bind a new
run ID, database, role, versioned secret, exact image digest, and storage tuple;
do not reuse the failed target or any previous owner.

The target-only application smoke uses the additive
`migration_rehearsal_inbox_application` resources. They create a new exact-release
task role and two new retained synthetic Finance keys; they do not repoint or
broaden any previous rehearsal role or key. The task role can read only this
release's `public/media/*` and `private/media/*` objects, cannot mutate S3, and
cannot use any other AWS service or KMS key. It is not granted to the platform
deploy role through `iam:PassRole`; only an authorized operator may launch the
bounded one-off smoke task.

Pause platform applies and use the administrator saved-plan workflow. Target
only the application role, inline policy, two KMS keys, exact read-only CI
managed policy, and its attachment. Require exactly six creates, zero changes,
zero deletes, no replacements or imports, with every prior rehearsal and
production resource unchanged. The CI policy permits refresh of only those
exact resources; it grants no IAM writes, task-role passing, object access, or
cryptographic use. Merge the same reviewed source before resuming normal
platform applies. Retain every application resource until the rehearsal evidence
is accepted.

Exact-image read-only baseline task
`46c70e7ce0f64c4c803b3d5ae0bc8e01` exited zero before any application-reader
creation. It bound target evidence checksum
`e6f0126a27e293044e510cda9e45131a1f6857952bb8ff967e7088215d7c8337` and
whole-target checksum
`d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b`
across 210 tables and 449,379 rows in a repeatable-read, read-only transaction.
The application smoke scripts are pinned to those fresh values, reader role
`vayada_app_reader_27ba9106a4be3e023992ca59`, the exact new application role
and keys, and the Inbox-release bucket/CDN. They must refuse every older run,
target, bucket, role, key, checksum, or credential rather than silently falling
back to retained rehearsal state.
