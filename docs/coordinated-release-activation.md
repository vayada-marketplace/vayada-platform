# VAY-2029 activation record and runbook

Status: **NOT READY FOR ACTIVATION.** The old writer boundary is installed and
the exact prepare-only candidate is published. Activation remains blocked on
merging its reviewed API attestations, reconciling both active holds, approving
the exact artifact and hashes, and completing production smoke/evidence. This
document is an operator record, not deployment approval.

Read with [the architecture](https://linear.app/vayadacom/document/coordinated-deployment-architecture-and-acceptance-plan-3f706981f863),
[runtime controls](coordinated-releases.md), and the
[VAY-2029 evidence index](evidence/vay-2029/README.md).

## Reviewed implementation and boundary evidence

| Change | Reviewed identity | Result |
| --- | --- | --- |
| Writer migration | platform [#262](https://github.com/vayada-marketplace/vayada-platform/pull/262), head `df2462b4a338991b4f1f34c54d8607045f30c729`, merge `3feb08591931d816d32eea300a6623a7ae9b0c29` | Apply [36105639066](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36105639066) succeeded with no infrastructure changes |
| Protected OIDC trust | platform [#265](https://github.com/vayada-marketplace/vayada-platform/pull/265), head `a50087b146672ec049b6da7582490bedb006ce49`, merge `057cd77c95ec1cbbdfdc90947d25e75faffb2a59` | Protected admission [36109471264](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36109471264) passed; no-environment probe [36109998999](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36109998999) denied all 12 assume attempts |
| Transition-session cutoff | platform [#272](https://github.com/vayada-marketplace/vayada-platform/pull/272), head `4e89f9b4ebb83a43c0c3533ece99a5c96fda1460`, merge `9ac1e0852e16dba42da39db7bc539b4baf63df61` | Cutoff `2026-09-25T08:08:47Z`; post-cutoff Apply [36117487916](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36117487916) passed with 0 added, 0 changed, 0 destroyed |
| Candidate API attestations | platform [#274](https://github.com/vayada-marketplace/vayada-platform/pull/274), head `e600571272c5db7c7877986e26939cba5a66c7b5` | Open and green; not merged and not deployment approval |

The mutation role trust is limited to audience `sts.amazonaws.com` and subject
`repo:vayada-marketplace/vayada-platform:environment:platform-mutations-v2`.
Its cutoff explicitly denies older sessions. Retained queued runs `34749336429`
and `34749338561` have no jobs and are fenced by that trust/cutoff; do not rerun,
cancel, or use them as release evidence.

## Exact candidate

The only candidate discussed by this runbook is:

- app source `b83cec1894c81b5f65fb8a871fdaa6e0e67335af`;
- build [36134864409](https://github.com/vayada-marketplace/vayada/actions/runs/36134864409), attempt 1, `prepare_only=true`;
- publisher [36135194016](https://github.com/vayada-marketplace/vayada/actions/runs/36135194016), attempt 1;
- published artifact `10863860900`, expiring `2026-12-24T12:29:17Z`;
- manifest ID `vayada-release/v1/b83cec1894c81b5f65fb8a871fdaa6e0e67335af/36134864409/1`;
- manifest SHA-256 `1c3c44019ec534d374c7447cae32053d01bcdfeaa1ed8bbefd94594b2a41820e`;
- published-record SHA-256 `4fd68c242053cd2da2af99e8a5e21275a622c599920980623dedb6aa896dddb8`.

All six immutable digests and publication metadata are in
[candidate-publication.json](evidence/vay-2029/candidate-publication.json).
Preparation and publication did not write coordinated SSM state or mutate ECS.
Never reconstruct or substitute this candidate from tags, timestamps, a newer
main tip, or an expired artifact.

## Pause-window snapshot

Snapshot collected read-only at `2026-09-25T13:09:36Z`. Every service reported
one desired, one running, zero pending, and PRIMARY rollout `COMPLETED`.

| Service | Live task | Live digest |
| --- | --- | --- |
| API | `vayada-next-api:1161` | `sha256:32842b3741aed2856fd6256e184a388649ddffdb8689fb80cf881f75f9f7a576` |
| PMS Web | `vayada-next-pms-frontend:625` | `sha256:57c692910cb14c232e4cdc669dce2a9f78d68e9502b0bea31829dd08135695ec` |
| Booking Web | `vayada-next-booking-frontend:427` | `sha256:2aabf5d5c475728265692def10e07c54b150a1839b726a81c41585e839c19196` |
| Booking Admin | `vayada-next-booking-admin:551` | `sha256:60ebcb9fb979362631916a82c3653a82bb8b30431da53b9d8652ef97b2464a08` |
| Marketplace Web | `vayada-next-marketplace-frontend:571` | `sha256:2ebd0659d44b4e8b64ab0a96e96da4bf76f5c93bf1e51ab209277b4d37ecb79c` |
| Vayada Admin | `vayada-next-marketplace-admin:522` | `sha256:90147f6423e3b00e92fc3f2ccb29015bef63c328d74a5a24236383d11b71a2ed` |

`COORDINATED_RELEASES_ENABLED`, ownership mode, and desired release are absent,
so legacy/default ownership remains. Seven old app lanes and platform `Deploy
App Service` are currently disabled manually; coordinated build/publish,
deploy, and control workflows remain active. Recollect this entire snapshot and
all active workflows immediately before any hold resume or activation.

## Active holds and required order

Both holds are authoritative and must be reconciled, never deleted or edited:

1. API: operation `legacy-36096727520-1`, captured task `vayada-next-api:1158`,
   digest `sha256:3cc5df6b3400b1c5710a595b3eb4baf0964add9c8d89e7347b123138c21cb798`,
   reason “VAY-1134 user-authorized all-hotel export preparation”,
   `dependentFrontendsCompatible=false`.
2. Booking Web: operation `legacy-35844135741-1`, captured task
   `vayada-next-booking-frontend:400`, digest
   `sha256:3d21330c21f3a7ebce1102624f62a37f4f2952a026baa4f2b9ceece33bb9447a`,
   reason automatic rollback after failed per-service cutover,
   `dependentFrontendsCompatible=false`.

Resume API first, then Booking Web, using the same exact candidate artifact and
both hashes. Finance ongoing exports remain enabled and must not be disabled or
rolled back to captured API revision 1158. API resume may be verification-only
when the selected digest is already live, but still requires the immutable
split-launcher/ongoing-export attestations, readiness smoke, and provenance.
A failed resume keeps the hold active and stops activation.

## Pre-activation gates

Stop if any item fails:

1. PR #274 is merged after human approval and its exact head is present on the
   reviewed platform main revision. Re-run targeted guard tests there.
2. Reconfirm the artifact is non-expired and its manifest, record, producer,
   publisher, source ancestry, six ECR digests, and API attestations match this
   document exactly. Barriers must be empty.
3. Keep old lanes disabled, pause merges/manual managed-target mutations,
   inventory every app/platform/Terraform/control run, and let started mutations
   finish. Never cancel a run that has started mutation.
4. Re-snapshot services, Finance export configuration, ownership, desired
   release, checkpoints, operations, provenance, pending operation, and holds.
   Unknown/manual provenance blocks activation.
5. Obtain separate approval naming the artifact ID, both hashes, reviewed
   platform revision, producer-switch change, API resume, Booking resume,
   activation dispatch, and workflow restoration.
6. Resume the two holds in the order above. Both must be retained as `cleared`
   only after exact live verification and smoke.
7. During the frozen window, set application repository variable
   `COORDINATED_RELEASES_ENABLED=true`, read it back, and keep merges paused
   while accounting for every producer, publisher, and receiver run. Setting
   the variable and enabling future automatic delivery requires the exact
   approval in step 5; this runbook does not grant it.

## Activation and verification

Dispatch reviewed platform main `deploy-coordinated-release.yml` with
`operation=activate`, artifact `10863860900`, manifest hash
`1c3c44019ec534d374c7447cae32053d01bcdfeaa1ed8bbefd94594b2a41820e`,
and record hash
`4fd68c242053cd2da2af99e8a5e21275a622c599920980623dedb6aa896dddb8`.
Do not write SSM directly. The `production-ecs-mutations` lock must exclude
legacy, Terraform, and control mutations for the entire run.

Preparation validates first, then writes obligations/desired state and switches
ownership to batch. After that switch, cancellation is unsafe: use a fresh
dispatch of the exact artifact for recovery. API must reach the selected digest
and pass `/health` before any frontend mutation. All five frontend jobs may then
overlap. Finalize must record six `succeeded` results and no active hold.

Run bounded authenticated smoke for meaningful PMS, Booking Admin,
Marketplace/Admin and creator reads plus public tenant availability/quote. Do
not create reservations, payments, or customer-data writes. Redispatch the exact
artifact and prove six no-op results with zero additional `UpdateService` calls.
Capture Terraform non-overlap, task revisions, provenance, job intervals,
CloudTrail mutation counts, and sanitized smoke evidence.

After the successful duplicate no-op proof, restore the previously recorded
workflow states: re-enable platform `Deploy App Service` and the six app deploy
workflows so explicit manual recovery remains available. Their automatic jobs
must remain fenced by batch ownership and the enabled coordinated switch.
Re-enable the isolated Booking canary only after revalidating that its physical
identity is outside the six production targets. Observe and record the retained
old requests as authentication-denied or still non-runnable; never rerun them.

## Failure and rollback

- Prepare failure before state writes: reread all state before retrying.
- API failure after mutation: retain automatic hold/rollback; frontends stay
  skipped. If hold creation fails, do not attempt an unprotected rollback.
- Frontend failure: let siblings finish; retain the failed service hold and
  reconcile it with the same artifact.
- Runner/state-write interruption: never partial-rerun jobs; redispatch the exact
  artifact so the reconciler observes live state and repairs provenance.
- Missing, expired, tampered, or divergent publication: build and publish a new
  complete release; never reconstruct one.

System rollback requires separate approval. Pause producer and old automatic
lanes, drain/account for runs, disable the producer switch, then use
`manage-coordinated-release.yml` action `set-legacy-mode` under the same lock.
Retain desired state, holds, provenance, operations, checkpoints, and evidence.
Before restoring workflow availability, prove the retained desired-release
record still fences stale automatic events. Then re-enable platform `Deploy App
Service` and the six app workflows and restore only through explicit
`deploy.yml` manual recovery with approved immutable images and reasons. Treat
the isolated canary separately after physical-identity validation. Never delete
SSM state, reopen stale automatic delivery, or perform destructive schema
rollback.

## Remaining acceptance

Hosted recovery/lock rehearsal is recorded in
[hosted-rehearsal.json](evidence/vay-2029/hosted-rehearsal.json), but production
activation, product smoke, duplicate no-op proof, and matched measurements are
still missing. Matched acceptance requires ordinary post-activation
backend-only, shared-package, and at-least-three-merge burst samples. Report raw
values unless sample counts support a median (3+) or p90 (10+); do not invent a
percentage target.

Keep VAY-2029 In Progress until deployed evidence and explicit human acceptance.
