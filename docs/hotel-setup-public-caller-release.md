# Public API caller activation and rollback

This is the release contract for the existing public API's two private setup
forwarders. It does not activate either caller or service. The property native
bootstrap contract is in `hotel-setup-property-bootstrap.md`.

## Configuration boundary

Caller wiring is a separate, default-off change after private service staging.
Creation supplies only `HOTEL_SETUP_CREATION_COMMAND_ORIGIN` and
`HOTEL_SETUP_CREATION_COMMAND_INTERNAL_TOKEN`; property commands supply only
`HOTEL_SETUP_COMMAND_ORIGIN` and `HOTEL_SETUP_COMMAND_INTERNAL_TOKEN`.
Origins are fixed HTTPS endpoints from the reviewed two-service composition:
`https://hotel-setup-command.vayada.com` and
`https://hotel-setup-property-command.vayada.com`, respectively.

Each token references its existing service-specific Secrets Manager container.
Do not copy values into Terraform variables/state or SSM, print them, or expose
reader URLs, native database credentials, bootstrap admin credentials or native
secret prefixes to the public API. Add only exact token-read permission to the
public API's execution identity; retain the public task's current permissions.
Use the reviewed supplemental caller security groups only on that API service.
Do not widen database grants or attach private task security groups to it.

## Ordered activation

1. Require the public API's reviewed task definition and stable one-running-task
   deployment. Review the complete plan and preserve both private services'
   serving count/task selection. A missing service is not a staged service.
2. Complete migration 0462 and the final-source catalog/native credential checks.
   Verify both immutable image revisions and their compatible rollback behavior.
   Creation/reader image proof alone does not prove a property-purpose command.
3. Provision the creation reader/token and organization login through the guarded
   main-only release. Create or recover each canonical property UUID before
   manual property-purpose provisioning. Keep property tasks at zero and caller
   admission blocked during initial property bootstrap, as required by that
   contract. Prove launch, currency_ready and FeatureHub credentials separately.
4. Start and verify each private service using its separate reader, token, native
   credential prefix and image. Then enable its origin/token pair on the public
   API through the normal reviewed release. Compare the exact new public task
   definition and network change; never alter it with a manual ECS update.
5. Test the original authenticated wizard sequence for both reported accounts:
   create/recover, optional logo, launch settings, status reload and selection.
   A settings failure must retry the saved canonical property, not create another.
   Prove first native currency creates seven starter categories and Financials
   once, retaining Owner-off and global restrictions. Do not report recovery
   from POST success, static IAM, health checks or provisioning receipts alone.

## Rollback without the ordinary Save writer

The reviewed rollback source `7615180847bce85853127c9e117d8a7f60b1827a`
has the final 0462 contracts and creation/currency/FeatureHub handlers but no
launch-settings endpoint. It therefore cannot satisfy successful final Save.
Block launch admission for this rollback while preserving private forwarding
for the remaining reviewed commands. If the rollout relies on the absent
private endpoint to reject Save, verify that rejection through the public route.

Do not remove the property origin/token pair as a rollback shortcut: that
would select the ordinary launch-settings writer. Do not skip launch settings
in the wizard or compensate by granting the ordinary API write permissions.
A frozen caller must reject before any ordinary writer executes. Any public
application rollback must retain that behavior or have explicit admission
blocked before switching. Verify the exact public caller/private image pair
and status after rollback, and leave account recovery unconfirmed while Save
is blocked.


## Staged caller configuration

`hotel_setup_public_caller` has separate creation/property states. `off` preserves
pre-cutover configuration. `hold` injects only the admission marker for initial
bootstrap, without requiring an unpublished token. `enabled` injects the fixed
private origin and exact token reference; `blocked` retains that pair with the
hold. After activation, rollback uses `blocked`, never `off` or `hold`.

Configured callers use a dedicated public execution identity with the existing
ECS execution managed policy, the public task's existing exact SSM references
and only the configured internal-token container reads. No setup native or
reader references are added. The supplemental caller group attaches only to
next-target-backend. Terraform stages task definitions; the normal protected
release must select the reviewed definition/image and validate admission behavior.


## Protected release entrypoint

The main-only setup release workflow shares the production mutation queue and
protected environment. It checks the exact stable serving API task before each
change. Public release clones that task and preserves all unrelated environment,
secrets, task role, network and launcher settings, changing only the selected
setup caller pair/admission, its reviewed immutable image and execution identity.
The existing split-launcher image guard and coordinated ownership guard still
apply. `hold` is initial-only and refuses an existing pair; `blocked` retains it.
Enabled admission requires the corresponding private service stable and healthy.

Private start selects an explicit staged immutable task definition, its fixed
mode and independently reviewed image inventory, with the relevant public
admission blocked. The private service must exist at zero tasks for initial
start. Wait for stability and verify the exact selected task/count; failed
stability blocks release. Neither this entrypoint nor an image publication
provisions missing credentials or skips their native proofs.

The platform deploy identity may create/describe/tag only the fixed empty
reader/token containers before staging them; it receives no secret-value read
or native-prefix access. Container creation depends on that reviewed IAM policy.
Caller enable uses only DescribeSecret metadata to obtain an exact token ARN.
