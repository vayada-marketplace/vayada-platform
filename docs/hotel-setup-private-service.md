# Hotel setup private service (VAY-1092)

## Staged credential infrastructure

`enable_hotel_setup_credential_infrastructure` defaults to false. When separately
approved, Terraform creates two empty Secrets Manager containers and two isolated
ECS roles. It creates no secret version, database login/grant, task, service,
public route, forwarding configuration or hotel change. Disabling the flag after
creation is not a rollback: secret containers have `prevent_destroy`.

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

## Deployment contract

Launch only the app's `start:hotel-setup-command` executable on port 8011. This
version supports currency PUT and Feature Hub module-list GET / Financials PATCH;
property creation is not implemented by this executable. Use dedicated
`HOTEL_SETUP_COMMAND_READER_DATABASE_URL`, `HOTEL_SETUP_COMMAND_INTERNAL_TOKEN`,
`HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT` (password-free),
`HOTEL_SETUP_COMMAND_SECRET_PREFIX=hotel-setup-command/prod/property/` and its own
WorkOS JWKS/issuer/audience settings. Do not inject general API/admin database URLs,
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

1. Review the composed app migrations through 0450, immutable image containing
   the private executable, and exact reader/native-login/function ownership.
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
`vayada-marketplace/vayada`; reader/audit drafts #2746 and #2747. No production
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
