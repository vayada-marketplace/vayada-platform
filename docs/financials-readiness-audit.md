# VAY-1138 Financials readiness audit

Run this only for the reviewed candidate property while its Financials module is
inactive:

```bash
bash scripts/run-target-database-runtime-preflight.sh \
  --audit-financials-readiness <property-uuid>
```

The runner requires one completed, stable next API deployment and pins its
observed running image digest in a temporary ECS task. It passes only the target
database URL, a pinned RDS CA, and the property
ID; removes the task role; and runs the application-owned readiness audit in a
repeatable-read, read-only transaction. It stops the task after at most five
minutes and deregisters the temporary definition. It does not activate a module,
seed categories, backfill projections, or create an export.

The result contains counts and finding codes without booking or guest rows.
`status: PASS` exits zero only when the audit is ready; `status: BLOCKED` prints
the finding counts and exits 2. The result includes the observed source task
definition and image digest. A blocked or failed audit is a
stop gate for property activation. Follow the application
`engineering/pms-financials-activation-runbook.md` for reconciliation and the
remaining acceptance gates.
