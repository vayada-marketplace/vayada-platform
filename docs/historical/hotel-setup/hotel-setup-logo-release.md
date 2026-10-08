# Hotel setup logo release

> **Historical (retired by VAY-2056).** The private hotel-setup services, their caller wiring,
> Terraform, workflows, runner modes and image inventories described here were removed in the
> VAY-2056 decommission (steps 4 and 5). Commands and file paths below no longer exist on `main`;
> see `docs/environments.md` ("Hotel setup native services retired") for the current state.

Forwarding and storage remain disabled by default. No production input changes
are included here. `deployment/hotel-setup-logo-images.json` is intentionally
empty: add immutable digest → source SHA entries only after independent review
and full native PostgreSQL 16/17 lifecycle, recovery and existing-purpose proofs
for both primary and rollback images. The same full protocol is the supported
rollback; old images cannot admit logo requests.

Use the protected existing property bootstrap pause window: block property and
logo caller admission, stop and confirm physical private tasks stopped, provision
`property_logo` for the exact original Owner and existing property, and publish
only the immutable version proved by the application bootstrap. Automatic
provisioning remains disabled.

A clean full-root Terraform plan must precede apply. Stage reviewed primary and
rollback tasks with `enable_hotel_setup_logo_storage=true` and
`hotel_setup_logo_private_admission=enabled`; start the reviewed property task,
then release public purpose `logo`, state `enabled`. This reuses the existing
private property origin and internal token. Public logo state `blocked` retains
the token/origin and pending evidence while preserving other caller settings.

The private task receives GetObject/PutObject/DeleteObject only on staging/*,
private/media/* and public/media/* of the existing media bucket. Keys have no
property or purpose discriminator; native evidence and runtime key constructors
must bind each operation. There is no ListBucket, ACL, legacy-bucket or bucket
policy change, and ordinary API/native database permissions remain unchanged.

For cleanup after revocation, use the protected `hotel-setup-logo-cleanup`
workflow against one bound `upload_session` or `publication_job` UUID. Keep both
property and logo admission blocked and confirm all physical private executor
tasks stopped. The driver checks that gate before launch, during execution and
after completion. `plan` returns only a manifest hash and key count; `apply`
requires that exact hash and rejects drift. Its separate task role grants only
DeleteObject on the three reviewed key prefixes, with the existing helper-owner
URL injected by the execution role. It cannot read/write S3, publish credentials,
list the bucket or run a HTTP Owner bypass. Failed or uncertain cleanup requires
inspection; the runner never retries a mutating invocation.
