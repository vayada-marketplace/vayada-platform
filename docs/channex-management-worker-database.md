# Channex worker credential — VAY-2041

This adds a reviewed preparation path; no credential, grant, mapping, or worker
activation is applied by merging. Keep the scoped canary and ARI scheduler paused.
The app image must contain migrations0407/0408, the exact worker matrix, boundary
preflight, and startup gate. Coordinate migration0409 with Finance worker work.

The fixed non-owner login is `vayada_next_channex_management_worker`; its SSM
SecureString is `/vayada/prod/target-database-channex-management-worker-url`.
The application uses `PMS_CHANNEX_MANAGEMENT_DATABASE_URL`. General API runtime
and migration credentials keep their existing mappings. The image entrypoint
removes the migration credential before starting the long-lived API.

After review and deployment authorization, the existing protected one-off runner
supports these distinct phases (examples are instructions, not executed evidence):

```sh
python3 scripts/create-target-database-identity-secret.py --channex-management --check
python3 scripts/create-target-database-identity-secret.py --channex-management --create
bash scripts/run-target-database-runtime-preflight.sh --provision-channex-management-worker
bash scripts/run-target-database-runtime-preflight.sh --grant-channex-management-worker PROPERTY_UUID sha256:REVIEWED_IMAGE_DIGEST
bash scripts/run-target-database-runtime-preflight.sh --preflight-channex-management-worker PROPERTY_UUID sha256:REVIEWED_IMAGE_DIGEST
bash scripts/run-target-database-runtime-preflight.sh
```

The role/secret helpers refuse existing identities instead of rotating them.
Provisioning checks cluster database ACLs and safe non-owner role attributes.
Grant/preflight use the immutable reviewed application image, verify effective
privileges and guards, and permit exactly one reviewed property in the empty
owner-managed allowlist. The grant runner uses the migration owner only in the
bounded task; preflight receives only the dedicated worker secret. Both verify
RDS TLS with the pinned CA and omit credentials from output. They do not enable
processing. Existing unrelated scope is rejected rather than silently removed.

Normal `Deploy App Service` supports `channex_worker_database=true` only for the
paused `next-maps-canary` in `next`, with scoped Channex inventory enabled.
The default is false. Existing mapping is preserved on subsequent paused canary
deployments. The deployment verifies the image can load the worker modules,
then attests actual ECS secret references, property/staging/pause configuration,
and every running task's immutable image digest before switching routes.
Mapping does not enable the worker. Existing published-offer resume guards stay
in place pending resolution of the availability correlation blocker.

Local evidence: PG16/17 exact-role app tests cover creation, closed ARI,
activation, sync availability receipt/reconciliation, scheduler, retry/dead-letter,
and denied unrelated writes. The unchanged general API preflight passes with
its own role and no worker grants. Platform tests use mocks and a compiled local
image probe; no AWS calls, deployed secret verification or provider writes were
performed. Migration0320 currently rejects a provision job that needs fresh
availability with23514, `Active room mapping and correlated sync job required`.
Record/fix that blocker separately before scheduling an exclusive provider smoke.
