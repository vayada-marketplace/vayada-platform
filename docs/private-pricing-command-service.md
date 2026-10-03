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

Terraform declares the isolated empty resources, but the 2026-09-29 live
read-only check found none created. Starting tasks or admitting requests
requires the gates below.

### One-time empty-resource bootstrap gate

`infra/pricing_command_secrets.tf` declares five empty Secrets Manager
containers, one dedicated ECS execution role, and one exact-secret-read role
policy. It supplies no secret values and does not grant the ordinary platform
deploy role permission to create IAM roles or secrets. Keep that boundary; use
an authorized operator for this one-time Terraform bootstrap, not a permanent
CI permission expansion or manual AWS resource creation.

The 2026-09-29 hosted plan included an unrelated VAY-2017 IAM update. That
historical combined plan remains unusable; do not treat it as a current blocker
without fresh evidence. Obtain a fresh full plan against current `main` and
state. The pricing bootstrap is eligible only if the saved
plan contains exactly those seven resource addresses as additions, with zero
updates, replacements, or deletions; do not use Terraform `-target` to
manufacture that result.
The addresses are `aws_iam_role.pricing_command_execution`,
`aws_iam_role_policy.pricing_command_secrets`, and
`aws_secretsmanager_secret.pricing_command` for the five keys
`identity_read`, `owner_read`, `owner_manage`, `public`, and `internal_token`.

Pause competing platform writers, review the exact plan and AWS identity, and
have the authorized operator apply that same saved plan under the existing
Terraform state lock. Keep the plan and its sensitive variable values out of
the repository, CI logs, and PR artifacts. If source, state, or plan changes,
discard it and review a new plan. Verify the five empty containers, the role's
trust and exact policy, and unchanged shared-role secret access.

Keep writers paused: the ordinary plan and deploy roles currently cannot
refresh the new secret containers, and the deploy role cannot refresh the new
execution role/policy. In a separate reviewed configuration change, grant
only exact-resource metadata refresh to those roles; prove it does not grant
secret values, resource creation, or role passing. The authorized operator
must apply its own fresh full saved plan with no unrelated changes. Resume
ordinary writers only after their hosted plan refreshes to no-op. Neither
phase provisions database logins, populates secrets, launches the service,
enables API routing, or authorizes the hotel smoke.

### Proposed hosted operator execution — not approved or implemented

[Draft #343](https://github.com/vayada-marketplace/vayada-platform/pull/343)
prepares and discards a guarded plan using existing GitHub production settings.
It cannot apply and does not solve local operator input loading. Recommend a
separate temporary hosted operator identity, rather than exporting inputs or
expanding the ordinary deployment role. This proposal changes no IAM, GitHub
environment, workflow, state or production resource.

The identity prerequisite must have its own reviewed operator configuration
and saved plan, using non-secret IAM/backend metadata only. Do not add it to the
seven-resource root bootstrap plan or let it provision itself. Its main-only
GitHub environment/OIDC admission, fixed audience, approved human operators,
explicit expiry and session revocation require separate approval and proof.
Normal CI role trust, grants and VAY-2029 cutoff stay unchanged.

Candidate privileges for the **creation phase only**:

- Enumerated provider refresh from the existing plan-policy template, not a
  clone of the broad deployment role. This still exposes sensitive Terraform
  state/SSM configuration; treat the operator job as privileged.
- State read/write only on the existing exact production state object, and
  existing lock-table metadata/leading-key bookkeeping; no other object writes.
- `secretsmanager:CreateSecret` for the five fixed names, with their exact
  name conditions, region/account and required tags. The ARN suffix is unknown
  before creation; use only each fixed name plus its six-character suffix, not
  `pricing-command/*`. Grant tagging and scoped metadata/version inventory
  only where needed by the pinned provider and empty-container verification.
- `iam:CreateRole` and `iam:PutRolePolicy` only on
  `arn:aws:iam::269416271598:role/vayada-pricing-command-execution`, plus its
  enumerated refresh reads. No other role/policy writes, PassRole, role
  assumption, service/task mutation, secret-value reads, subsequent value
  writes, resource-policy writes, rotation, replication or deletion.

These are action/resource limits, **not** content-level enforcement.
[CreateSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html)
can create an initial value in the same request; denying PutSecretValue does
not make CreateSecret metadata-only. The
[supported condition keys](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html)
do not provide a SecretString/SecretBinary absence condition. Likewise,
[PutRolePolicy](https://docs.aws.amazon.com/IAM/latest/APIReference/API_PutRolePolicy.html)
accepts a policy document. Exact target scoping alone does not constrain its
content. Empty containers and exact execution-role trust/policy therefore rely
on the reviewed immutable workflow/provider/declarations, same-plan guards and
post-apply verification. Residual trusted-operator authority requires explicit
acceptance; no assertion that IAM proves these content restrictions is allowed.

The proposed executor keeps one private runner and one saved plan alive through
review; no plan, inputs or state is handed to another job, artifact or operator
download. After a full plan passes all guards, emit only an allowlisted receipt
with phase, exact source/run/attempt, account/identity, state lineage/serial,
plan digest, fixed seven-resource security configuration and one-use nonce.
An explicit approval must bind this receipt and digest, come from an approved
human identity, and be created after the receipt. Reject bot, stale, edited,
unbound, replayed or timed-out approvals. Existing chat “proceed” is not such a
plan approval. The same-runner approval implementation is a required later
review/test gate; do not claim it exists in #343.

Native [GitHub deployment approval](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)
admits a job before execution, so it is not by itself review of that job's
later saved plan. Do not split plan/apply jobs and silently move sensitive
files between them to simulate this checkpoint. Immediately before apply,
recheck current main, receipt authorization/expiry, plan digest, source/override
guards, AWS identity and durable shared writer hold. Before either phase's
saved-plan apply, require reviewed phase-specific authorization evidence for
that identity, resource set and validity window: safe actual metadata/denial
probes and IAM simulation of prohibited mutations/value reads. Missing or
failed proof blocks apply; do not probe denial by writing or fetching values.
Terraform must reject a stale state plan. Cancellation/failure keeps the hold
and requires inspection, not a blind rerun or automatic destroy. Release no
secrets or traffic.

Creation-phase authority must not also permit the metadata-policy updates.
After verifying the seven empty resources, expire/revoke that phase's sessions.
The separately reviewed metadata phase allows only the exact two policy targets
from [#338](https://github.com/vayada-marketplace/vayada-platform/pull/338), with
its own fresh saved plan/approval and unchanged installed writer boundary.
Policy-document mutation is privileged there too; guards and verification,
not a claimed IAM document-content constraint, preserve the cutoff and deny
extra grants. The setup identity must not alter its own trust/policies.

Use explicit request-time expiry and the reviewed
[session-revocation procedure](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html);
removing OIDC trust alone does not revoke issued sessions. Demonstrate allowed
operations, denied unrelated/value/service/PassRole operations and old-session
denial without prohibited mutation probes. Keep ordinary writers paused until
temporary authority is retired, positive/negative metadata checks pass and
ordinary hosted refresh is no-op. Concrete policies, provider action inventory,
approval-channel code, partial-failure recovery and actual-role evidence remain
implementation gates. No role, grant or apply is authorized by this proposal.

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
