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
