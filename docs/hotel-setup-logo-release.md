# Hotel setup logo release

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
