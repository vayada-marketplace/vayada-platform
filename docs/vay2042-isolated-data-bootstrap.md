# VAY-2042 isolated data bootstrap

This slice prepares the dedicated source-row reader needed by the existing
extractor. It does not invoke the extractor, create a target, or run a migration.
Contract: VAY-2042's September 25 clarification and the VAY-605 coordinated
database migration model. Legacy remains the production authority.

`scripts/fixtures/vay2042-source-reader.json` is generated from the sanitized VAY-2043
artifact `eff705e7526160363618ad5550958d3a74ba066c77ffae2e15b366a16e2fb15e`:
only the restore identity, nine database names and four source table-name lists
are retained. It contains 83 exact relations, including six historical tables.
Changing this allowlist requires a newly reviewed inventory; no wildcard grants.

The bootstrap uses a new fixed role, initially NOLOGIN, and checks effective
privileges across every existing non-template database. It grants SELECT only
on the four source manifests, never changes existing PUBLIC/role permissions,
and rejects extra writes, reads, memberships, ownership and executable
application SECURITY DEFINER routines. Credentials expire after 24 hours and
are published only through the protected launcher's exact Secrets Manager
destination. LOGIN is enabled only after verification and secret persistence.

Failures before activation leave the new role disabled for inspection. A lost
final LOGIN acknowledgement returns `source_reader_activation_outcome_unknown`:
the fully verified role may be active. Stop and read back the exact role before
claiming its state; never automatically retry, rotate, or reuse an existing role.
No role/database drops or automatic cleanup are performed.
The existing metadata-reader role/secret and old target-named databases are
untouched. A fresh target-only writer, immutable source/run attestations and
source-drift checks remain required before extraction.

Deployment follows as a separate reviewed launcher/IAM slice. It must verify
the exact restored RDS resource and private network, use fingerprint-pinned RDS
TLS, expose no secret values/raw errors, and allow only the fixed bootstrap.
No production network, credential, data, owner grant or provider change is part
of either slice.

## Source-reader launcher (deployment still separate)

`scripts/launch-vay2042-source-reader.mjs` adapts the core to the existing pinned
Node image, without modifying the metadata login, task, role, or secret. It
requires `AWS_REGION=eu-west-1` and `VAY2042_` environment values for
`RESTORE_INSTANCE_ID`, `RESTORE_RESOURCE_ID`, `RESTORE_INSTANCE_ARN`,
`SOURCE_SNAPSHOT_ID`, `RESTORE_ATTESTATION_CHECKSUM`, `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD`, `RDS_CA_BUNDLE_GZIP`, and `READER_SECRET_ARN`.
Set `VAY2042_RUN_MAIN=1` only in the protected task. Identity values must match
the committed manifest/restore attestation; each TLS connection checks the
private server address and database before reaching the core.

The new destination name is exactly
`vay2042/source-reader/vay2017-metadata-rehearsal-isolated-20260923-20260925`.
Pass its full ARN from the companion resource (the AWS six-character suffix is
required). Task IAM needs `DescribeSecret` and `PutSecretValue` only on that
exact ARN; the launcher refuses a deleted, renamed, or populated destination.
The separate execution role supplies only this restore's managed admin secret.
Environment assertions are not live AWS attestation: the protected deployment
must independently verify resource `db-BB7GOFQ3BQTLTBG444I2Q75X6Y`, snapshot,
private network, pinned image, and exact IAM before a separately approved run.

Generate the committed standalone ESM using esbuild **0.28.0**:
`ESBUILD_BINARY=/path/to/esbuild node scripts/build-vay2042-source-reader.mjs`.
Use `--check` for reproducibility and run
`node --test scripts/test-vay2042-source-reader-launcher.mjs`.
The generated file bundles the core, SCRAM helper, and JSON manifest; only Node
builtins, `pg`, and `@aws-sdk/client-secrets-manager` remain external for the
existing image. Deploy it via `node --input-type=module -e <bundle>`; do not
pass unbundled relative imports to `node -e`. No launcher/IAM deployment or
cloud execution is authorized by these local checks.

This launcher alone does not make extraction runnable. The existing extractor
also requires attestor-owned snapshot/freeze evidence in each source database,
validated by its `databaseAttestation.ts` contract. A separately reviewed binding
must grant the reader SELECT on only that evidence table, bind the fresh target
and immutable run proofs, and avoid business-table writes or invented old IDs.
