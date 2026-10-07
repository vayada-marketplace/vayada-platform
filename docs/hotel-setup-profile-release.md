# Hotel setup profile-edit release (VAY-965)

Intentional hotel-detail edits (`PUT /api/hotel-setup/properties/:id/profile`) are
forwarded by the public API to the private property-command service, which writes
only through the actor-bound `property_profile` login (`vayada_next_hotel_setup_profile_*`).
The application contract is `engineering/hotel-setup-profile-edit-writer.md` in the
application repository (PRs #2898–#2900). The parent role is pre-staged first; see
`hotel-setup-profile-parent-stage.md`.

## What this change stages

- `enable_hotel_setup_profile_credentials` (default `false`, set `true` in the
  checked-in tfvars) adds exactly
  `hotel-setup-command/prod/property/vayada_next_hotel_setup_profile_*` to the property
  task role's `GetSecretValue` read and to the protected property bootstrap role. Both
  use one shared list of exact per-purpose prefixes (property, logo when its storage is
  staged, profile when enabled). Creation, reader and execution reads are unchanged.
- Public caller purpose `profile` (`HOTEL_SETUP_PROFILE_COMMAND_*`) reuses the
  existing property origin `https://hotel-setup-property-command.vayada.com` and the
  property `internal-token` reference. It is `off` in the checked-in configuration;
  this change admits no caller. A configured profile caller requires property
  credentials, the property network and profile credentials; `enabled` additionally
  requires both staged property images (primary and rollback) in
  `deployment/hotel-setup-profile-images.json`.
- `deployment/hotel-setup-profile-images.json` is intentionally empty. Add immutable
  digest → source entries only after independent review and the application's native
  PostgreSQL 16/17 profile lifecycle proofs for that exact image.
- The protected bootstrap workflow accepts `operation=property_profile` with the exact
  property, organization and Owner actor. Every native property bootstrap now also
  requires the logo and profile callers to be exactly `blocked` or never released
  (no admission, origin or token).
- The protected release accepts `purpose=profile` (public only: `hold`, `blocked`,
  `enabled`). Enabling requires the existing property pair, a profile-proved public
  image, a stable, healthy property service whose image is profile-proved, a staged
  `vayada-hotel-setup-property-rollback` image that is also profile-proved, and the live
  property task policy reading the exact profile prefix. Any property service
  start/stop requires property admission blocked and logo/profile blocked or never
  released (no admission, origin or token).
- Prefer releasing `enabled` directly. A profile `hold` (or any installed profile
  admission) makes every later API image deployment require an image in the profile
  inventory, except the unchanged installed image.
- Retention: ordinary Terraform apply cannot remove or change an installed profile
  admission or origin/token pair, and API deployments cannot select an image outside
  the profile inventory while a profile caller is configured (except the unchanged
  installed image during an initial `hold`).

## Ordered release

1. Parent pre-staged (`hotel-setup-migration-scope.yml`, `scope=profile_0470`), then
   merge the application DB slice; startup applies 0470–0472.
2. Build and register the private primary, rollback and operational bootstrap images
   from the reviewed application source; deploy the private property-service primary.
   While logo stays enabled, the new private images must also be in the logo inventory
   and the new public image in the caller, split/ongoing-export and logo inventories.
3. Merge this change; normal Terraform plan/apply updates only the two IAM policies.
4. Protected pause: block property and logo admission, stop the property service, run
   `hotel-setup-property-bootstrap.yml` with `operation=property_profile` per original
   Owner and property, then restart the property service and re-enable callers.
5. Deploy web apps that send `Idempotency-Key` on profile edits.
6. After product sign-off on Owner-only editing, register the profile-proved images
   (public, and both `hotel_setup_property_image_digests` primary and rollback, which the
   Terraform precondition also checks), release `purpose=profile state=enabled` through
   `hotel-setup-release.yml`, then set `profile = "enabled"` in tfvars so ordinary apply
   retains it.

Rollback: release `purpose=profile state=blocked` (the pair is retained) before rolling
the private service back to an image without the profile route, then set
`profile = "blocked"` in tfvars; ordinary apply rejects any plan that differs from the
installed admission.
