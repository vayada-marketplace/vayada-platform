# VAY-1543 pricing command service: platform contract

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
and internal listener/discovery path. Use a dedicated security
group and a separate next API security group, since both currently use the
common ECS tasks group. Accept command traffic only from the next API group;
allow database access and the outbound HTTPS required for WorkOS JWKS and task
startup. Security groups cannot restrict HTTPS by hostname: without a reviewed
domain-aware egress control, broader internet HTTPS access is a residual risk
in either network option below. Do not add a public ALB rule, public DNS name,
shared writable volume, ECS Exec, or migration/owner credential. Reuse an
attested immutable `vayada-next-api` image containing
`apps/api/dist/pricingCommandServer.js`, and override its
normal next API launch command with that entry point. This avoids a second
image build without sharing the runtime credentials. Splitting the API security
group must preserve its existing ALB and database access.
The API-to-service path must use authenticated HTTPS; a private IP or security
group alone is not caller authentication. The service still verifies original
WorkOS bearer tokens for owner commands and independently checks authorization.

Read-only VPC inventory found only public subnets, no IPv6, and no NAT gateway
or VPC endpoints. On 2026-09-28 the human owner selected the public-IP pilot
topology, accepting its additional ingress-misconfiguration risk to avoid a
billable NAT gateway for this bounded test. This does not waive the required
database-enforced per-property scope, dedicated roles, token, HTTPS, or
negative reachability proof:

- **Selected public-subnet pilot task:** use an existing public subnet and
  `assign_public_ip=true` for direct HTTPS egress. This avoids the NAT charge
  but incurs a public-IPv4 charge and makes a mistaken ingress rule more
  consequential. Keep the service out of public ALB/DNS, use private-IP service
  discovery, and admit port 8010 only from the newly separated next API
  security group; never from an internet CIDR or the shared ECS group. Prove
  external reachability is denied and API-to-service HTTPS/token access works.
