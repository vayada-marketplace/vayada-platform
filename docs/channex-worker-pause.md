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
