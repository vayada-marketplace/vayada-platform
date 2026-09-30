# VAY-2042 isolated product rehearsal contract

This is the staging test of the saved September 20 legacy snapshot, not a live
hotel cutover. Legacy remains authoritative. [VAY-2042](https://linear.app/vayadacom/issue/VAY-2042/add-raw-snapshot-normalization-for-migration-rehearsal)
and `vayada/packages/backend-migration/README.md` own the migration contract.

## Source proof accepted for this test only

On September 30 the owner accepted a **fresh, matching 83-table comparison** of
the two private restores of the same immutable snapshot as sufficient
source-preservation evidence for this isolated test. The September 27 comparison
is a baseline, not the fresh proof. The new comparator report must name the
exact snapshot and both RDS resource IDs, all 83 reviewed tables, grouped row
counts and checksums, and query version, with zero mismatches. Bind that report
to the protected workflow, Step Functions/ECS task and image, and collection
time using their retained execution records; do not invent missing report fields.
Recheck source access and isolation immediately before extraction and verify the
source fingerprint and table checksums against that report afterward. Stop on
drift or unaccounted task/database access. The proof does **not** establish a
freeze of live production hotels or authorize their migration.

Before the CLI can read rows, separately review and approve a metadata-binding
transaction in **each** of the four restored source databases. The attestor,
not the reader, must own the trusted `vayada_migration_evidence` schema/table
and write `vayada.source_snapshot_identifier` and
`vayada.cutover_freeze_proof_sha256` for this exact snapshot/proof. Grant the
source reader only `USAGE` on that schema and `SELECT` on its attestation table;
verify ownership, values and direct CLI readback. Reject conflicting database
settings or attestations. This is a write to isolated restore metadata, not a
production freeze or permission to change customer rows.

## Existing product path

Run the packaged `packages/backend-migration/dist/cli/cutover.js rehearse-staging` once
on a fresh `vay1360-*` run. It already extracts attested raw `snapshot_rows` and
plans Identity, Catalog/media, Booking, PMS, Marketplace, Finance and parity.
Do not create normalized fixture tables or a second adapter for this path.
Use `--source-env staging --env staging` and the exact four snapshot tags;
derive the `vay1351-*` source ID only after the fresh proof is fixed.

The prepared input packet is **not executable**. A reviewed run file must bind
the source manifest, source and orchestration IDs, proof hashes, clean target
identity, candidate full Git SHA and image digest, media tuple, operator and
`STAGING_REHEARSAL:<run-id>:<source-run-id>` confirmation. Commit the non-secret
run file by PR and pin its commit and SHA-256 for both dispatch and resume;
changes require a new reviewed run. It contains no database passwords or
customer rows. Arbitrary workflow inputs must not replace it.

## One-off private task boundary

Use the existing isolated VPC, subnet, database security group and media task
role; no public IP, NAT, ECS Exec or production DB access. The new execution
role may inject only the exact versioned source-reader and target-writer
secrets, pull the reviewed ECR digest and write the task log. It may not inject
an RDS master or production credential. The source login is read-only on the
four old databases; the writer is confined to the fresh target database.
Connection URLs must name the fixed RDS hostname and database names and use
hostname-verified TLS with the pinned RDS CA. The task must fail before the CLI
if any run file, image/release, secret version, restore, media tuple or target
binding differs. Its log/report must not contain credentials or customer rows.

Prepare this task and its protected main-only workflow before renewing the
24-hour logins. Then renew only those existing logins with the already reviewed
private preflight, collect the fresh 83-table comparison, bind the source and
clean target to that exact run, and dispatch once. The separately approved
target attestor must bind and read back the existing five-key clean-target
evidence (`vayada.target_environment`, `vayada.target_identity_sha256`,
`vayada.target_clean_run_id`, `vayada.target_clean_proof_sha256`,
`vayada.target_application_release`) before dispatch;
`bound:false` from bootstrap is not sufficient. Do not rerun either bootstrap
or reuse an old target, run ID, media reservation or saved Terraform plan.
Each infrastructure apply and data/metadata operation needs its own reviewed
scope and approval.

The initial CLI can stop at `AWAITING_SMOKE` with exit 4 after GO parity; this
is incomplete, not an automatic retry. Review its sanitized parity and the
target-only smoke evidence, then resume the **same** immutable run. Provider
calls, live Channex activation, owner grants, booking pauses, production data
writes, cutover and legacy shutdown remain outside this rehearsal.
