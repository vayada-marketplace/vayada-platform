# Verify a complete release before activation

This path prepares real images and a real publication, without changing the
delivery switch, SSM deployment records, holds, or ECS services. It is not a
failure-recovery rehearsal and does not certify deployment readiness.

Merge the paired VAY-2029 producer preparation and receiver verification changes
first. The v1 manifest/record schemas are unchanged. Source verification now
accepts the exact `next-<sourceSHA>` or `next-prepare-<sourceSHA>` tag on the
manifest's pinned digest; unrelated source tags are rejected.

## Prepare on application main

Run `build-coordinated-release.yml` on `main` with `prepare_only=true`. The input
defaults to true for manual runs. The existing main-only guard still applies.
This works while `COORDINATED_RELEASES_ENABLED` is unset; do not enable that
variable for this test.

Preparation builds push only `next-prepare-<sourceSHA>`, never `next-latest` or
the normal `next-<sourceSHA>` tag. Existing preparation tags are reused rather
than overwritten. The existing build concurrency group serializes these runs.
This still consumes build capacity and writes images/artifacts; it is not a
local simulation. Reused complete-baseline images retain their original digest
and source. A first release without a baseline builds all six services.

The trusted publisher validates the candidate's required `prepare-only` marker.
Only successful, main-branch manual builds can mark a preparation publication.
That marker suppresses automatic platform dispatch even if the delivery switch
changes while the build is running. Missing/invalid markers fail closed; old
in-flight candidates without the marker must be rebuilt after this change.
The durable publication retains the standard four contract files. It may be
used later as a complete baseline or explicitly selected for deployment after
the normal approvals and readiness gates; it is not an artificial test fixture.
Manual redispatch remains gated on the delivery switch and is an explicit
deployment action, not part of this procedure.

## Verify on platform main

From the successful publisher run, record the artifact ID and the exact
`manifest.sha256` and `published-record.sha256` values. Run
`deploy-coordinated-release.yml` on the reviewed platform main revision with
`operation=verify` and those three inputs.

The receiver downloads and validates the existing publication contract and
trusted workflow identities, checks every distinct image source against the
release source using the receiver's GitHub Contents access, and verifies all
six pinned ECR digests/source tags. It writes only runner-local bundle files
and `verification.json` (uploaded as a short-lived workflow artifact).
It returns before reading or writing deployment ownership/state or inspecting
ECS services; API, frontend and finalization jobs are skipped. The existing
global workflow lock is retained, so verification may queue behind deployments.

Success proves publication, ancestry and image access. It deliberately does
not check API split-launcher attestation, migration/backfill checkpoints,
live-service drift, holds, runtime database permissions, or product smoke.
The output labels deployment readiness `not-checked`. Those gates, the isolated
recovery rehearsal and explicit activation approval remain mandatory.

## Local verification

Producer tests exercise the actual build shell with stubbed AWS/Docker to show
normal tags remain untouched in preparation, existing preparation tags are not
overwritten, and unexpected ECR lookup failures stop the build. Receiver tests
use the real publication validator with mocked external adapters and assert
verification makes only image-read calls, rejects bad hashes/divergent ancestry,
and never produces a deployment plan. These are not hosted execution evidence.
