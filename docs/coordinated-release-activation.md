# VAY-2029 activation record and runbook

Status: **ACTIVATED — final acceptance observation remains.** Coordinated batch
ownership is live for all six services. Both retained holds were reconciled and
cleared, the exact release and duplicate replay succeeded, the stale legacy
event was rejected, and workflow availability was restored. Authenticated
business-data reads, a four-relation Finance runtime read blocker, and matched
shared-package and merge-burst samples remain before explicit human acceptance.

Read with [the architecture](https://linear.app/vayadacom/document/coordinated-deployment-architecture-and-acceptance-plan-3f706981f863),
[runtime controls](coordinated-releases.md), and the
[VAY-2029 evidence index](evidence/vay-2029/README.md).

## Reviewed implementation and boundary evidence

| Change | Reviewed identity | Result |
| --- | --- | --- |
| Writer migration | platform [#262](https://github.com/vayada-marketplace/vayada-platform/pull/262), head `df2462b4a338991b4f1f34c54d8607045f30c729`, merge `3feb08591931d816d32eea300a6623a7ae9b0c29` | Apply [36105639066](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36105639066) succeeded with no infrastructure changes |
| Protected OIDC trust | platform [#265](https://github.com/vayada-marketplace/vayada-platform/pull/265), head `a50087b146672ec049b6da7582490bedb006ce49`, merge `057cd77c95ec1cbbdfdc90947d25e75faffb2a59` | Protected admission [36109471264](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36109471264) passed; no-environment probe [36109998999](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36109998999) denied all 12 assume attempts |
| Transition-session cutoff | platform [#272](https://github.com/vayada-marketplace/vayada-platform/pull/272), head `4e89f9b4ebb83a43c0c3533ece99a5c96fda1460`, merge `9ac1e0852e16dba42da39db7bc539b4baf63df61` | Cutoff `2026-09-25T08:08:47Z`; post-cutoff Apply [36117487916](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36117487916) passed with 0 added, 0 changed, 0 destroyed |
| Candidate API attestations | platform [#274](https://github.com/vayada-marketplace/vayada-platform/pull/274), head `e600571272c5db7c7877986e26939cba5a66c7b5`, merge `73b73bb3013ef849f24c608559681218f448274b` | Merged after green CI and clean independent/CodeRabbit review; still not deployment approval |
| Fresh API attestation | platform [#276](https://github.com/vayada-marketplace/vayada-platform/pull/276), head `5da1da6373f876cdaa6277c3f75e4d6d5da9fe80`, merge `c5b3592942280eb4b61533fe6932d76135faa667` | Green CI/CodeRabbit; independent review proved identical launcher and 11 Finance export modules |

The mutation role trust is limited to audience `sts.amazonaws.com` and subject
`repo:vayada-marketplace/vayada-platform:environment:platform-mutations-v2`.
Its cutoff explicitly denies older sessions. Retained queued runs `34749336429`
and `34749338561` have no jobs and are fenced by that trust/cutoff; do not rerun,
cancel, or use them as release evidence.

## Exact activated candidate

The production candidate was:

- app source `f2f02832f8db0e02859871becb6210a811639842`;
- build [36141509208](https://github.com/vayada-marketplace/vayada/actions/runs/36141509208), attempt 1, `prepare_only=true`, one API image built and five images reused;
- publisher [36141898912](https://github.com/vayada-marketplace/vayada/actions/runs/36141898912), attempt 1;
- published artifact `10867296213`, expiring `2026-12-24T13:35:18Z`;
- manifest ID `vayada-release/v1/f2f02832f8db0e02859871becb6210a811639842/36141509208/1`;
- manifest SHA-256 `0cd2fc120e93cb83c5b040af565e3f4b0ec58d805e43c3bf35c2c6c69ef71c6f`;
- published-record SHA-256 `1bd7e51dde9922c6f57637e0b952a678df108dcbfd209d2cfc0428ed0b86c55b`.

All six immutable digests and publication metadata are in
[final-candidate-publication.json](evidence/vay-2029/final-candidate-publication.json).
The earlier `candidate-publication.json` remains historical preparation
evidence and was not the activated artifact.

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

At snapshot time, `COORDINATED_RELEASES_ENABLED`, ownership mode, and desired
release were absent, so legacy/default ownership remained. Seven old app lanes
and platform `Deploy App Service` were manually disabled; coordinated
build/publish, deploy, and control workflows remained active. This is a
historical pre-activation snapshot, not the current production state.

## Hold reconciliation outcome

Both holds remain retained as cleared audit records:

1. API: operation `legacy-36096727520-1`, captured task `vayada-next-api:1158`,
   digest `sha256:3cc5df6b3400b1c5710a595b3eb4baf0964add9c8d89e7347b123138c21cb798`,
   reason “VAY-1134 user-authorized all-hotel export preparation”,
   `dependentFrontendsCompatible=false`.
2. Booking Web: operation `legacy-35844135741-1`, captured task
   `vayada-next-booking-frontend:400`, digest
   `sha256:3d21330c21f3a7ebce1102624f62a37f4f2952a026baa4f2b9ceece33bb9447a`,
   reason automatic rollback after failed per-service cutover,
   `dependentFrontendsCompatible=false`.

API resume [36158940242](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36158940242)
deployed task `1162`, retained the Finance export enablement/cutoff, passed
readiness smoke, and cleared its hold. Booking Web resume
[36159531984](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36159531984)
deployed task `428`, passed public smoke, and cleared its hold. Neither record
was deleted or edited in place.

## Executed pre-activation gates

The approved window executed these technical gates in order. The production
approval named artifact `10867296213` and authorized the four broad operational
steps, but did not restate both hashes, the reviewed platform revision, or every
sub-action in the exact tuple required by step 5. That exact-approval evidence
therefore remains partial even though the authorized activation succeeded:

1. Confirm PR #274 merge `73b73bb3013ef849f24c608559681218f448274b`
   remains an ancestor of the reviewed platform main revision. Re-run targeted
   guard tests there.
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
   activation dispatch, and workflow restoration. The received approval named
   the artifact and four broad operational steps; it did not restate the full
   tuple above, so this documentation gate is not fully closed.
6. Resume the two holds in the order above. Both must be retained as `cleared`
   only after exact live verification and smoke.
7. During the frozen window, set application repository variable
   `COORDINATED_RELEASES_ENABLED=true`, read it back, and keep merges paused
   while accounting for every producer, publisher, and receiver run. Setting
   the variable and enabling future automatic delivery requires the exact
   approval in step 5; this runbook does not grant it.

## Activation and verification record

Reviewed platform main dispatched `operation=activate` with artifact
`10867296213`, manifest hash
`0cd2fc120e93cb83c5b040af565e3f4b0ec58d805e43c3bf35c2c6c69ef71c6f`,
and record hash
`1bd7e51dde9922c6f57637e0b952a678df108dcbfd209d2cfc0428ed0b86c55b`.
No SSM state was edited ad hoc. The repository-scoped
`production-ecs-mutations` lock serialized platform deploy, Terraform, and
control mutations. App-repository legacy mutations were excluded separately by
workflow disablement during the window and then by the producer switch plus
batch-ownership fencing.

Preparation validated first, then wrote empty obligations, the exact desired
release, and batch ownership. API reached the selected digest and passed
`/health` before frontend jobs. Finalize recorded six `succeeded` results and no
active hold.

Bounded release smoke covered API health, four auth gateways, Booking tenant
build/host/profile/page, and the Booking browser canary without reservations or
payments. The exact duplicate produced six no-op results and zero additional
`UpdateService` calls. Authenticated business-data reads remain outstanding.

After the duplicate proof, platform `Deploy App Service`, the six app deploy
workflows, and the Booking public canary were restored. Automatic legacy jobs
remain fenced by batch ownership and `COORDINATED_RELEASES_ENABLED=true`.
Stale-event run `36161462488` proved rejection before ECS mutation.

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

## Production outcome and remaining acceptance

Verify-only run `36158862064` passed before mutation. Activation
[36160171047](https://github.com/vayada-marketplace/vayada-platform/actions/runs/36160171047)
completed with all six services succeeded, API readiness before frontend jobs,
and the four required frontend mutations starting within 1.33 seconds. Exact
duplicate `36160889150` succeeded with six no-op results and zero CloudTrail
`UpdateService` events. Stale legacy event `36161462488` failed at the ownership
guard with zero ECS mutations. Booking browser canary
[36161297153](https://github.com/vayada-marketplace/vayada/actions/runs/36161297153)
passed. Exact tasks, digests, results, smokes, operation intervals, and
CloudTrail mutation events are recorded in the production evidence files;
GitHub Actions, SSM, and CloudTrail remain the raw authoritative sources.

Subsequent production-root runs `36161738886` and `36161818636` failed before
Terraform Apply at the target-database readiness guard because four Finance
runtime relations lacked read access. Apply was skipped, so these runs neither
changed the activated release nor satisfy the remaining matched-release sample.
The affected deployed service is `next-target-backend` at
`vayada-next-api:1162`. Product impact remains unknown until authenticated
Finance reads are exercised. Close this blocker only through a reviewed
least-privilege `SELECT` grant for exactly these relations, followed by a
passing target-runtime preflight and any separately approved subsequent Apply
or release:

- `finance.affiliate_earning_reconciliation_revisions`;
- `finance.affiliate_eligible_earning_revisions`;
- `finance.affiliate_earning_allocations`;
- `finance.affiliate_earning_allocation_items`.

Remaining acceptance is deliberately narrow: resolve and verify the exact
Finance runtime grant blocker above; record reusable-account authenticated
business-data reads for Finance, PMS, Booking Admin, Marketplace, and Admin
without writes; then observe a normal post-activation shared-package release
and an at-least-three-merge burst. Current sample counts do not support median,
p90, or a reduction percentage.

Keep VAY-2029 In Progress until the remaining observations and explicit human
acceptance are complete.
