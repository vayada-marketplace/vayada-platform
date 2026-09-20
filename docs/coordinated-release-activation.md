# VAY-2029 activation record and runbook

Status: **NOT READY — no activation or infrastructure mutation performed.**
Read with [the architecture](https://linear.app/vayadacom/document/coordinated-deployment-architecture-and-acceptance-plan-3f706981f863)
and [runtime controls](coordinated-releases.md). VAY-2027 and VAY-2028 were
explicitly accepted; that is not evidence that the receiver IAM is installed.

## Reviewed inputs and observed state

| Component | Accepted implementation | Inspection revision |
| --- | --- | --- |
| Application | [#2484](https://github.com/vayada-marketplace/vayada/pull/2484), `cb9a05c89e458ced6c7fd81bb9b98f2efae32a44` | `05caa7ade23c554856a8b44a6d48c6cd5d89a621` |
| Platform | [#150](https://github.com/vayada-marketplace/vayada-platform/pull/150), `aeffe2f7cbb07365e9bfc96f6a7b12e793e05e08` | `67bffda7b8858dc08b7090161064ec5cc88892b2` |
| API attestation | [#155](https://github.com/vayada-marketplace/vayada-platform/pull/155), `67bffda7b8858dc08b7090161064ec5cc88892b2` | Same |

The VAY-2029 fixes must be independently reviewed and merged before activation.
Record those final merge SHAs and the exact selected artifact/hashes in the
ticket before requesting deployment approval. Never substitute the current main
tip for the reviewed revision or infer live application SHA from platform SHA.

Sanitized read-only AWS evidence: [live inventory](evidence/vay-2029/live-inventory.json),
[ECR source tags](evidence/vay-2029/ecr-provenance.json),
[verified source build/ancestry](evidence/vay-2029/source-build-proof.json), and
[active queue](evidence/vay-2029/active-queue.json). All six source checks passed with the local operator credential after configuring
the local Python trusted CA bundle; receiver credential proof is still pending.
These are time-bounded,
non-atomic observations, not a cutover authorization; recollect under the pause.

| Service | Task revision | Image source at inventory |
| --- | --- | --- |
| API | `vayada-next-api:1116` | `cb9a05c89e458ced6c7fd81bb9b98f2efae32a44` |
| PMS Web | `vayada-next-pms-frontend:564` | `99142518ab0ffafef4b76987bb3c7aadf6eea081` |
| Booking Web | `vayada-next-booking-frontend:378` | `99142518ab0ffafef4b76987bb3c7aadf6eea081` |
| Booking Admin | `vayada-next-booking-admin:506` | `05caa7ade23c554856a8b44a6d48c6cd5d89a621` |
| Marketplace Web | `vayada-next-marketplace-frontend:526` | `05caa7ade23c554856a8b44a6d48c6cd5d89a621` |
| Vayada Admin | `vayada-next-marketplace-admin:477` | `05caa7ade23c554856a8b44a6d48c6cd5d89a621` |

Every sampled service had one running/desired task, completed rollout, and a
running-container digest matching its task definition. This is deployment
inventory, not authenticated product smoke.

## Blocking gates

1. AWS `GetRole` reports `NoSuchEntity` for
   `vayada-github-actions-coordinated-deploy`. [Apply 35212756725](https://github.com/vayada-marketplace/vayada-platform/actions/runs/35212756725)
   failed because `vayada-github-actions-platform-deploy` lacks `iam:CreateRole`
   on that exact role. Live policy simulation also denies GetRole, GetRolePolicy,
   ListRolePolicies, ListAttachedRolePolicies and PutRolePolicy on it. The scoped
   `ManageCoordinatedReceiverRole` grant in `infra/github_actions_iam.tf` must be
   bootstrapped by the operator as well; creating the receiver alone leaves CI
   unable to manage it. An authorized infrastructure operator must prepare and
   approve scoped IAM bootstrap and a clean Terraform plan. Do not retry the
   failed apply unchanged or grant wildcard IAM administration.
2. `COORDINATED_RELEASE_READ_TOKEN` is absent from the platform repository and
   `next` environment secret listings. Organization-secret inspection is denied
   (HTTP 403), so inherited availability remains unverified. Configure a
   read-only Actions/Contents credential for the private application repository,
   then prove exact artifact download and commit comparison from the receiver
   identity. A local operator's `gh` access is not that proof. The app's
   `PLATFORM_DEPLOY_TOKEN` is present; existence alone does not prove dispatch.
3. API hold `legacy-35486395230-1` remains active, with
   `dependentFrontendsCompatible=false`, captured task `vayada-next-api:1114` and
   digest `sha256:d4123405c6187ec7eb49a59f692b0dd542a4ff7110acec6a52de6cfe6c6a67c8`.
   Preserve it. Resolve through an explicitly approved exact-manifest API resume;
   successful unrelated legacy deployments do not clear or invalidate the hold.
4. Queue inventory contains pre-guard revision `2d7a5772d80365ccabab6938fb2c4c1d5993a808`
   runs `34749338561` and `34749336429`, plus current pending/running writers.
   Old checked-out code cannot enforce new ownership guards. Every such run
   needs a documented drain or individually justified pre-mutation cancellation.
5. No real coordinated release, non-production AWS failure rehearsal, matched
   before/after sample, or complete product smoke evidence exists yet.

## Protocol, permissions and state

Both repositories use v1; mirrored schemas/fixtures must compare byte-for-byte.
Valid fixture hashes: manifest `6360c61c601c1c043ce032e2dd2fa22c709204fc45debd026417d09d0be84382`,
record `96882677caea9450ba1f94c55e3996f32a30098fa90876697c97a73a57bbe16a`.
Candidate retention is 14 days; published records are 90 days; plan bundles one
day. Expired/unverifiable records require rebuilding, never reconstructing tags.

Terraform owns the scoped IAM role/policy, not runtime SSM values below
`/vayada/prod/coordinated-deployments/v1`. Preserve desired state, bootstrap
evidence, provenance, holds, pending operations and checkpoint evidence across
rollback. There is no runtime record deletion or destructive schema rollback.
Activation proves each unheld live digest against existing provenance or an
unambiguous ECR source tag and successful allowlisted main-push build; the source
must be an ancestor of the selected manifest. Unknown/manual images require an
explicit hold. Bootstrap evidence is distinct from post-smoke provenance.

## Writer inventory and pause/drain sequence

The six app `deploy-next-{api,pms-web,booking-web,booking-admin,marketplace-web,vayada-admin}.yml`
files build/publish images and dispatch legacy events. Their automatic jobs now
share `COORDINATED_RELEASES_ENABLED`; explicit manual image builds remain available.
The coordinated build/publisher use the same switch. `deploy.yml`, coordinated
deploy/control, Terraform Apply and its auth roll-forward/rollback all share
`production-ecs-mutations`. Platform workflows retain queued requests with
`queue: max`; only application builds coalesce waiting ordinary source revisions.
Legacy/landing remain outside batch ownership. The isolated canary has distinct
physical targets and lock; verify that identity before excluding it from drain.

1. Obtain exact change/clean-plan approval; install IAM and verify token access.
   Coordinate the maintenance window with current deployment/smoke tasks and
   pause merges/manual managed-target mutations. Do not cancel running work.
2. Temporarily disable the six old app workflows with
   `gh workflow disable <workflow-file> -R vayada-marketplace/vayada`.
   Record their previous states. Inventory *all* queued/pending/waiting/running
   app and platform workflows, including old revisions and Terraform.
3. Let active mutations finish. Classify every pending source, checkpoint,
   manual operation and hold. Drain guarded runs; explicitly cancel only
   reviewed obsolete runs that have not started mutation. Record run IDs and
   reasons. Recheck the old pre-guard revisions are terminal.
4. Recollect live task/container digests, source builds and SSM records.
   Execute the controlled non-production rehearsal below. Unknown provenance,
   unresolved barriers or incompatible API hold blocks activation (step 7).
   Steps 5–6 may prepare the exact artifact and resolve the approved API hold.
5. With the six old lanes paused, set the one producer switch only after the
   reviewed gates pass:
   `gh variable set COORDINATED_RELEASES_ENABLED --body true -R vayada-marketplace/vayada`.
   Dispatch `build-coordinated-release.yml` on reviewed `main`. Bootstrap has no
   published baseline, so expect six builds; subsequent releases prove reuse.
   Ordinary receiver events in legacy mode must fail before state/ECS mutation.
6. Record successful build run/attempt, publisher run, artifact ID, both hashes,
   manifest source and all six digests. Approve that exact activation target.
   Resolve any approved held API through `operation=resume` with those exact
   inputs; failure preserves its hold and stops activation.
7. Dispatch `deploy-coordinated-release.yml` on the reviewed platform revision
   with `operation=activate`, `published_artifact_id`, `manifest_sha256` and
   `published_record_sha256`. The shared lock encloses prepare/API/frontends/
   finalize. Bootstrap validation precedes batch ownership. No ad-hoc SSM edits.
8. Verify all six results individually, API readiness before frontend jobs,
   frontend overlap and no Terraform mutation overlap. Redispatch the exact
   artifact to prove no additional ECS updates. Re-enable the six old workflows
   for manual recovery; their automatic jobs remain skipped by the switch.
   Resume merges only after recording the chosen outcome.

## Rehearsal and acceptance evidence

The [affected-input rehearsal](evidence/vay-2029/affected-input-rehearsal.json)
uses the actual workspace dependency graph: an API source change selects only
API; a domain-hotels change selects all six legitimate transitive consumers.
Local producer and consumer suites cover selection/history, invalid publications,
ordering, checkpoints, holds, retries and state failures using synthetic Git and
mocked adapters. VAY-2029 adds unknown/newer/manual bootstrap rejection,
post-rollback stale-event rejection and API compatibility before frontend resume.
These are **not** an AWS/GitHub integration rehearsal. Execute failure injection
only in an explicitly isolated non-production fixture with reviewed physical
identities; the production allowlist must not be bypassed to create that fixture.

Before activation, attach controlled non-production evidence for dispatch loss,
stale/tampered events, partial frontend failure and carried-image retry, failed
API gate, checkpoints, holds/resume, runner interruption and state-write failure.
Test a stale legacy event both in batch mode and after system rollback. Real
customer services must not be deliberately broken for these scenarios.

After activation, use the reusable accounts and coordinate fixture ownership.
Exercise meaningful authenticated PMS/Booking Admin/Marketplace/Admin reads,
creator access and public tenant availability/quote flows with synthetic data.
No reservations or payments. Attach sanitized run links and exact deployed SHAs.

Measure matched backend-only, shared-package and multi-merge-burst workloads.
Merge-to-live = main merge timestamp to last required successful service smoke;
queue = run creation to first mutation-lock job start; rollout = first mutation
to last required smoke. Count actual `UpdateService` calls, built/reused images,
superseded requests, failed/rolled-back/skipped/held services separately.
Report observation window and sample counts; median/p90 only when supported.
The historical 815 PR/2,338 workflow-start audit is context, not a matched control
or actual ECS mutation count. No reduction percentage is currently measured.

## System rollback

Pause producer dispatch and all six old automatic lanes, drain/account for
active runs and capture control records. Disable the producer switch, then use
`manage-coordinated-release.yml` with `action=set-legacy-mode` under the same lock.
Retained desired state deliberately keeps legacy automatic events fenced even
in legacy mode. Restore service delivery through explicit `deploy.yml` manual
recovery with approved immutable images/reasons; these establish durable holds.
This restores the previous manual delivery mechanism without reopening stale
automatic events. Re-enabling automatic legacy delivery requires a separately
reviewed source/generation fence, not deleting the retained desired record.
Keep all migration/checkpoint evidence and do not run destructive schema rollback.

Keep VAY-2029 In Progress until deployed evidence and explicit human acceptance.

## Preparation validation (2026-09-20)

- Producer: 16 tests pass. Consumer: 40 tests pass, including API verification
  preserving absent/compatible holds during frontend resume.
- Shared v1 schema and fixture directories are byte-identical after aligning
  the publication manifest-ID schema with the producer.
- Eight changed workflows parse as YAML. Actionlint 1.7.12 passes six app
  workflows; platform validation ignores only its unsupported `queue` key
  diagnostic. Shellcheck was not run. Existing successful platform workflows
  use `queue: max`; the real whole-batch exclusion rehearsal remains pending.
- Independent combined review and correction review completed with no remaining
  findings in these changes. Complexity pass found no additional abstraction
  to remove. No product code changed; product builds/smoke are not claimed here.
- These checks do not complete the ticket's integrated or deployed acceptance.

## Scoped IAM bootstrap preparation

The [sanitized scoped plan](evidence/vay-2029/iam-bootstrap-plan.json) adds the
receiver role and its inline policy and updates the platform CI policy with only
`ManageCoordinatedReceiverRole`. No existing statement is removed or modified;
no ECS/database/SSM-value change is planned. This is a targeted recovery plan,
not a full-stack drift plan. It has **not** been applied.

The private saved plan is kept outside Git. It was generated from the complete
Terraform configuration using the three resource targets named in the evidence.
Unrelated required secret variables use placeholders because those resources
are excluded; never execute an untargeted plan/apply from that scratch directory.
Validate the saved-plan hash and state freshness, then obtain explicit approval
before applying exactly that plan with the authorized operator identity. If
state is stale, regenerate/review the same targets and confirm the identical
three-action scope before proceeding. Do not run the existing broad apply as
bootstrap. Afterward, simulate CI access again and prove a fresh CI plan can
read/maintain the receiver; separately prove receiver OIDC/artifact access.
