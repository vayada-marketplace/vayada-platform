# Financials export worker staged rollout (VAY-2045)

The app contract is `engineering/finance-export-worker-runtime-permissions.md`.
The application owns migration 0412 and exports the exact table/column matrix
and policy-digest preflight in
`apps/api/dist/jobs/financeExportWorkerBoundary.js`. The platform runner imports
that module from the reviewed immutable app image.

This final rollback stage keeps `FINANCE_EXPORT_WORKER_ENABLED=false`, removes
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
any enabled worker without the exact reviewed export ID, property, and secret.
