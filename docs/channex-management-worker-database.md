# Channex worker credential — VAY-2041

This adds a reviewed preparation path; no credential, grant, mapping, or worker
activation is applied by merging. Keep the scoped canary and ARI scheduler paused.
The app image must contain migrations0407/0408/0410, the exact worker matrix,
boundary preflight, and startup gate. Migration0409 remains owned by Finance.

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
in place until the exact image containing migration0410 is deployed and verified.

Local evidence: PG16/17 exact-role app tests cover creation, closed ARI,
activation, sync availability receipt/reconciliation, scheduler, retry/dead-letter,
and denied unrelated writes. The unchanged general API preflight passes with
its own role and no worker grants. Platform tests use mocks and a compiled local
image probe; no AWS calls, deployed secret verification or provider writes were
performed. Migration0410 admits provision availability only when the locked
published-offer room exactly matches the active mapping; deploy and preflight
that reviewed revision before scheduling an exclusive provider smoke.

## Connection-only production scope (VAY-2055)

Production `vayada-next-api` may run only Channex `enable` (connection) jobs,
and only for hotels that have no Channex binding yet, so onboarding can prepare
a brand-new hotel for the Airbnb import. The same `vayada_next_channex_management_worker`
login, SSM secret and `PMS_CHANNEX_MANAGEMENT_DATABASE_URL` mapping are reused.
Provisioning, ARI, booking sync, markups and messaging stay `observe_only`, and
the worker's claim query, row-level security and startup preflight each refuse
anything else. The application image must contain migration 0473 and the
matching boundary digests.

Database scope is the operation, not a property list: the owner-managed table
`platform.channex_management_worker_operations` admits `enable`, and policies
admit a hotel's catalog, location, room types, binding claim and connection rows
only while an admitted enable job for that hotel is pending or running. The
worker can insert exactly one active enable claim and one connected connection
row per hotel and can never retarget, release or disconnect an existing binding.

Rollout, in this order, each step reviewed and approved separately
(instructions, not evidence). After VAY-2056 the hotel-setup services, their image
inventories and `vayada-next-api-setup-caller-execution` no longer exist: the API
task runs on `ecsTaskExecutionRole`, which already reads `/vayada/prod/*`, so the
hotel-setup parts of steps 0 and 2 no longer apply. Migration 0473 also changes policies that the
hotel-setup services attest, so the image that contains it must be admitted to
the hotel-setup inventories and deployed to those services together with the
next API; the next API runs the migration at startup.

```sh
# 0. Deploy the image containing migration 0473 to vayada-next-api and the
#    hotel-setup services; verify the running digest is REVIEWED_IMAGE_DIGEST.
# 1. Admit the operation and apply the enable grants with that image. The grant
#    fails closed (policy_drift) until 0473 is applied.
bash scripts/run-target-database-runtime-preflight.sh --grant-channex-connection-worker sha256:REVIEWED_IMAGE_DIGEST
# 2. Admin bootstrap (outside CI): add the worker SSM parameter to the inline
#    policy public-api-existing-parameters-and-exact-setup-tokens on
#    vayada-next-api-setup-caller-execution. The platform deploy role may not
#    change that policy (iam:PutRolePolicy is denied), so Terraform alone fails.
#    Then Terraform: channex_connection_worker_secret_mapped = true. The one-off
#    preflight task inherits the API execution role, so this precedes step 3.
# 3. Prove the dedicated login sees the connection scope and nothing wider.
bash scripts/run-target-database-runtime-preflight.sh --preflight-channex-connection-worker sha256:REVIEWED_IMAGE_DIGEST
# 4. Terraform: channex_connection_worker_enabled = true (worker on, connection
#    mutating). Only after step 0 is live: an older image rejects this shape at
#    startup with channex_worker_scope_unsupported.
```

The grant refuses an operations table that contains anything but `enable` and
leaves the canary property allowlist untouched. `Deploy App Service` keeps the
Terraform-declared connection scope on `next-target-backend` only when the
dedicated secret is mapped and exactly `PMS_CHANNEX_WORKER_ENABLED=true` with
`PMS_CHANNEX_CONNECTION_MODE=mutating` is declared; every other durable
capability is still forced to `observe_only` on each deployment. Inspect the
`pms.channex.management` queue for pending non-enable jobs before and after the
rollout: the connection worker must leave them untouched.