- **Deferred private-subnet alternative:** no public task IP; outbound internet
  access needs NAT or a separately designed equivalent. Draft
  [network PR #297](https://github.com/vayada-marketplace/vayada-platform/pull/297)
  proposed two private subnets and one zonal NAT. It is not the selected pilot
  path; its hourly/data charges and single-AZ egress failure point remain
  reasons to reconsider it only through a separate review.

AWS [VPC pricing](https://aws.amazon.com/vpc/pricing/) bills NAT by hour and
data volume, while public IPv4 is billed by address-hour. Review the
public-IP security-control impact before deploying the selected pilot:
[AWS Security Hub ECS.2](https://docs.aws.amazon.com/securityhub/latest/userguide/ecs-controls.html#ecs-2)
would fail for an ECS service with automatic public-IP assignment if that
control is enabled. This decision is not evidence of an active finding.

The first platform implementation may create the isolated resources with the
service stopped. Starting tasks or admitting requests requires the gates below.

### One-time empty-resource bootstrap gate

`infra/pricing_command_secrets.tf` declares five empty Secrets Manager
containers, one dedicated ECS execution role, and one exact-secret-read role
policy. It supplies no secret values and does not grant the ordinary platform
deploy role permission to create IAM roles or secrets. Keep that boundary; use
an authorized operator for this one-time Terraform bootstrap, not a permanent
CI permission expansion or manual AWS resource creation.

The 2026-09-29 hosted plan also includes an unrelated VAY-2017 preflight IAM
policy update. Do not apply that combined plan as a pricing bootstrap. Let its
owner resolve that change separately. The ordinary plan and deploy roles also
currently lack metadata-read permission on the new secret containers, and the
deploy role cannot refresh the new execution role/policy. First review and
install only the minimal metadata-refresh grants for those exact resources;
prove they do not grant secret values, resource creation, or role passing.
These grants are a separate approved change, not part of the seven-resource
bootstrap.

Then obtain a fresh full plan against current `main` and state. The pricing
bootstrap is eligible only if the saved plan contains exactly those seven
resource addresses as additions, with zero updates, replacements, or
deletions; do not use Terraform `-target` to manufacture that result.

Pause competing platform writers, review the exact plan and AWS identity, and
have the authorized operator apply that same saved plan under the existing
Terraform state lock. Keep the plan and its sensitive variable values out of
the repository, CI logs, and PR artifacts. If source, state, or plan changes,
discard it and review a new plan. Afterwards verify the five empty containers,
the role's trust and exact policy, unchanged shared-role secret access, and an
ordinary no-op plan before resuming writers. This bootstrap does not provision
database logins, populate secrets, launch the service, enable API routing, or
authorize the hotel smoke.

## Secret and database isolation

Do not place the four private service database URLs or the shared internal
token under the existing `/vayada/prod/*` SSM path. Today `infra/ssm.tf`
grants the common `ecsTaskExecutionRole` `ssm:GetParameter(s)` on that whole prefix and
`kms:Decrypt` on `*`; `infra/ecs.tf` assigns that execution role to ordinary
services. Merely omitting a secret from the ordinary API container definition
would not isolate it from another task using that role.

The live common execution role also has a separate `SecretsManagerAccess`
inline policy allowing `GetSecretValue` and `DescribeSecret` on
`arn:aws:secretsmanager:eu-west-1:269416271598:secret:vayada/*`. IAM simulation
allows a hypothetical `vayada/pricing-command/prod/...` secret and denies a
`pricing-command/prod/...` secret for that role. Therefore pricing secrets must
also stay outside the `vayada/*` Secrets Manager prefix. This is a naming
proposal and negative policy check, not evidence that any pricing secret exists.

Propose five `pricing-command/prod/` Secrets Manager names: identity-read,
owner-read, owner-manage, public, and internal-token. Use exact-ARN resources;
a separately reviewed provisioning step writes their values, not Terraform
state. The pricing task's
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
must expose no credentials or property details. ECS can check readiness inside
the container. Separately, the deployment gate needs a bounded authenticated
HTTPS probe through the next API security-group path before admitting traffic;
local container health or a TCP-open port does not prove that path works.
Draft [app PR #2656](https://github.com/vayada-marketplace/vayada/pull/2656)
adds startup/process readiness; it does not continuously recheck database or
WorkOS reachability.

Before starting the service, an exact-role PostgreSQL 16/17 preflight must
check login attributes, memberships, database-owned assignments, grants,
policies, every allowed command relation, denied direct writes on every
locked relation, denied cross-property writes, and unchanged ordinary API
privileges. Prove the real owner read/manage and public offer/no-payment quote
paths with their optional branches, transaction rollback, replay and
revocation. Compare the deployed task definition's image digest, source
ancestry, launch command, all five secret ARN mappings, IAM roles, private
ingress, selected subnet/public-IP posture, and fixed property/slug to the
reviewed plan. The application startup scope check is
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
isolated service while API routing remains off; deploy an API image with the
four fixed proxies through the current approved API lane (the six-service
receiver only after VAY-2029 activates batch ownership); then run the bounded
synthetic hotel smoke. The API must fail closed when service configuration,
readiness, or response is unavailable. It must not fall back to the general
target database, identity credential, or a different property login.

Rollback first restores the previously attested API task/image or disables
the proxy through its reviewed release control under the same lock. Preserve
the service hold and quote/authority evidence; restore its captured
task definition only through the pricing lane. Revoke or rotate new credentials
only after reviewing active tasks and retained evidence. Neither Terraform
destroy nor schema rollback is a traffic rollback.

## Decisions for the next implementation PRs

1. Implement the selected public-IP pilot behind a dedicated security group;
   test private-IP discovery, full transport encryption, authenticated probes,
   JWKS egress, and denied public ingress. Review the security-control impact
   and residual outbound HTTPS exposure before deploying.
2. Review the proposed `pricing-command/prod/` secret names, exact ARNs,
   dedicated execution-role policies, provisioning owner, rotation procedure,
   actual secret resource/KMS policies, and negative IAM proof for the final
   ARNs against all shared roles and both the common SSM and Secrets Manager
   wildcard policies.
3. Complete the database grants/RLS inventory and live preflight before
   introducing credentials or a running task.
4. Define the separate pricing deployment/hold record and its interaction with
   VAY-2029's active or legacy ownership mode before API proxy cutover.

These are review gates, not permission to apply infrastructure or run the
synthetic write smoke.
