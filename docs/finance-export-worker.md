# Financials export worker rollout (VAY-1134 / VAY-2045)

The app contract is `engineering/finance-export-worker-runtime-permissions.md`.
The application owns migration 0412 and exports the exact table/column matrix
and policy-digest preflight in
`apps/api/dist/jobs/financeExportWorkerBoundary.js`. The platform runner imports
that module from the reviewed immutable app image.

The historical final rollback stage kept `FINANCE_EXPORT_WORKER_ENABLED=false`, removes
`FINANCE_EXPORT_WORKER_EXPORT_ID`, clears the property scope, and unmaps the
dedicated export-worker secret. The completed rollout used these provisioning
and preflight steps:

```sh
python3 scripts/create-target-database-identity-secret.py --finance-export --check
python3 scripts/create-target-database-identity-secret.py --finance-export --create
bash scripts/run-target-database-runtime-preflight.sh --provision-finance-export-worker
bash scripts/run-target-database-runtime-preflight.sh --grant-finance-export-worker <reviewed-property-uuid> <reviewed-export-uuid>
bash scripts/run-target-database-runtime-preflight.sh --preflight-finance-export-worker <reviewed-property-uuid> <reviewed-export-uuid>
bash scripts/run-target-database-runtime-preflight.sh preflight
```

The absent-only SSM secret is
`/vayada/prod/target-database-finance-export-worker-url` and its login is
`vayada_next_finance_export_worker`. Neither is shared with the expense worker,
Channex worker, API runtime, identity runtime, or migration owner. The one-shot
grant refuses drift or a different existing property scope.

Before applying this stage, verify the approved export is terminal and the live
runtime is the exact reviewed first rollback: disabled, no export ID, with the
reviewed property and dedicated secret still mapped. This apply must only clear
the property and remove that secret mapping; it must keep the worker disabled.

During the exclusive VAY-1138 window, one task processed only existing export
`f3429f38-b462-4453-b7f1-d901fc86ebfa`; no replacement export may be enqueued.
The first rollback disabled the worker and removed its export scope. This
reviewed final apply sets
`finance_export_worker_secret_mapped=false` and
`finance_export_worker_property_id=""`. Preserve the job, audit, and artifact
rows. No Financials activation, payment, reservation, backfill, or shared-fixture
mutation is authorized here.

The deployment readiness guard accepts the exact disabled/mapped transition
state and the final disabled/unmapped state, while rejecting partial mappings or
invalid enabled-worker scope or secret mappings.


## Ongoing exports for every hotel

The ongoing contract is `engineering/finance-ongoing-export-activation.md` in the
app repository. Deploy the reviewed app image containing migration 0424 and the
ongoing worker before enabling this mode. The migration enrolls existing and
future hotels; API authorization and restrictive worker RLS remain required.

Keep `finance_export_worker_enabled=false` during preparation. After the image
and database gates pass, run the read-only checks:

```sh
bash scripts/run-target-database-runtime-preflight.sh --preflight-finance-export-ongoing
bash scripts/run-target-database-runtime-preflight.sh preflight
```

Activation requires a reviewed Terraform configuration with
`finance_export_worker_enabled=true` and a fixed canonical UTC millisecond timestamp
in `finance_export_worker_accepted_after`. Keep that timestamp across restarts and
image deployments. Leave `finance_export_worker_property_id` empty; there is no
exact export ID in ongoing mode. Enabling maps the dedicated worker secret and
writes the pinned RDS CA before starting Node with `NODE_EXTRA_CA_CERTS`. The app
uses `sslmode=verify-full` for every export worker database pool.

Only unexpired requests both created and accepted at or after the cutoff are
eligible. Do not reset, replay, or change historical requests. The user waived
the live CSV download test for this activation; automated tests, least-privilege
preflights, a clean Terraform plan and service health verification still apply.

Rollback sets the enabled flag to false and clears the cutoff, property scope,
and secret-mapped flag. Preserve all request, attempt, audit and artifact rows.
The expense worker and other release switches are independent of this setting.


## All-hotel activation on 2026-09-25

`infra/finance_export_ongoing.auto.tfvars.json` fixes the acceptance cutoff at
`2026-09-25T05:01:48.721Z`. Retain this timestamp across restarts and deployments.
The reviewed API source is `f38ac1efdbd3eae46d538857e43bbe74d31c7aa1`.
Existing jobs before the cutoff stay untouched; live CSV download verification
is explicitly waived. Deployment of an older image while ongoing exports are
enabled is rejected by the split-image guard. Add future compatible images to
the ongoing compatibility list only after review. For rollback, disable/unmap
exports first while retaining this image, the migration and job/artifact evidence.
