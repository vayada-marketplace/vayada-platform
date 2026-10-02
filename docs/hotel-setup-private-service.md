# Hotel setup private service (VAY-1092)

## Staged credential infrastructure

`enable_hotel_setup_credential_infrastructure` defaults to false. When separately
approved, Terraform creates two empty Secrets Manager containers and two isolated
ECS roles. It creates no secret version, database login/grant, task, service,
public route, forwarding configuration or hotel change. Disabling the flag after
creation is not a rollback: secret containers have `prevent_destroy`.

The following credential table describes `property_commands` only. Creation
uses its separate reader/token containers and organization prefix shown below.

| Consumer | Secret name | Required contents |
| --- | --- | --- |
| Private ECS execution role | `hotel-setup-command/prod/reader-database-url` | URL for `vayada_next_hotel_setup_reader`, >=32-byte password, TLS verify-full |
| Private ECS execution role | `hotel-setup-command/prod/internal-token` | Random >=32-byte internal authentication token |
| Private ECS task role | `hotel-setup-command/prod/property/<database_login>` | Exactly `{username,password}` for the database-selected native property login |

Terraform never receives passwords or tokens. Execution reads only the two exact
container ARNs. The application task can only `GetSecretValue` for native property
logins under the fixed property prefix; it cannot read the reader URL/internal
token from Secrets Manager, write/rotate secrets or read unrelated credentials.
The service receives its reader and token through ECS secret injection. Native
purpose selection comes from the current database assignment, not secret naming.
The credential flag alone attaches these roles to no task; deployment roles
receive no PassRole permission here. Separately gated service staging adds
ECR/logging execution permissions only to the execution role, not the application
task role.

The offline credential test renders the shared read-policy template and fixed
Terraform names. It models the generated execution-secret ARN suffix and checks
that both read policies exclude `hotel-setup-command/prod/reader-candidate/`
containers and grant only `GetSecretValue` in both `property_commands` and
`property_creation` modes. Execution reads stay pinned to the two exact injected
container ARNs for the selected mode. This is source/template evidence, not a live
IAM simulation: review all attached policies, resource policies and effective
live access before publishing credentials or launching the service.

## Deployment contract

### Composed creation and Financials release

The complete new-hotel flow needs two services at the same time. The public API
already accepts separate creation and property-command origins/tokens. A single
`hotel_setup_command_mode` switch on the current singleton Terraform resources
does not deploy both. Do not change a serving service's mode or combine its
privileged adapters to cover this gap.

Reserve the current `vayada-hotel-setup-service`, task families,
`vayada-hotel-setup-execution` / `vayada-hotel-setup-task`, and
`hotel-setup-command.vayada.com` for the creation release, selecting
`property_creation` explicitly in its reviewed plan. Stage the Financials
property-command service under separate identities:

| Boundary | Creation | Property commands |
| --- | --- | --- |
| Service | `vayada-hotel-setup-service` | `vayada-hotel-setup-property-service` |
| Primary / rollback task families | `vayada-hotel-setup-primary` / `vayada-hotel-setup-rollback` | `vayada-hotel-setup-property-primary` / `vayada-hotel-setup-property-rollback` |
| Execution / task roles | Current creation roles above | `vayada-hotel-setup-property-execution` / `vayada-hotel-setup-property-task` |
| Private HTTPS host | `hotel-setup-command.vayada.com` | `hotel-setup-property-command.vayada.com` |
| Executable mode | `property_creation` | `property_commands` |
| Injected reader / token names | `hotel-setup-creation/prod/*` exact reader/token ARNs | `hotel-setup-command/prod/*` exact reader/token ARNs |
| Native secret read prefix | `hotel-setup-command/prod/organization/` | `hotel-setup-command/prod/property/` |
| Ordinary API origin / token | `HOTEL_SETUP_CREATION_COMMAND_ORIGIN` / `HOTEL_SETUP_CREATION_COMMAND_INTERNAL_TOKEN` | `HOTEL_SETUP_COMMAND_ORIGIN` / `HOTEL_SETUP_COMMAND_INTERNAL_TOKEN` |

