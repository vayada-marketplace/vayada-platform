# Fixed logo parent pre-stage

> **Historical (retired by VAY-2056).** The private hotel-setup services, their caller wiring,
> Terraform, workflows, runner modes and image inventories described here were removed in the
> VAY-2056 decommission (steps 4 and 5). Commands and file paths below no longer exist on `main`;
> see `docs/environments.md` ("Hotel setup native services retired") for the current state.

Normal public API startup runs canonical `target:migrate:dist` under
`TARGET_DATABASE_MIGRATION_URL`, with the existing advisory lock, checksum ledger
and per-migration transactions. The existing protected main
`hotel-setup-migration-scope.yml` workflow gains `scope=logo_0466`; it never applies
migrations or writes the ledger. Its only mutation creates the absent fixed
`vayada_next_hotel_setup_logo_scope` NOLOGIN parent.

The compiled 0464, 0465 and 0466 source bytes are pinned. Actual native catalog
inspection must show `platform.hotel_setup_property_scopes` owned by
`vayada_target_prod_user`, with neither CREATEROLE nor superuser. The protected
admin must be exactly `vayada_admin`, NOSUPERUSER CREATEROLE. Exact successful
production 0464 ledger history is required. 0465 may be absent or exactly applied;
0466 may be absent or contain only exact CREATE ROLE permission failures. Later,
unknown, applied or mismatching transition histories fail closed. Existing
parents fail closed for inspection rather than adoption.

Before installing the logo artifact, the initial public logo hold retains the exact
installed caller-approved immutable image and requires an absent logo origin/token
pair. It only adds blocked admission; artifact changes and later blocked/enabled
logo releases still require the complete logo protocol inventory.

All three public callers must be explicitly blocked and both physical private
services stopped. The driver requires an active incompatible-frontend coordinated
hold capturing the exact stable public task. It rechecks the unchanged hold,
service counts, no RUNNING tasks and physically stopped retained tasks throughout
execution, stopping and deregistering its owned task on exit. Only the fixed
admin secret and pinned CA are injected; the task has no AWS role.

PostgreSQL 16/17 gives a non-superuser creator one incoming ADMIN membership,
granted by the bootstrap superuser. The module retains and verifies exactly
`vayada_admin`, ADMIN=true, INHERIT=false, SET=false, with a superuser grantor.
No other incoming/outgoing edges, login, inheritance, elevated role attributes or
role settings are accepted. No business grant is added. Lost COMMIT
acknowledgement emits inspection-required failure, never automatic adoption.

After staging, the reviewed primary public image starts with all callers
blocked; canonical startup applies 0465–0469. Verify actual ledger, native
schema-owner function ownership and final catalog inventory before credentials
are bootstrapped. Shared fingerprints require the same reviewed full-protocol
primary/rollback pair in both creation and property services, with compiled
proofs for existing creation purposes. Automatic provisioning stays disabled.

Local verification: `scripts/test_hotel_setup_creation_runner.py` and
`scripts/test_hotel_setup_logo_parent_native.mjs`. The native harness uses isolated
loopback PostgreSQL 16/17 clusters and a NOSUPERUSER CREATEROLE admin. It verifies
owner and ledger denials, safe parent posture and exact administrative edge,
existing-parent denial, unchanged ledger and a lost acknowledgement after an
actual COMMIT. This parent-stage proof is separate from the required complete
production-like non-superuser credential lifecycle proof.
