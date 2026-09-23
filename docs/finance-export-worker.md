# Financials export worker staged rollout (VAY-2045)

The app contract is `engineering/finance-export-worker-runtime-permissions.md`.
The application owns migration 0410 and exports the exact table/column matrix
and policy-digest preflight in
`apps/api/dist/jobs/financeExportWorkerBoundary.js`. The platform runner imports
that module from the reviewed immutable app image.

Nothing in this change provisions a role, maps a secret by default, or enables
Financials. After the app migration and image are reviewed, the bounded rollout
uses these explicit steps:

```sh
python3 scripts/create-target-database-identity-secret.py --finance-export --check
python3 scripts/create-target-database-identity-secret.py --finance-export --create
bash scripts/run-target-database-runtime-preflight.sh --provision-finance-export-worker
bash scripts/run-target-database-runtime-preflight.sh --grant-finance-export-worker <reviewed-property-uuid>
bash scripts/run-target-database-runtime-preflight.sh --preflight-finance-export-worker <reviewed-property-uuid>
bash scripts/run-target-database-runtime-preflight.sh preflight
```

The absent-only SSM secret is
`/vayada/prod/target-database-finance-export-worker-url` and its login is
`vayada_next_finance_export_worker`. Neither is shared with the expense worker,
Channex worker, API runtime, identity runtime, or migration owner. The one-shot
grant refuses drift or a different existing property scope.

Review Terraform with `finance_export_worker_secret_mapped=true` and the same
`finance_export_worker_property_id`; the ECS task still sets
`FINANCE_EXPORT_WORKER_ENABLED=false`. Verify the exact source SHA, image digest,
task-definition revision, secret mapping, worker preflight, and unchanged general
API runtime preflight before the separately reviewed enablement revision.

During the exclusive VAY-1138 window, enable one task only for existing export
`f3429f38-b462-4453-b7f1-d901fc86ebfa`. Do not enqueue another export. Rollback
first disables the worker and then removes its secret mapping; preserve the job,
audit, and artifact rows. No Financials activation, payment, reservation,
backfill, or shared-fixture mutation is authorized here.
