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

## Required before hosted failure injection

1. Add a fixture-only entrypoint with exact account, cluster, six service/ECR/task
   families, subnet, security group, execution role and state-prefix allowlists.
   Require a dedicated assumed role before mutation. Keep production entrypoints
   and publication validators intact; do not add a skip-validation switch.
2. Extract shared execution functions from the existing preparation,
   reconciliation and finalization bodies. Pass explicit fixture AWS/smoke
   dependencies; retain ordering, checkpoint, pending-operation, provenance,
   hold, retry and rollback behavior instead of copying a second scheduler.
3. Define separately trusted synthetic publication: platform main-only workflow,
   exact run/attempt/source, artifact hashes and all six fixture ECR digests.
   Never manufacture application-publisher or API migration attestations.
4. Publish the reviewed baseline to fixture ECR. Current Docker Hub bootstrap
   images cannot pass the reconciler's ECR identity validation. Replace inline
   bootstrap commands and fixed-revision health checks so fixture behavior comes
   from the selected image, with revision-independent liveness and independent
   private smoke validating the expected service/revision.
5. Review a clean Terraform plan for a separate scenario role. The current probe
   role explicitly denies service and SSM mutation. Bound new permissions to
   fixture resources and `/vayada/rehearsal/coordinated-deployments/v1/*`, preserve
   production denies, and verify negative authorization before injecting faults.
6. Run through the global workflow lock with bounded timeouts and retained
   before/after evidence. Test SSM denial and interruption against fixture state,
   then retry without deleting durable records. A full state outage can prevent
   recording a hold and therefore prevent automatic rollback; report unresolved
   state honestly and retain the pre-mutation target for recovery.

These prerequisites require implementation, independent review and exact
merge/apply/run approval under VAY-2029 AC4. This document grants no authority to
alter IAM, bootstrap service definitions, enable production delivery, clear holds,
delete state or perform failure injection.
