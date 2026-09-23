# Financials export worker staged rollout (VAY-2045)

The app contract is `engineering/finance-export-worker-runtime-permissions.md`.
The application owns migration 0412 and exports the exact table/column matrix
and policy-digest preflight in
`apps/api/dist/jobs/financeExportWorkerBoundary.js`. The platform runner imports
that module from the reviewed immutable app image.

This activation stage maps the dedicated export-worker secret and reviewed
property, then enables exactly one ECS task for the exact reviewed export ID.
It assumes the role, secret, grant, default-off image deployment, and preflights
have already been completed using these explicit steps:

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

Before applying this activation, verify the exact source SHA, image digest,
default-off task-definition revision, secret mapping, worker preflight, and
unchanged general API runtime preflight. The Terraform plan must contain only the
exact export ID, the exact property, the dedicated secret, and one desired task.

During the exclusive VAY-1138 window, enable one task only for existing export
`f3429f38-b462-4453-b7f1-d901fc86ebfa`. Do not enqueue another export. Rollback
first sets `FINANCE_EXPORT_WORKER_ENABLED=false` and removes
`FINANCE_EXPORT_WORKER_EXPORT_ID`, then applies. A subsequent reviewed apply sets
`finance_export_worker_secret_mapped=false` and
`finance_export_worker_property_id=""`. Preserve the job, audit, and artifact
rows. No Financials activation, payment, reservation, backfill, or shared-fixture
mutation is authorized here.

The activation task must set both `FINANCE_EXPORT_WORKER_ENABLED=true` and
`FINANCE_EXPORT_WORKER_EXPORT_ID=f3429f38-b462-4453-b7f1-d901fc86ebfa`.
The deployment readiness guard rejects an enabled worker without that exact ID.
