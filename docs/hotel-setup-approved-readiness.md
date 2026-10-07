# Offline readiness for the two approved legacy organizations

`hotel-setup-approved-readiness.yml` is a manual, protected main workflow in
`platform-mutations-v2` using the shared production mutation queue. It does not
stop or restart services, change caller admission, clear deployment holds, or
provision additional organizations or properties.

Before either task, both caller pairs must remain installed and blocked on the
exact reviewed stable public task. Its physical task, immutable approved image,
health, execution identity, origins and token references are checked. The public
startup must retain its canonical default or Finance CA launcher, media task role,
inherited image entrypoint, and no code mounts or injected startup controls. Both private
services must have zero desired, running and pending tasks; every bounded physical
RUNNING/STOPPED history entry must actually be STOPPED. These checks repeat during
both tasks and afterwards; task replacement or draining causes failure.

The separate `deployment/hotel-setup-approved-readiness-images.json` starts empty.
An admitted digest must map to exact `source`, `primarySource`, and `rollbackSource`
commit SHAs backed by packaged dual native proof. Online image approval does not
admit this operation.

`inspect` runs only the fixed packaged read-only inspection. `apply` first runs
that same inspection in this job, freezes the two approved role OIDs, existing
immutable secret versions and both reader OIDs, then injects that JSON into a
second fixed task. Receipt identity and fields must match the frozen inspection.
No external receipt, latest-version adoption, rotation, property credentials or
hotel facts are accepted.

Both tasks use the existing isolated database-preflight cluster/family, the
organization-bootstrap task role and property-bootstrap execution identity. Only
ECS injects the administrator SSM URL `/vayada/prod/db-marketplace-url`. The fixed launcher writes the pinned CA into an empty
runtime volume, unsets its source variable and executes the fixed `/app` CLI on a
read-only root. Native rollback proof uses the reviewed `/proof/rollback` artifact
inside the approved image.

Each pass has a three-minute deadline plus bounded log/cleanup reads. Lost RunTask
replies never retry; cleanup stops only the exact attempt/definition/tag task.
Failure logs retain sanitized task identifiers for inspection before another run.
Definitions remain retained without account-wide deregistration permissions.

`diagnose` runs only the same immutable inspection, using the same stopped-service
and blocked-caller gates. Its protected launcher records a query ordinal, bounded
row count, SQLSTATE and a SHA-256 fingerprint of the fixed SQL statement; it never prints queries, errors, credentials or results.
ROLLBACK cleanup cannot replace the failed check. `status: PASS` means the
diagnostic completed: consult `inspectionStatus` for the actual inspection result.
A diagnostic receipt cannot freeze identities or authorize an apply. No database
permissions or IAM permissions are added by this mode.