An implementation may reuse the internal ALB and reviewed wildcard certificate
with two fixed host rules. Each host needs its own target group and task security
group, immutable primary/rollback tasks, internal token, reader and task IAM.
Neither service may read the other's injected credentials or native secrets.
Ingress remains limited to the ordinary API caller group; both destinations
verify the original WorkOS session and current database authorization themselves.
Independent default-off staging and release ownership must prevent a creation
apply from resetting or replacing an activated property-command service, or vice
versa. Review the exact rollback for each service; stopping either leaves its
affected writes blocked, without falling back to ordinary API credentials.

The creation owner retains its existing creation reader/organization bootstrap
and owns the creation-specific release/caller/rollback implementation. The
Financials owner owns property-reader lifecycle and this shared composition
contract. This document does not implement the two-service Terraform resources;
agree that implementation's owner before adding another deployment slice.

Acceptance must cover the actual wizard Save: property creation, optional logo,
launch-settings save, status reload, and subsequent native PMS first-currency
completion. The current launch-settings PUT still uses the ordinary booking
settings repository; its default currency is not the PMS completion command.
Prove a reviewed narrow write boundary for that save and the connection to
first-currency completion before claiming the full flow is ready. Do not grant
broad ordinary API writes, skip the save, or treat successful POST creation as
complete onboarding. The first native currency transaction must create the seven
starter categories and enable Financials once; replay and later edits must
preserve Owner-off and base/billing/global restrictions.

All existing live-authority, exact credential/catalog/IAM, migration-history,
image/rollback, clean enabled-service Plan and authenticated acceptance gates
remain. No service activation or live provisioning is approved by this contract.

Launch the app's `start:hotel-setup-command` executable on port 8011 for each
service. For `HOTEL_SETUP_COMMAND_MODE=property_commands`, it supports currency
PUT and Feature Hub module-list GET / Financials PATCH. Use dedicated
`HOTEL_SETUP_COMMAND_READER_DATABASE_URL`, `HOTEL_SETUP_COMMAND_INTERNAL_TOKEN`,
`HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT` (password-free),
`HOTEL_SETUP_COMMAND_SECRET_PREFIX=hotel-setup-command/prod/property/` and its own
WorkOS JWKS/issuer/audience settings. For `property_creation`, select that mode
explicitly, inject the separate creation reader and token, and use
`HOTEL_SETUP_COMMAND_SECRET_PREFIX=hotel-setup-command/prod/organization/`; follow
the creation reader/bootstrap contract below. Do not inject general API/admin database URLs,
provider credentials, unrelated task policies or secret-write permissions.

Use an internal HTTPS listener with certificate verification and a dedicated
caller security group attached only to the ordinary next API. Do not reuse the
public ALB, route through Cloudflare, permit shared ECS security-group ingress,
or allow direct internet ingress. TLS termination forwards to the private task's
8011 port through its own security group. Restrict task egress to RDS and HTTPS
for WorkOS JWKS / AWS APIs. The network/TLS resources are a separate reviewed
slice; this credential change cannot start a service. Configure no API forwarding
until the private service's authenticated preflights pass.

## Credential and release gates

1. Review the exact composed app source and migration manifest (currently through
   0461), immutable image containing the private executable, and exact
   reader/native-login/function ownership. Verify actual migration history before
   replacing any superseded source migration; do not rewrite applied history.
   A separate provisioner must satisfy the app's credential-lifecycle contract:
   no arbitrary role adoption/retargeting, exact purpose/owner assignment,
   positive and cross-hotel denial proof, rotation and ownership-transfer proof.
   Do not run the existing scope-role script as if it provisioned these logins.
