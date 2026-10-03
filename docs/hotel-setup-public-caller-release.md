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
3. Provision the creation reader/token and each canonical organization login
   through the guarded main-only bootstrap. Start and verify the creation
   service, then enable creation admission with the reviewed atomic public
   caller image through the protected release.
4. Test the original authenticated wizard for both reported accounts. First
   Save creates the canonical property and selected HotelOps initial launch
   settings atomically, then reloads status without a property-purpose command.
   Before successful creation there is no property UUID to provision. Ambiguous
   failures must retry the same payload/key, never create another property.
5. After successful Save provides the canonical property UUID, provision and
   prove its launch, currency_ready and FeatureHub credentials separately.
   Property service startup and admission require their separately reviewed
   reader/token, image and native purpose proofs. Prove later settings edits
   and first native currency creation of seven starter categories and Financials
   once, retaining Owner-off and global restrictions. Do not report recovery
   from POST success, health checks or provisioning receipts alone.

## Rollback without the ordinary Save writer

The reviewed creation primary source
`6f903db20554e38b522c848667875744fc673ed3` and rollback source
`e966028dfdaec63ff40dd75d043b800295071668` both support atomic initial launch
settings. Select only their inventoried immutable digests and verify the exact
public caller/private creation image pair. Creation/reader proof does not prove
property-purpose commands; retain the separately reviewed property image and
credential requirements.

Block affected admission before switching images, retaining its private
origin/token pair. Re-enable only after exact task stability, health and
compatibility checks. Never remove either pair to select an ordinary writer,
grant the ordinary API setup writes, or skip selected HotelOps initial settings.
Preserve same-key retry behavior across rollback and leave Owner acceptance
unconfirmed until authenticated Save and status reload succeed.


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

### Failed initial migration recovery

`restore_initial` restores only the pre-cutover API task captured by the protected
setup release hold. It requires the exact failed candidate, retained running
captured deployment, immutable split/ongoing-compatible captured image and an
unchanged active hold. Neither task may contain a private origin/token pair.
It preserves the hold and restores an existing task definition without registering
an image or changing credentials. This operation is unavailable after activation;
use the retained-pair blocked rollback contract then. Inspect the migration ledger
before attempting the failed release again.

The platform deploy identity may create/describe/tag only the fixed empty
reader/token containers before staging them; it receives no secret-value read
or native-prefix access. Container creation depends on that reviewed IAM policy.
Caller enable uses only DescribeSecret metadata to obtain an exact token ARN.
