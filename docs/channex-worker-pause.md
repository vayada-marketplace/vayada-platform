# Pause the synthetic Channex worker

Use the protected `deploy.yml` workflow with service `next-maps-canary`, environment
`next`, the currently deployed immutable API image tag, `channex_staging=true`,
and the existing `channex_staging_meals` setting. Set `channex_worker_state` to
`paused` or `running`. The image tag must resolve to the current canary digest.
These actions copy the current task definition and change only
`PMS_CHANNEX_WORKER_ENABLED`; they do not change routes, secrets, capability modes,
guest/admin services, or the image. An already matching state is a no-op.

The default `preserve` performs normal deployment and retains the existing
worker state. A new image therefore cannot silently resume a paused worker.
The first staging deployment still starts the worker as before.

Before fixture writes, verify the successful rollout's actual running task
definition has the worker disabled, then inspect the shared property's durable
management queue for zero running jobs. Rollout success alone is not proof that
an in-flight job has finished. Keep pending jobs; do not change the connection
status to suppress work.

For a new room, prepare its canonical facts/unit/rate while paused, create bounded
zero-availability provider fixtures under the existing sandbox, and apply reviewed
audited mappings before materializing inventory. A canonical rate save queues a
meal job even without inventory, so omitting inventory is insufficient isolation.
Verify every active rate has its required mapping and that the expected channels
have not changed. A restored provider OTA channel does not authorize adding OTA
variants to a direct-only fixture.

After mapping validation, resume using `running` with the current image, verify
the actual runtime, and drain/recheck the pending work before continuing the test.
Record original configuration, operation IDs, results, restoration, and lease
release. Failed worker-state rollout requests restoration of the previous task
definition; verify that rollback completes before proceeding.

For a read-only preflight, invoke the script with the same staging flags,
`--channex-worker-state paused` (or `running`), and `--plan`.

## Baseline next API recovery (VAY-2041)

The baseline `vayada-next-api` service has no management-worker credential.
Its previous `PMS_CHANNEX_CONNECTION_MODE=mutating` implicitly enabled that
worker. Image `next-b02ff0b9c110e8771ffb553e5ab6915d2809b424` rejected this
configuration at startup in task revision 1125. Setting only the worker flag
to false also fails: unscoped mutating durable commands require an enabled worker.

Terraform and the normal deployment workflow therefore set the worker flag to
false and all six durable capabilities (connection, provisioning, ARI, booking
sync, markups, messaging) to `observe_only`. This makes their mutation endpoints
unavailable during recovery. Reviews and iframe keep their existing independent
configuration. No worker credential or staging scope is added to this service.
The deployment script enforces the same pause on an optional rollback artifact.
The staging canary uses its separate workflow and is unaffected.

Recovery uses the protected `Deploy App Service` workflow on reviewed `main`:
service `next-target-backend`, environment `next`, repository `vayada-next-api`,
image SHA `b02ff0b9c110e8771ffb553e5ab6915d2809b424`, and expected digest
`sha256:b24bb28fa25c60584c5955196dd1bf9ed5ab069bc89a20301ac83bd81373958c`.
Supply the coordinated operation reason and retain image compatibility checks.
Merging the Terraform change also triggers its normal plan/apply workflow;
inspect that plan and outcome before dispatching a second rollout.

After deployment, verify the actual running task has that immutable digest,
the seven pause settings, and no management-worker secret. Require a completed
ECS rollout, no new startup failures, and passing auth and public Booking smoke
checks before reporting recovery. This PR's local config test is not live
rollout evidence. Resume management only through a separate reviewed rollout
with the least-privilege credential and worker preflight; do not flip the flag
alone or reuse the general runtime credential.