2. Review a clean platform plan for only the four staged resources plus inline
   policies. Populate values outside Terraform using the separately authorized
   provisioner. Run actual reader ACL/RLS/audit and native purpose preflights on
   PG16/17 and the exact live credentials; names or ECS 1/1 are not proof.
3. Review dedicated task/execution IAM, internal TLS/network, exact image and
   rollback task definitions, and exclusive release ownership. Never roll back
   the private service to an ordinary API executable or broad database login.
4. After approval, start the private service and verify authenticated readiness.
   Then separately wire the ordinary API's fixed HTTPS origin and matching token.
   Block the affected command routes before removing forwarding; otherwise the
   optional forwarding configuration restores the legacy local write path. Drain
   private commands before retiring logins. Keep those routes blocked until a
   reviewed private replacement is ready; do not fall back to broad credentials.
5. Run one approved synthetic-hotel first-currency/default-category/Owner off-on
   check. Off preserves data. Existing hotels use their separate rollout.

App contract: `engineering/hotel-setup-command-credential-lifecycle.md` in
`vayada-marketplace/vayada`; reader/audit drafts #2746/#2747 and native/compiled
credential checks #2752/#2757 and completion-scope correction #2761. No production
release, provisioning or property activation is authorized by this document.

## Staged private connection

`enable_hotel_setup_private_network=false` creates no network resources. The
separate opt-in network slice stages an internal ALB with the existing wildcard
certificate and a VPC-only, host-specific DNS zone. HTTPS enters only from the
new supplemental `caller` security group; port 8011 enters only from the ALB.
No shared ECS group or public ALB can reach the task. The caller group remains
unattached: attaching it to the exact next API service is a later cutover.

The ALB's unauthenticated `/` probe expects 401, proving only that the listener
started after its database startup guards. It is not authenticated readiness,
native-credential proof or hotel acceptance. No tokens appear in health checks.
The public subnet IDs do not make an internal ALB internet-facing. Task HTTPS
egress remains internet-wide because security groups cannot restrict the WorkOS
hostname; runtime IAM and TLS still apply. No task or API forwarding is created
by the network slice.

## Staged service and rollback definitions

`enable_hotel_setup_service_staging=false` registers nothing. When separately
approved, staging requires both credential/network flags and reviewed primary
and rollback digests. `deployment/hotel-setup-command-images.json` maps each
reviewed digest to its exact 40-character source commit; it is intentionally
empty until the composed private executable is built and verified. An ordinary
API image is not a valid attestation. Both task definitions use the same private
entrypoint, environment and restricted roles; no broad-credential fallback.

The staged ECS service has desired count zero and ECS Exec disabled. It starts
no worker, scheduler or migration. The existing public-subnet pilot uses a task
public IP for WorkOS/AWS egress, with no internet inbound SG rule. The task is
read-only except an ephemeral CA directory. Its startup shell writes the public
reviewed RDS CA with mode0600 and Node adds that CA without disabling TLS or
hostname verification. It uses the image's default root user for this write;
no privileged container/host mount is enabled. Review live RDS CA compatibility.

Current CI receives no new PassRole permission and no workflow deploys this
service. Exact staged-role PassRole and a reviewed private release workflow are
additional gates. Activating desired count and API forwarding requires a later
approved change; do not apply this zero-count staging configuration over an
activated service. Automated circuit rollback uses ECS's last completed service
deployment, not the separately registered rollback family. A future release must
select and verify that exact rollback task explicitly before activation.


## Creation-only staged runtime

Set `hotel_setup_command_mode=property_creation` for the reviewed creation image.
The executable receives that fixed mode and constructs no currency or Feature Hub
adapter. The execution role reads only the separately named
`hotel-setup-creation/prod/reader-database-url` and
`hotel-setup-creation/prod/internal-token` secret containers. The reader URL must
use `vayada_next_hotel_setup_creation_reader`; the app rejects the property reader.
The task role reads only organization secrets below
`hotel-setup-command/prod/organization/vayada_next_hotel_setup_org_` and cannot
read property-command, ordinary API, owner or migration credentials.

