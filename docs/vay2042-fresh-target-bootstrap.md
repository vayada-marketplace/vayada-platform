# VAY-2042 fresh target bootstrap core

Predecessor: source-reader core #261. Contract: VAY-2042 September 25 clarification,
`migration-rehearsal-fixed-release.md`, and product `backend-migration/README.md`.
The core adds no IAM, cloud execution, extraction or domain migration.

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

## Fixed target launcher (deployment remains separate)

`launch-vay2042-target.mjs` follows reviewed source launcher #266, but invokes
only the target core. Use `VAY2042_RUN_TARGET_MAIN=1`; the source enable flag
does not run this entrypoint. Its connect allowlist is the reviewed nine databases
for privilege inspection plus the one fixed fresh target, not arbitrary databases.
All restore/snapshot/resource, account/region, port, hostname, pinned-CA and private
server assertions match the source launcher. Supply its same identity/admin/TLS
`VAY2042_` environment fields, replacing `READER_SECRET_ARN` with
`WRITER_SECRET_ARN` for the exact new secret:
`vay2042/target-writer/vay2017-metadata-rehearsal-isolated-20260923-20260925`.

The destination must be empty and its ARN must include the AWS six-character
suffix. Only `{username,password,database}` for the fixed target/writer is stored.
Failures emit allowlisted stage/code/class only, including explicit unknown final
activation. Success still returns `bound: false`; it is not migration readiness.

Generate the standalone ESM with esbuild **0.28.0** using
`ESBUILD_BINARY=/path/to/esbuild node scripts/build-vay2042-target.mjs`; run again
with `--check` and `node --test scripts/test-vay2042-target-launcher.mjs`.
The generated artifact bundles reviewed local code; only Node builtins, `pg` and
the Secrets Manager SDK remain external. A separately reviewed target-specific
task/execution role, empty secret, IAM and protected runner must verify live AWS
restore/network/capacity and serialize with source bootstrap before execution.
Environment assertions and synthetic launcher tests are not live AWS attestation.
No resource application, bootstrap run, row extraction or proof binding is part
of this launcher change. Existing source/metadata roles and secrets are untouched.
