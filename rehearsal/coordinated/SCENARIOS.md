# Recovery scenario evidence and hosted prerequisites

VAY-2029 requires failure recovery through the production reconciliation engine.
The bootstrap preflight is already hosted evidence: run
[35517167870](https://github.com/vayada-marketplace/vayada-platform/actions/runs/35517167870)
proved restricted GitHub OIDC and private health checks of six synthetic services.
It did not update services or exercise recovery.

## Offline sequence checks

Run from the repository root:

```sh
python3 -m unittest scripts/test_coordinated_release.py scripts/test_coordinated_recovery.py
```

The recovery suite executes the real preparation, publication validation,
checkpoint checks, reconciliation, durable record validation and finalization.
AWS state/tasks, GitHub metadata/downloads and smoke results are in memory;
subprocess and HTTP access are forbidden. It uses frozen synthetic contract data
and a fixed validation date. No live resource or credential is required.

| Sequence | Asserted outcome |
| --- | --- |
| Successful six-service release, then duplicate | Six initial updates; duplicate rechecks smoke/provenance without additional updates |
| One frontend fails smoke | Other services succeed; failed service rolls back and retains a hold; ordinary retry preserves it; explicit resume deploys only the selected frontend and rechecks API |
| API fails smoke | API rolls back; subsequent preparation blocks frontend execution; finalization rejects incomplete release |
| Worker interrupted after service update | Pre-mutation pending record survives; retry with failed smoke rolls back to the original task, not the interrupted target |
| Persistent SSM write denial after service update | No false success or unrecorded rollback; durable pending record survives; after write access returns, failed readiness triggers the original rollback and hold |
| Tampered publication or missing checkpoint | Preparation rejects before state writes or service updates |

This does **not** prove AWS permissions, eventual consistency, real ECS rollout
behavior, private smoke, parallel job overlap, global lock exclusion, or product
acceptance. Initial API-before-frontends scheduling is a workflow contract check,
not executed by this synchronous test harness. No latency claims follow from it.

## Hosted implementation (not yet applied or run)

`rehearse-coordinated-recovery.yml` is manual, platform-main-only and holds the
existing `production-ecs-mutations` lock for the entire run. It builds three
synthetic image variants and publishes immutable `recovery-RUN-ATTEMPT-VARIANT`
tags to the six fixture ECR repositories. The same trusted workflow creates
`publication.json`, binding repository, real platform source, run/attempt and
all 18 digests. Each phase validates that binding and the retained publication
hash. These are synthetic `recovery/v1/...` manifests, never application release
publications or migration attestations.

Before any service or SSM write, the runner compares the six live service/task
and network definitions against the reviewed baseline SHA256 input. It then
replaces only the fixture bootstrap image/command/environment/liveness check so
behavior comes from the selected image. Existing services, capacity, networking,
execution role and absence of task roles/secrets remain fixed. Images expose
revision-independent `/live` and revision-bound `/health`. An unhealthy fixture
returns a specific 503 body; its private probe returns exit42 only for that exact
response. Auth, task launch, pull and unrelated probe failures do not count as
successful negative-path evidence.

The suite exercises:

1. Six baseline transitions, then API-first healthy rollout and concurrent
   independent frontend reconciliations. Per-update timestamps are retained.
2. Duplicate verification with no additional updates.
3. A frontend readiness failure, original-task rollback, persistent hold,
   ordinary retry that leaves the hold intact, and explicit recovery.
4. An API readiness failure and actual hold, frontend blocking through the
   shared planner gate, and explicit API recovery.
5. A child worker process that exits immediately after a real ECS update;
   another invocation recovers using the retained pending operation.
6. A separate role that denies only booking-admin provenance writes in fixture
   run namespaces. The suite requires the exact AccessDenied failure after an
   update, rollback and retained hold, then resumes with the normal fixture role.
7. Fresh private smoke/provenance checks for all six services and the shared
   finalizer. No active fixture hold may remain before marking the suite complete.

The shared production reconciliation/finalization bodies accept explicit
fixture dependencies. Production wrappers still use their original manifest
validator, image guards and product smoke. The fixture entrypoint has no config
argument and constructs only the hardcoded fixture resource map. Both OIDC roles
are separate from the existing preflight and production roles. The denial role
cannot push images; only the normal fixture role has scoped ECR publication rights.

Read-only preparation commands (repository root):

```sh
python3 rehearsal/coordinated/scenarios.py --phase inspect
cd rehearsal/coordinated
terraform plan -input=false -lock-timeout=30s -out=scenarios.tfplan
```

Review the exact commit, clean saved plan/hash, policy decisions and baseline
fingerprint before approving merge, apply and one manual workflow run. The IAM
plan must create only the two fixture scenario roles and their inline policies.
The workflow run will mutate only the six synthetic services and fixture state;
it will retain images, task definitions, holds and evidence rather than delete
state. Artifacts are retained for 90 days. Fixture capacity remains six tasks;
rollouts and private probes add temporary Fargate capacity. On unexpected failure,
stop and inspect retained evidence instead of blindly rerunning or clearing holds.

## Remaining evidence limits

Hosted results are absent until the reviewed workflow actually succeeds. This
increment reuses service reconciliation/finalization and selected planning guards;
it does not execute production GitHub publication acquisition, source ancestry,
checkpoint planning, dispatch retry or GitHub matrix scheduling against AWS.
The private probe and shared lock are used, but a separate no-op lock contender
and measured production workflow overlap remain required. The SSM denial is a
specific post-update provenance failure, not a complete AWS outage. Existing
offline tests cover wider state-write loss. Product smoke, pricing repair, live
hold/queued-writer disposition and coordinated activation remain separate gates.
No production failure injection, application attestations, state deletion or
production activation is authorized by this document.