## Claimed booking scope (VAY-2108)

Hotels handed over from legacy get their Channex bookings from `vayada-next-api`.
The target pulls each claimed hotel's Channex booking feed every 5 minutes,
persists the revisions and acknowledges them. Booking sync and the feed pull
run on the ordinary API login, so this stage needs no worker grant: the worker
keeps exactly the connection scope above. Webhook intake stays `observe_only`
(pull only).

Terraform (`infra/channex_claimed_scope.tf`):

- `channex_claimed_scope = "booking"` sets `PMS_CHANNEX_SCOPE=claimed`,
  `PMS_CHANNEX_BOOKING_SYNC_MODE=mutating` and
  `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned` on next-api only. It
  requires the enabled connection worker. The default `"off"` renders the task
  definition unchanged.
- `channex_owned_property_ids` becomes `PMS_CHANNEX_OWNED_PROPERTY_IDS`
  (comma-separated). A hotel is synced only when it has an active binding claim
  *and* is listed here. The list is non-empty exactly when the scope is
  `"booking"`: the app refuses the claimed scope without the variable, and an
  empty ECS environment value is not relied on. Terraform refuses duplicates,
  non-canonical UUIDs and the four staging/test properties reserved by app
  migration 0432.
- `scripts/next-api-channex-claimed-compatible-images.txt` lists the reviewed
  images that recognise the claimed scope; an older image refuses it at startup
  (`channex_worker_scope_unsupported`). While the current task declares the
  scope, `Deploy App Service` refuses to deploy, or roll back to, an unlisted
  image. `tf-apply` refuses a plan that declares the scope unless every running
  next-api task uses a listed image, because it rolls the new task definition
  out on the running image.

Never set the legacy PMS `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE`
(`infra/legacy_pms_freeze.tf`) for this: on legacy any non-legacy value
freezes booking polling for every hotel. Legacy stops per hotel through the
handover runbook (`is_active=false`), which must happen before the hotel is
claimed, because Channex feed acknowledgements are shared.

Order, each step reviewed and approved separately (instructions, not evidence):

```sh
# 0. Admit the claimed-capable image to
#    scripts/next-api-channex-claimed-compatible-images.txt, deploy it to next-api
#    and verify the running digest. Keep a listed image as the rollback target.
# 1. First hotel, at handover: legacy disable plus readback, then Terraform
#    channex_claimed_scope = "booking" with channex_owned_property_ids = [that
#    hotel]. Still inert for it: it has no active claim yet.
# 2. The audited claim activation for that hotel starts its 5-minute pull.
# 3. Each further hotel: legacy disable plus readback, add it to
#    channex_owned_property_ids, then activate its claim.
```

Kill switches: revoke one hotel's claim or remove it from
`channex_owned_property_ids` (for the last hotel, set the scope to `"off"` with an
empty list), or set `channex_claimed_scope = "off"` (all hotels). Never use the
target Channex disable command for this: it deletes the Channex property.

`Deploy App Service` keeps the claimed booking scope on `next-target-backend`
only when it is declared exactly, on top of the connection scope: `PMS_CHANNEX_SCOPE=claimed`,
booking sync mutating, `target-owned`, a valid owned-property list and
`CHANNEX_WEBHOOK_INTAKE_MODE=observe_only`. Anything else falls back to the
connection scope with every claimed setting removed. The `tf-apply` readiness
check accepts the same two shapes.

## Claimed booking staging canary (VAY-2108)

`Deploy App Service` with service `next-maps-canary`, environment `next` and
`channex_staging_booking=true` runs the claimed booking pull (every 5 minutes:
fetch the Channex booking feed, persist, acknowledge) for the synthetic property
`65f6b2fc-c783-4963-9d6b-a85f82319769` against staging Channex, with the staging
key, `PMS_CHANNEX_WORKER_ENABLED=false`, no worker or webhook secret and
background workers off. It excludes the restrictions canary (`channex_staging`)
and its options, and refuses to start while that canary's routes exist: remove it
first (service `next-maps-canary-remove`). The image must report
`channexManagement.scope === "claimed"`.
Every other canary mode drops the claimed settings it would otherwise copy from
production next-api and forces booking sync to `observe_only`, so a canary never
pulls production hotels.
