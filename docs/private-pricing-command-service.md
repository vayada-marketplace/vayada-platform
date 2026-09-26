# VAY-1543 private pricing command service: platform contract

Status: review proposal only. No resources, credentials, database grants, API
routing, or deployment are created by this document. Initial admission is the
existing synthetic hotel only. The [application command contract](https://github.com/vayada-marketplace/vayada/blob/main/engineering/pricing-command-service-contract.md)
defines the four fixed operations and their authorization boundary; this
document defines the platform prerequisites for running that service.

## Current boundary and topology

The merged application entry point, `apps/api/src/pricingCommandServer.ts`,
starts separately from `server.ts` on port 8010. It requires one identity-read
database URL, three distinct property-bound operation URLs, an internal caller
token, fixed property ID and canonical slug, and WorkOS verifier
settings. It checks each operation login's database-owned assignment at
startup. It does not yet have API proxy routing or a health endpoint.

Provision a separate ECS service/task, log group, task role, execution role,
and private listener/discovery path. Use a dedicated security
group and a separate next API security group, since both currently use the
common ECS tasks group. Accept command traffic only from the next API group;
allow outbound database, WorkOS JWKS, and required AWS endpoints only. Do not add a
public ALB rule, public DNS name, public IP, shared writable volume, ECS Exec,
or migration/owner credential. Reuse an attested immutable `vayada-next-api`
image containing `apps/api/dist/pricingCommandServer.js`, and override its
normal next API launch command with that entry point. This avoids a second
image build without sharing the runtime credentials. Splitting the API security
group must preserve its existing ALB and database access.
The API-to-service path must use authenticated HTTPS; a private IP or security
group alone is not caller authentication. The service still verifies original
WorkOS bearer tokens for owner commands and independently checks authorization.

The first platform implementation may create the isolated resources with the
service stopped. Starting tasks or admitting requests requires the gates below.

## Secret and database isolation

Do not place the four private service database URLs or the shared internal
token under the existing `/vayada/prod/*` SSM path. Today `infra/ssm.tf`
grants the common `ecsTaskExecutionRole` `ssm:GetParameter(s)` on that whole prefix and
`kms:Decrypt` on `*`; `infra/ecs.tf` assigns that execution role to ordinary
services. Merely omitting a secret from the ordinary API container definition
would not isolate it from another task using that role.

Use exact-ARN Secrets Manager resources, with values written by a separate
reviewed provisioning step rather than Terraform state. The pricing task's
dedicated execution role reads only its four database URLs and internal token;
the next API needs its own execution role reading only its current required
SSM parameters and that internal token. Neither the API execution role nor its
task role may read the four pricing URLs. No other task/execution role may read
the token or pricing URLs. If customer-managed KMS keys are used, scope decrypt
to those keys and secret encryption contexts; do not inherit the common
wildcard policy. The application task roles need no secret-read API grant.

Provision separate native PostgreSQL logins for identity read, owner read,
owner manage, and public quote/offer execution. Bind each operation login to
the exact synthetic property, organization, and operation class in
`platform.pricing_runtime_property_scopes`. Keep every operation login
non-owner, `NOINHERIT`, `NOBYPASSRLS`, and without role membership. Grant the
fixed relation set required by the four command paths, including row-lock
privileges, only after database-enforced write denial covers every locked
relation. The existing pricing migrations establish scope policies and a
partial lock-only boundary; they do not provision these logins or complete the
full ACL matrix. Identity read must be unable to execute pricing writes.

## Readiness and proof before traffic

Add a private, token-protected readiness endpoint to the application service.
It should report ready only after startup login-scope checks have passed; it
must expose no credentials or property details. ECS and the deployment runner
need a bounded authenticated probe from inside the private network. A running
container or TCP-open port is insufficient proof.

Before starting the service, an exact-role PostgreSQL 16/17 preflight must
check login attributes, memberships, database-owned assignments, grants,
policies, every allowed command relation, denied direct writes on every
locked relation, denied cross-property writes, and unchanged ordinary API
privileges. Prove the real owner read/manage and public offer/no-payment quote
paths with their optional branches, transaction rollback, replay and
revocation. Compare the deployed task definition's image digest, source
ancestry, launch command, all five secret ARN mappings, IAM roles, private
ingress, and fixed property/slug to the reviewed plan. The application startup scope check is
necessary but does not replace this platform preflight.

## Deployment order and rollback

[VAY-2029's six-service v1 manifest](../deployment/coordinated-release-v1.json)
names the next API and five frontends. Its receiver workflow and IAM also
allowlist those six. Keep the pricing service outside that v1 manifest. A
separate, explicitly reviewed deployment lane must share the
`production-ecs-mutations` lock, pin a reviewed digest, capture the previous
task definition, verify readiness, and retain a durable hold on uncertain or
failed rollout. Reusing the ordinary per-image dispatch without those checks
is not an approved release path.

Sequence: provision and prove database roles/secrets; deploy and attest the
private service while API routing remains off; deploy an API image with the
four fixed proxies through the current approved API lane (the six-service
receiver only after VAY-2029 activates batch ownership); then run the bounded
synthetic hotel smoke. The API must fail closed when service configuration,
readiness, or response is unavailable. It must not fall back to the general
target database, identity credential, or a different property login.

Rollback first restores the previously attested API task/image or disables
the proxy through its reviewed release control under the same lock. Preserve
the private service hold and quote/authority evidence; restore its captured
task definition only through the pricing lane. Revoke or rotate new credentials
only after reviewing active tasks and retained evidence. Neither Terraform
destroy nor schema rollback is a traffic rollback.

## Decisions for the next implementation PRs

1. Select and test private discovery and full transport encryption, including
   how authenticated probes reach the service and how JWKS egress works without
   a public task IP.
2. Review the exact Secrets Manager ARNs, dedicated execution-role policies,
   provisioning owner, rotation procedure, and negative IAM proof.
3. Complete the database grants/RLS inventory and live preflight before
   introducing credentials or a running task.
4. Define the separate pricing deployment/hold record and its interaction with
   VAY-2029's active or legacy ownership mode before API proxy cutover.

These are review gates, not permission to apply infrastructure or run the
synthetic write smoke.
