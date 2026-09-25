# VAY-2042 fresh target bootstrap core

Predecessor: source-reader core #261. Contract: VAY-2042 September 25 clarification,
`migration-rehearsal-fixed-release.md`, and product `backend-migration/README.md`.
This slice adds no launcher, IAM, cloud execution, extraction or domain migration.

Run the source-reader bootstrap first: this core adds a tenth database and refuses
any existing fixed writer or target. It creates only
`vay2042_target_rehearsal_20260925` from `template0`, administrator-owned, and
`vay2042_target_writer_20260925`. The writer may create/own migration schemas and
objects in that fresh target, but cannot create databases/roles, assume another
role, or read/write source or retained-target objects. Existing PUBLIC ACLs are
never changed to make checks pass. Unexpected effective privileges fail closed.

The dedicated `vayada_migration_attestor` is created only if absent; an existing
role must already meet the product NOLOGIN/non-inherited authority contract.
Only the new target receives its attestor-owned evidence schema/table. The writer
receives USAGE/SELECT, never CREATE there or attestor membership. The table stays
empty: a separately reviewed administrator step must bind the exact run, target
identity, clean proof, environment and release before migration. `bound: false`
is not a clean-target attestation or completed rehearsal.

The writer remains NOLOGIN through all ACL checks and credential persistence;
its SCRAM credential expires after 24 hours. Pre-activation failures retain the
disabled role and any partially created target for inspection. A lost final
LOGIN acknowledgement returns `target_writer_activation_outcome_unknown`; the
verified writer may be active. Stop and read back the exact objects. There are
no automatic retries, drops, credential rotations or reuse of partial targets.

The successor protected launcher must verify exact RDS restore/snapshot identity,
private network, capacity, pinned TLS and exact secret destination, sanitize
errors, and retain evidence. Source immutability checks and run binding are
separate gates; this core neither reads customer values nor claims parity.
