# Financials export worker staged rollout (VAY-2045)

The app contract is `engineering/finance-export-worker-runtime-permissions.md`.
The application owns migration 0412 and exports the exact table/column matrix
and policy-digest preflight in
`apps/api/dist/jobs/financeExportWorkerBoundary.js`. The platform runner imports
that module from the reviewed immutable app image.

This post-run disable stage keeps the dedicated export-worker secret and reviewed
property mapped while setting `FINANCE_EXPORT_WORKER_ENABLED=false` and removing
`FINANCE_EXPORT_WORKER_EXPORT_ID`. It assumes the role, secret, grant,
default-off image deployment, and preflights were completed using these steps:

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
runtime is still the exact reviewed activation (or has been safely switched to
the reviewed disabled revision during incident containment). This apply performs
the durable switch to disabled/no export ID. The Terraform plan must preserve the
reviewed property and dedicated secret for this first rollback.

During the exclusive VAY-1138 window, one task processed only existing export
`f3429f38-b462-4453-b7f1-d901fc86ebfa`; no replacement export may be enqueued.
This first rollback disables the worker and removes its export scope. A
subsequent reviewed apply sets
`finance_export_worker_secret_mapped=false` and
`finance_export_worker_property_id=""`. Preserve the job, audit, and artifact
rows. No Financials activation, payment, reservation, backfill, or shared-fixture
mutation is authorized here.

The deployment readiness guard still rejects any future enabled worker without
the exact reviewed export ID, property, and dedicated secret.
