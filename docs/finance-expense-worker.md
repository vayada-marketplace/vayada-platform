# Finance expense worker staged rollout (VAY-2044)

The app contract is `engineering/finance-expense-worker-runtime-permissions.md`.
The application owns migration 0409 and exports the exact table/column matrix
and policy-digest preflight in `apps/api/dist/jobs/financeExpenseWorkerBoundary.js`.
The platform runner imports that module from the running immutable app image;
it must be present in the reviewed image before the grant/preflight modes run.
The general API runtime preflight is unchanged.

Nothing in this PR runs provisioning, maps a secret by default, or enables a
worker. Financials remains inactive. These commands are staged for a separately
approved rollout, not authorization to execute them now:

```sh
python3 scripts/create-target-database-identity-secret.py --finance-expense --check
python3 scripts/create-target-database-identity-secret.py --finance-expense --create
bash scripts/run-target-database-runtime-preflight.sh --provision-finance-expense-worker
bash scripts/run-target-database-runtime-preflight.sh --grant-finance-expense-worker <reviewed-property-uuid>
bash scripts/run-target-database-runtime-preflight.sh --preflight-finance-expense-worker <reviewed-property-uuid>
bash scripts/run-target-database-runtime-preflight.sh preflight
```

Secret preparation reuses the identity provisioner's guarded SSM flow but stores
`/vayada/prod/target-database-finance-expense-worker-url` with the distinct
`vayada_next_finance_expense_worker` login. Existing secrets are never replaced.
The provisioner rejects unsafe database ACLs and existing roles, creates no
memberships or ownership, and checks the actual login without logging passwords.
Only the one-shot provision task receives the admin credential; only the grant
task receives the migration credential. Neither reaches the long-lived worker.
The grant transaction refuses drift and any different existing property scope;
it can add only the explicitly supplied property to the owner-managed allowlist.

After both preflights pass, review Terraform with
`finance_expense_worker_secret_mapped=true` and the same
`finance_expense_worker_property_id`. Apply only through normal reviewed
platform deployment. The task environment still has
`FINANCE_EXPENSE_WORKER_ENABLED=false`. Verify the actual ECS task secret mapping,
immutable app digest and source SHA; an independently supplied URL is insufficient.
Do not reuse Channex's worker credential or property permissions.

VAY-1138 owns the exclusive bounded test-window approval and any subsequent
reviewed enablement. The app checks role/session identity, effective table and
column grants, ownership/memberships, DDL, sequences, callable definers, exact
RLS policy digest and configured single-property scope before starting its loop.
Keep startup/preflight evidence with the immutable task revision.

Rollback disables the worker flag before removing its secret mapping. Preserve
all source/ledger data. Never fall back to general API or migration-owner URLs.
No payment, reservation, backfill, entitlement activation or unrelated outbox
consumer repair is authorized by this rollout.
