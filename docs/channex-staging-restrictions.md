# VAY-1528 isolated Channex staging

Requires the application scoped-restrictions worker change before deployment.
Use deploy.yml with next-maps-canary, environment next, the reviewed immutable
image SHA and channex_staging=true. This preserves existing routes and adds only
the reusable synthetic property's Channex path. Guest activation stays separate.
All background workers remain off; the application enables only restrictions-only
Channex jobs for property 65f6b2fc-c783-4963-9d6b-a85f82319769. All other Channex
capabilities remain observe_only. Ordinary subsequent deploys fail closed until
channex_staging is explicitly retained.

The existing Bitwarden property-scoped key must be transferred through a trusted
local process to SecureString /vayada/staging/next-channex-test-api-key. Never
pass the key in shell arguments or logs. The secret value stays outside Terraform
and GitHub; Terraform adds only its exact ARN to the ECS execution role allowlist.
Verify the key returns only sandbox 8f4c1e47-3de1-4150-8bde-ad031a013842 at
https://staging.channex.io before transferring. Deploy CI inspects metadata only.

Before enabling ARI, audit and bind the existing sandbox and mappings with bounded
synthetic fixture changes; do not create another provider property. Preserve all
shared reservations, availability, rates, and channel stop-sell. Verify exact ECS
image digest, property-scoped configuration, owner API queue/worker completion and
provider restriction readback, then restore test rules. Booking.com channel and
downstream OTA evidence are separate from provider API delivery.