This reuses the disabled private deployment contract. Default mode remains
`property_commands`, all infrastructure flags remain false and staged capacity
remains zero. No secret value, role grant, approved image, public API forwarding
or deployment is introduced here. Native creation and creation-reader release
preflights, isolated credential provisioning and normal CI release/rollback
remain activation gates. A mode change after staging can replace protected secret
containers and requires its own clean Terraform plan; do not use it as a live
service-purpose switch.


## Organization credential bootstrap

`provision-hotel-setup-creation-login.mjs` is an operational one-off task, never
a private service entrypoint. Run only in an approved composed application image:
it imports that image's exact creation grant inventory and native release check.
The fixed admin secret references the known RDS admin on `/postgres`; the client
uses the reviewed CA with verified TLS and the fixed target database. Supply only
the organization's and current owner's UUIDs. Existing organization assignments
are rejected; roles and passwords are never adopted or silently rotated.

The script creates a fresh native login, exact column grants and organization
assignment, writes and rereads its two-field vault credential, then independently
proves the native connection and current owner. It saves no hotel or business
audit. A failure disables only the newly created role, removes its assignment and
terminates its sessions; this also covers a lost COMMIT acknowledgement. A
`hotel_setup_creation_provision_cleanup_required` receipt blocks release until
that named role is verified disabled. Failed secret values can remain orphaned,
but are not selected by any organization registry entry.

The separately staged bootstrap IAM role can create/read/write only native
organization secrets. It cannot access reader/token, ordinary API, owner or
migration secret values. The one-off execution role injects the exact operational
admin secret; never attach the bootstrap role or admin secret to the service.
Production caller wiring and private-service release remain separate gates.
The local fixture requires the owned disposable creation database and a memory
vault; it does not connect to AWS. It proves failed owner checks, duplicate
assignment rejection, lost COMMIT cleanup and unchanged hotel/audit counts.


## Creation reader bootstrap

The same operational script supports the explicit purpose `creation_reader`.
It creates only `vayada_next_hotel_setup_creation_reader`, with the exact reader
columns and rejection-only audit inserts. The login has no parent membership or
organization assignment. Its real TLS/reader/database-isolation preflight must
pass before literal URL and random internal-token strings are published to the
two pre-created creation secret containers. JSON quoting is not added to injected
secret values. Existing secret versions or an existing reader role are rejected,
never overwritten or adopted.

Use the separate creation-reader bootstrap IAM role: Get/Put on those exact two
secret ARNs only, with no native organization-secret access. Partial publication
fails release and disables the new login; orphaned versions need explicit
operational cleanup before retry. The native organization bootstrap role remains
separate. Local fault injection proves partial token publication disables the
reader, an existing secret blocks creation, and an existing reader stays intact.
No task caller or service is enabled by this slice.


### Creation credential bootstrap

The main-only `hotel-setup-creation-bootstrap.yml` workflow provisions either the
isolated reader or one organization's native login. It requires the reviewed
public task definition to remain stable and the private service to exist with
zero desired, running, and pending tasks. The immutable image must be in
`deployment/hotel-setup-command-images.json`; an unlisted digest is rejected
before any AWS call. Reader runs reject organization/actor inputs.

The existing ephemeral-task runner replaces inherited serving credentials and
task permissions with one operational admin secret and the exact purpose's
bootstrap IAM role. It clears serving environment and ports, uses the approved
image digest and pinned RDS CA, then stops its task and deregisters its temporary
definition. It never updates an ECS service. The bootstrap role is not attached
to the private service. A failure or cleanup-required report blocks activation;
do not retry blindly or substitute serving/migration credentials.

Run `python3 scripts/test_hotel_setup_creation_runner.py` to exercise both modes
and input rejection with an AWS stub. This check also measures the actual ECS
override size and verifies credential replacement and owned-task cleanup.
