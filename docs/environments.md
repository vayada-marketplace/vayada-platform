# Environments

How production is provisioned, deployed, and operated from this repository.

## Ownership boundary

This repository owns everything after an image is published to ECR:

| Concern                                         | Owner                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Application code, Docker builds, migrations     | `vayada` (app repo)                                                                           |
| ECR repository creation                         | `vayada-platform` (this repo)                                                                 |
| ECS task definition updates and service deploys | `vayada-platform` CI                                                                          |
| Production secrets and SSM parameters           | `vayada-platform` (`infra/ssm.tf`)                                                            |
| DNS, TLS certificates, load balancer config     | `vayada-platform` (`infra/route53.tf`, `infra/cloudflare.tf`, `infra/acm.tf`, `infra/alb.tf`) |
| CloudWatch log groups                           | `vayada-platform` (`infra/cloudwatch.tf`)                                                     |

## Production environment

### Infrastructure

All AWS resources are managed with Terraform in `infra/`. State is stored in S3:

```
bucket: vayada-terraform-state
key:    platform/terraform.tfstate
region: eu-west-1
```

Lock table: `vayada-terraform-lock` (DynamoDB).

### Services

| Service               | ECR repository                       | ECS service                          | Domain                     |
| --------------------- | ------------------------------------ | ------------------------------------ | -------------------------- |
| Next TypeScript API   | `vayada-next-api`                    | `vayada-next-api-service`            | `next-api.vayada.com`      |
| Legacy Booking API    | `vayada-booking-backend`             | `vayada-booking-backend-service`     | `booking-api.vayada.com`   |
| Booking Web           | `vayada-booking-frontend`            | `vayada-booking-frontend-service`    | `*.booking.vayada.com`     |
| Booking Admin         | `vayada-booking-admin-frontend`      | `vayada-booking-admin-service`       | `admin.booking.vayada.com` |
| Legacy PMS API        | `vayada-pms-backend`                 | `vayada-pms-backend-service`         | `pms-api.vayada.com`       |
| PMS Web               | `vayada-pms-frontend`                | `vayada-pms-frontend-service`        | `pms.vayada.com`           |
| Legacy Marketplace API | `vayada-creator-marketplace-backend` | `vayada-marketplace-backend-service` | `api.vayada.com`           |
| Marketplace Admin     | `vayada-admin-frontend`              | `vayada-marketplace-admin-service`   | (internal)                 |
| Affiliate Dashboard   | `vayada-affiliate-dashboard`         | `vayada-affiliate-dashboard-service` | `affiliate.vayada.com`     |
| Next PMS Web          | `vayada-next-pms-frontend`           | `vayada-next-pms-frontend-service`   | `next-pms.vayada.com`      |
| Landing               | `vayada-landing`                     | App Runner                           | (App Runner auto-deploy)   |

All ECS services run on `vayada-backend-cluster` (Fargate) in `eu-west-1`, fronted by `vayada-backend-alb`. Public `vayada.com` DNS is authoritative in Cloudflare; Route 53 records remain for AWS-side aliases and certificate validation where used. Cloudflare DNS management is gated by `enable_cloudflare_dns`; only enable it after `TF_VAR_CLOUDFLARE_API_TOKEN` is a valid DNS edit token for the `vayada.com` zone.

### Parallel next-stack hostname freeze

Next-stack rollout is parallel validation, not a production hostname cutover.
The existing production hostnames intentionally keep their current routing until
a separate cutover ticket says otherwise:

| Hostname | Current routing owner |
| --- | --- |
| `vayada.com` | Existing public site routing |
| `app.vayada.com` | Existing marketplace frontend routing |
| `api.vayada.com` | Legacy Marketplace API |
| `booking-api.vayada.com` | Legacy Booking API |
| `booking.vayada.com` and `*.booking.vayada.com` | Existing Booking Web |
| `admin.booking.vayada.com` | Existing Booking Admin |
| `pms-api.vayada.com` | Legacy PMS API |
| `pms.vayada.com` | Existing PMS Web |
| `admin.vayada.com` | Existing Vayada Admin |
| `affiliate.vayada.com` | Existing Affiliate Dashboard |

Next-stack changes must use only the `next-*` hostnames:
`next-api.vayada.com`, `next-pms.vayada.com`, `next-admin.vayada.com`,
`next-booking-admin.vayada.com`, `next-booking.vayada.com`,
`*.next-booking.vayada.com`, `next-marketplace.vayada.com`, and
`next-affiliate.vayada.com`.

Before merging platform changes, review `infra/alb.tf`, `infra/route53.tf`,
`infra/cloudflare.tf`, and `infra/ecs.tf` with `terraform plan`. The plan must
not repoint any existing production hostname above to a `next-*` target group,
Cloudflare record, Route 53 record, or next-stack ECS environment.

Provider dashboard/webhook endpoints also stay on the current legacy Python
production paths until an explicit provider cutover window. Do not move provider
callbacks to `next-api.vayada.com` during next-stack validation; preserve the
currently exported dashboard URLs, such as
`https://pms-api.vayada.com/webhooks/stripe`, or the existing legacy
`/webhooks/*` route for providers that are not currently active.

### Platform media delivery

The TypeScript platform media service uses the private, encrypted, versioned
`vayada-media-production` bucket. Browser uploads use signed `PUT` requests to
`staging/*`; the `vayada-next-api-media-task-role` can read, publish, and delete
objects only under `staging/*`, `public/*`, and `private/*`.

Public media is served at `https://images.vayada.com`. CloudFront signs origin
requests with Origin Access Control and can read only `public/*`. Its `/public`
origin path maps a viewer request such as `/media/<id>/original_safe/<version>.webp`
to `public/media/<id>/original_safe/<version>.webp` in S3. The bucket blocks all
anonymous access, and CloudFront cannot read `private/*` or `staging/*`.

`next-api` receives the complete media serving contract:

```text
PLATFORM_MEDIA_BUCKET=vayada-media-production
PLATFORM_MEDIA_CDN_BASE_URL=https://images.vayada.com
PLATFORM_MEDIA_CDN_ORIGIN_HOST=vayada-media-production.s3.eu-west-1.amazonaws.com
PLATFORM_MEDIA_PUBLIC_PATH_PREFIX=media
PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL=public, max-age=31536000, immutable
PLATFORM_MEDIA_PRIVATE_DOWNLOAD_TTL_SECONDS=300
PLATFORM_MEDIA_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS=900
```

#### Rollout

1. Bootstrap the platform deploy role permissions described in [IAM](#iam).
2. Set `TF_VAR_ENABLE_CLOUDFLARE_DNS=true` and provide a Cloudflare token with
   DNS edit access. Cloudflare is authoritative for `vayada.com`, so this is
   required for the `us-east-1` ACM validation record and the DNS-only `images`
   CNAME.
3. Review `terraform plan`, then apply and wait for the certificate and
   CloudFront distribution to reach their issued/deployed states.
4. Deploy the durable upload code with required-photo flags still disabled, then
   upload a canary profile image through the signed browser flow.
5. Verify its browser preflight and `PUT`, confirm the anonymous S3 object URL is
   denied, and confirm the matching `https://images.vayada.com/media/...` URL
   succeeds (including HTTP-to-HTTPS redirect behavior).
6. Activate required-photo flags only in the separate data-cutover ticket.

#### Rollback and legacy safety

The legacy `vayada-uploads-prod` bucket, its guarded CDN policy, BIMI object, and
all stored direct URLs remain in place. If the new media path must be rolled back,
first deploy the previous `next-api` task definition or remove its
`PLATFORM_MEDIA_*` values. Keep the new bucket and CDN in place while references
may exist; do not delete media objects or use `terraform destroy` as rollback.

### Finance folio recipient encryption

Terraform injects the non-secret current full key ARN as
`FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN` and all retained full ARNs as the
comma-separated `FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS`. Only current can
encrypt; all allowed versions can decrypt/describe. The separate HMAC key ARN is
injected as `FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN`; it can generate
only `HMAC_SHA_256` recipient fingerprints. Persist both full ARNs.

Encrypt/decrypt must supply exactly `purpose=finance-folio-recipient-v1`,
`propertyId=<UUID>`, `folioId=<UUID>`, and `revision=<positive decimal>`. The
task policy also requires `SYMMETRIC_DEFAULT`; the key policy denies cryptographic
use to every principal except the next-api task role, including the execution role.
Account root retains key-policy administration but is covered by that crypto deny.
IAM enforces UUID shape and nonempty revision text, rejecting `0` and `-*`; the
application enforces canonical UUIDs and positive safe integers before KMS calls.

For a full-key rotation (365-day automatic period), first land `vN` in the map while leaving current unchanged;
the apply guard pauses its unimported create. The stacked bootstrap lane then
creates/imports that declared address. Apply its policy/allowlist, validate, and
only then promote current separately. Retain old keys until inventory clears them.
The fingerprint HMAC key does not support AWS automatic rotation. Rotate it by
declaring and bootstrapping/importing a new version with the `fingerprint` lane,
but do not promote it from `finance_folio_recipient_fingerprint_current_key_version`
until separately reviewed application compatibility can verify retained-key
fingerprints or an explicitly approved re-fingerprinting migration has re-derived
and verified every stored fingerprint with a tested rollback. VAY-1132 bootstraps
only `v1`; creating or importing a future HMAC key never authorizes promotion.

### Deployment flow

1. App CI pushes a Docker image to ECR with a moving environment tag and
   `:<git-sha>`; legacy production deploys own `:latest`, next deploys own
   `:next-latest`
2. App CI fires a `repository_dispatch` event (`app-image-published`) to this repo
3. `.github/workflows/deploy.yml` picks up the event
4. Platform CI downloads the current ECS task definition, renders a new revision with the SHA-pinned image, and deploys it to the ECS service
5. The workflow waits for service stability before marking success
6. Auth-gateway-enabled frontends are probed through their public own-origin routes: session must return HTTP 401 `missing_session`, and Google auth start must return HTTP 302 to WorkOS
7. Next Booking Web waits for the exact deployed source SHA at `/api/health`, then verifies the configured persistent tenant's host resolution, public-bookability profile, and public page

   A failed Booking public smoke redeploys the pre-cutover task image automatically.

The Booking canary uses the repository variables `NEXT_BOOKING_CANARY_URL` and
`NEXT_BOOKING_CANARY_NAME`. The URL must be a dedicated, permanently published
tenant origin on `*.next-booking.vayada.com`; changing or retiring that tenant
requires updating both variables in the same operational change.

Gateway service names, origins, and surfaces come from
[`infra/auth-gateways.json`](../infra/auth-gateways.json). See the
[Auth Gateway Deployment Contract](auth-gateway-contract.md) for the required
app/platform release coordination and validation rules.

The Landing service is excluded — App Runner polls ECR for `:latest` and deploys automatically. No dispatch is needed.

ECS services use `lifecycle { ignore_changes = [task_definition] }` in Terraform, so `terraform apply` never rolls back in-flight CI deploys.
When Terraform registers newer task definitions for `vayada-next-api`,
`vayada-booking-frontend`, `vayada-booking-admin`, or the frozen staging PMS
runtime, `tf-apply.yml` rolls the corresponding service forward. Production
services retain their current container image; staging PMS uses its
Terraform-owned `latest` image reference.

`next-api.vayada.com` is the TypeScript validation hostname. It is served by
`vayada-next-api-service` and reads production-owned target runtime secrets
from `/vayada/prod/*`, not `/vayada/staging/*`.

Public platform media is written to `vayada-uploads-prod` and served through the
Terraform-managed `vayada-platform-media` CloudFront distribution. The
`PLATFORM_MEDIA_BUCKET`, `PLATFORM_MEDIA_CDN_BASE_URL`, and
`PLATFORM_MEDIA_CDN_ORIGIN_HOST` values are injected directly into the
`next-api` task definition.

### Secrets

Runtime secrets are stored in AWS SSM Parameter Store under `/vayada/prod/`:

| Parameter                             | Used by                            |
| ------------------------------------- | ---------------------------------- |
| `/vayada/prod/db-booking-url`         | `booking-api`                      |
| `/vayada/prod/db-pms-url`             | `pms-api`                          |
| `/vayada/prod/db-pms-url-ssl`         | `pms-api`                          |
| `/vayada/prod/db-auth-url`            | all APIs                           |
| `/vayada/prod/db-auth-url-ssl`        | all APIs                           |
| `/vayada/prod/db-marketplace-url`     | `marketplace-api`                  |
| `/vayada/prod/jwt-secret-key`         | all APIs                           |
| `/vayada/prod/stripe-secret-key`      | `pms-api`, `next-api`              |
| `/vayada/prod/stripe-webhook-secret`  | `pms-api`, `next-api`              |
| `/vayada/prod/stripe-connect-webhook-secret` | `pms-api`                 |
| `/vayada/prod/smtp-username`          | `booking-api`, `marketplace-api`   |
| `/vayada/prod/smtp-password`          | `booking-api`, `marketplace-api`   |
| `/vayada/prod/anthropic-api-key`      | `pms-api`                          |
| `/vayada/prod/channex-api-key`        | `pms-api`                          |
| `/vayada/prod/firecrawl-api-key`      | `pms-api`                          |
| `/vayada/prod/cloudflare-api-token`   | platform Terraform                 |
| `/vayada/prod/target-database-url`    | `next-api`                         |
| `/vayada/prod/workos-api-key`         | `next-api`                         |
| `/vayada/prod/workos-client-id`       | `next-api`                         |
| `/vayada/prod/workos-webhook-secret`  | `next-api`                         |
| `/vayada/prod/auth-cookie-secret`     | `next-api`                         |
| `/vayada/prod/resend-api-key`         | `next-api`                         |

The `next-api` task maps those SSM parameters to the backend's runtime
environment as:

| Backend env var | SSM parameter or Terraform variable |
| --- | --- |
| `TARGET_DATABASE_URL` | `/vayada/prod/target-database-url` |
| `AUTH_DATABASE_URL` | `/vayada/prod/target-database-url` |
| `WORKOS_CLIENT_ID` | `/vayada/prod/workos-client-id` |
| `WORKOS_WEBHOOK_SECRET` | `/vayada/prod/workos-webhook-secret` |
| `AUTH_COOKIE_SECRET` | `/vayada/prod/auth-cookie-secret` |
| `RESEND_API_KEY` | `/vayada/prod/resend-api-key` |
| `STRIPE_SECRET_KEY` | `/vayada/prod/stripe-secret-key` |
| `STRIPE_WEBHOOK_SECRET` | `/vayada/prod/stripe-webhook-secret` |
| `WORKOS_AUDIENCE`, `WORKOS_ISSUER`, `WORKOS_JWKS_URL` | Terraform variables from matching GitHub Actions secrets |

Set the required GitHub Actions repository secrets before merging or applying a
live `next-api` task definition: `TF_VAR_TARGET_DATABASE_URL`,
`TF_VAR_WORKOS_API_KEY`, `TF_VAR_WORKOS_WEBHOOK_SECRET`,
`TF_VAR_WORKOS_AUDIENCE`, `TF_VAR_WORKOS_ISSUER`, `TF_VAR_WORKOS_JWKS_URL`,
`TF_VAR_AUTH_COOKIE_SECRET`, `TF_VAR_RESEND_API_KEY`,
`TF_VAR_STRIPE_SECRET_KEY`, and `TF_VAR_STRIPE_WEBHOOK_SECRET`.

### Transactional email delivery

SES uses the `vayada-transactional` configuration set by default for the
`vayada.com` sending identity. Send, delivery, delay, rejection, bounce, and
complaint events are retained for 30 days in the
`/aws/events/vayada-ses-events` CloudWatch log group. Use the recipient address
or SES message ID to trace a specific email; an SMTP success only means SES
accepted the message, while `Email Delivered` confirms handoff to the
recipient's mail server.

The three SES DKIM CNAMEs are managed directly in the authoritative Cloudflare
zone because general Cloudflare Terraform ownership remains gated by
`enable_cloudflare_dns`. Do not remove them when rolling back event tracking.

The SES configuration set and event log group are protected from Terraform
destroy plans and by explicit deny statements in the external
`vayada-github-actions-platform-deploy` role's
`platform-ses-observability` inline policy. Keep those denies out of Terraform
so a configuration revert cannot remove the final safety boundary. To retire
event tracking without interrupting email, first clear the identity default,
then remove the protected resources from Terraform state before deleting their
declarations:

```bash
aws sesv2 put-email-identity-configuration-set-attributes \
  --region eu-west-1 \
  --email-identity vayada.com
terraform -chdir=infra state rm \
  aws_sesv2_configuration_set.transactional \
  aws_cloudwatch_log_group.ses_events
```

Only after the state removal and an explicit decommission decision should an
AWS administrator change the inline deny policy and delete the orphaned remote
resources.

### Provider callback routing

Secret availability does not establish callback ownership. The production
listener has no provider-specific path rules: all requests for
`pms-api.vayada.com`, including `/webhooks/*`, go to the legacy PMS target group.
`next-api.vayada.com` goes to the TypeScript target group.

| Callback                                  | Routing result for documented path                                                                                       | Target posture                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Stripe platform `/webhooks/stripe`        | `pms-api.vayada.com/webhooks/stripe` reaches legacy; provider Dashboard URL and enablement are unverified                | `next-api` has the same signing-secret parameter and uses `STRIPE_WEBHOOK_INTAKE_MODE=mutating` for target checkout            |
| Stripe Connect `/webhooks/stripe/connect` | `pms-api.vayada.com/webhooks/stripe/connect` reaches legacy; provider Dashboard URL and enablement are unverified        | The target has no Connect callback route or `STRIPE_CONNECT_WEBHOOK_SECRET`; keep this documented path on legacy               |
| Channex `/webhooks/channex`               | `pms-api.vayada.com/webhooks/channex` reaches a legacy route; the runtime has no injected `CHANNEX_WEBHOOK_SECRET`; provider Dashboard URL, enablement, and header-secret configuration are unverified | `next-api` is `observe_only` and has no Channex callback secret; the Channex API key is not a callback secret                  |

This matrix records Terraform and deployed routing only, not provider callback
ownership. Provider Dashboard endpoint state requires a separate authenticated
export; do not infer it from an existing route or secret parameter.

Do not point Stripe shadow traffic at the existing production `next-api`: its
Stripe intake is intentionally mutating. Shadow evidence needs a separate
observe-only runtime or a newly accepted plan that preserves one mutating owner.
Do not change the live target mode merely to collect evidence because production
target checkout requires the current Stripe contract.

Under the VAY-1349 master plan, VAY-947 is the provider sub-runbook for the
VAY-1362 production execution window, not an independent cutover. After VAY-1361
rehearsal and an approved preproduction dry run, VAY-1362 must freeze legacy
writers, schedulers, and providers; complete final extraction, apply, parity,
and target-only smoke; then switch application data ownership and provider
callbacks within the same human-approved VAY-1362 execution window, in the
VAY-947 sub-runbook's approved order. VAY-1363 retirement starts only after the
observation and rollback window.

Before any provider callback change, VAY-947 must record a current provider
dashboard export, matching endpoint-secret ownership, signed receipt and replay
evidence, the legacy freeze state, and an independently approved rollback order.
Stripe evidence must distinguish platform events from connected-account events.
Any future exact ALB rule for `/webhooks/stripe` must not capture
`/webhooks/stripe/connect`.

Channex also remains blocked on the callback event policy, accepted
property-adoption proof, and live ownership gates tracked by VAY-844, VAY-1320,
and VAY-845. Do not add a Channex callback secret, repoint its dashboard, freeze
legacy polling, or enable target mutation as an evidence-gathering shortcut.

SSM parameters are referenced by ARN in ECS task definitions — containers read them at startup via the `ecsTaskExecutionRole`.

### Frozen staging PMS runtime

Terraform can create a dedicated staging PMS backend runtime for the
legacy scheduler-freeze proof. It is disabled by default and is controlled by:

```hcl
enable_staging_pms_runtime              = true
staging_pms_database_url                = "..."
staging_pms_auth_database_url           = "..." # optional; defaults to staging_pms_database_url
staging_pms_booking_engine_database_url = "..." # optional; defaults to staging_pms_database_url
```

When enabled, Terraform creates:

- `/vayada/staging/pms-database-url`;
- `/vayada/staging/pms-auth-database-url` and
  `/vayada/staging/pms-booking-engine-database-url`;
- no-op `/vayada/staging/pms-*` SMTP, Stripe API/webhook, Channex API,
  Anthropic, Firecrawl, and JWT secrets;
- ECS task definition/service `vayada-staging-pms-backend`;
- no ECS task role for the staging PMS container; only the execution role reads
  its SSM secrets and pulls the image;
- target group `staging-pms-backend-tg`;
- ALB listener rule and Route 53 alias for
  `https://staging-pms-api.vayada.com`;
- CloudWatch log group `/ecs/vayada-staging-pms-backend`.

The service uses the PMS backend image repository and starts with the legacy
scheduler frozen and legacy provider webhook modes set to
`ack_only_with_receipt`. Capture `https://staging-pms-api.vayada.com/health`
for the VAY-794 freeze evidence before inserting scheduler-freeze rows into the
target database.

Only enable this runtime for scheduler-freeze evidence when the auth and
booking URLs above point to staging databases or explicitly approved read-only
production credentials. If the auth or booking URL is omitted, Terraform uses
`staging_pms_database_url` so the runtime does not fall back to production.
SMTP, Stripe API, Channex API, Anthropic, Firecrawl,
S3, and booking API runtime values are no-op values in Terraform, and the
container has no ECS task role, so the frozen runtime cannot write to
production AWS resources or providers. With staging auth and booking URLs, the
only production dependency is the PMS backend image repository, which ECS pulls
read-only through the execution role. If either URL points at production, it
must use explicitly approved read-only credentials and is the only approved
production data dependency.

### Applying infrastructure changes

```bash
cd infra
terraform init
terraform plan    # review before applying
terraform apply
```

Requires AWS credentials with the permissions granted to `vayada-github-actions-platform-deploy`. In CI, `tf-plan.yml` runs on PRs and `tf-apply.yml` runs on merge to `main`.

### Triggering a manual deploy

Use `workflow_dispatch` on the deploy workflow:

```bash
gh workflow run deploy.yml \
  --repo vayada-marketplace/vayada-platform \
  --field service=<service-key> \
  --field ecr_repo=<ecr-repo-name> \
  --field image_sha=<full-40-char-sha> \
  --field environment=production
```

Service keys: `booking-backend`, `booking-frontend`, `booking-admin`, `pms-backend`, `pms-frontend`, `marketplace-backend`, `marketplace-admin`, `affiliate-dashboard`.

Parallel next-stack service keys: `next-target-backend`, `next-pms-frontend`.
`next-target-backend` serves `next-api.vayada.com`; `next-pms-frontend` remains
the parallel PMS frontend validation lane.

### Finance folio recipient inventory

Terraform publishes the inert, service-less
`vayada-next-api-finance-folio-recipient-inventory` task definition. It has no
listener, route, or task role; its default command does not connect. After apply
and before folio activation, run:

```bash
./scripts/run-finance-folio-recipient-inventory.sh
```

It reuses the next-api network and emits only counts grouped by scheme, recipient
key version, and fingerprint-key version from a repeatable-read, read-only
transaction. It never selects/logs ciphertext, PII, identifiers, or the DB URL.
Do not activate if a persisted recipient key version is outside the ARN allowlist.

### Stripe test-mode checkout smoke

Terraform also publishes the `vayada-next-api-stripe-test-smoke` task
definition. It is deliberately not attached to an ECS service, listener, or
public DNS name. Its default command exits immediately, so it cannot start the
API or duplicate target background workers by accident.

The task receives the production-owned target database URL for isolated QA
property checks and a dedicated restricted `rk_test_` Stripe credential from
`/vayada/staging/next-stripe-test-secret-key`. The restricted key must keep all
unrelated permissions at `None` and grant only these connected-account
permissions in the Stripe sandbox:

| Resource | Platform permission | Connect permission |
| --- | --- | --- |
| Balance Transaction Sources | None | Read |
| Charges and Refunds | None | Write |
| Payment Intents | Write | Write |

Edit the existing `VAY-1274 next checkout staging` key in place; do not rotate
it or create a broader replacement key.

Never point this task at a real property or use the production Stripe key. The
smoke program is hard-locked to the isolated QA property and refuses any key
that does not begin with `rk_test_`.

Run the one-off smoke from the platform repository:

```bash
./scripts/run-stripe-connect-smoke.sh
```

The launcher reuses the network configuration of
`vayada-next-api-service`, overrides the inert task command, waits for the task
to stop, and prints its CloudWatch log. A successful run reports the test
PaymentIntent, charge, and balance-transaction IDs plus exact gross, Stripe
fee, application fee, and net payout. It refunds the direct charge and its
application fee before reporting `PASS`. The program performs no target DB
writes and fails unless a final query verifies that zero `finance.payments`
rows reference its PaymentIntent. It logs the PaymentIntent ID immediately
after creation so an interrupted run can always be recovered.

If the task is interrupted after Stripe creates the PaymentIntent, copy the
`pi_...` identifier from the `stripe-test-smoke` CloudWatch stream and run:

```bash
./scripts/run-stripe-connect-smoke.sh --cleanup pi_test_payment_intent_id
```

Cleanup uses the same restricted key and connected-account context, refunds a
captured charge or cancels an uncaptured PaymentIntent, refuses live objects,
refuses PaymentIntents without this smoke's QA property metadata, and again
verifies that no target payment row remains. The task definition
remains unattached to an ECS service, listener, public route, or task role; its
default command remains inert.

## IAM

GitHub Actions authenticates via OIDC using the `vayada-github-actions-platform-deploy` role:

- **Trust**: `repo:vayada-marketplace/vayada-platform:*`
- **Permissions**: ECS deploy (RegisterTaskDefinition, CreateService, UpdateService, Describe\*), Terraform state (S3 + DynamoDB), ALB, ACM, Route53, CloudWatch, SSM, ECR management (create/describe repositories — not push)

The `vayada-github-actions-platform-deploy` role is bootstrapped outside this
Terraform module, so changes to that role must be applied before platform
Terraform can use the new permission.

The deploy role must never receive pre-ARN `kms:CreateKey` or key-wildcard
`kms:TagResource`: either permission can claim unrelated keys. The PR plan guard
allows only the reviewed diagnostic plan (6 add, 0 change, 1 task-definition
destroy). Production apply rejects every Finance KMS change until an administrator
runs both resumable bootstraps with production `TF_VAR_*` values loaded.

The script requires the database/JWT values plus the target database, WorkOS API,
webhook and issuer values, auth cookie, Resend, Stripe secret/webhook, and
Cloudflare token used by the current Terraform configuration. Load the same
production values as `.github/workflows/tf-apply.yml`; missing values stop before
state-file creation or `CreateKey`.

Then run:

```bash
./scripts/bootstrap-finance-folio-kms.sh v1 /secure/operator-state/finance-folio-kms-v1.json
./scripts/bootstrap-finance-folio-kms.sh v1 /secure/operator-state/finance-folio-fingerprint-kms-v1.json fingerprint
```

Keep that non-secret state file until rollout is complete and rerun the same
command after interruption. The script records a recovery marker before calling
`CreateKey`, records the response immediately, and recovers only the same tagged
key. It pins the production backend, default workspace, and state lineage before
locking the account/region/version lane. It refuses missing-state matches,
multiple matches, a conflicting alias, the wrong account/region/key properties/
tags, or an unverified Terraform import. A conditional one-hour DynamoDB lease
serializes even copied state; normal exit releases it and a hard-crash lease can
be resumed after expiry.
It installs the rendered exact-ARN steady policy and removes the superseded broad
bootstrap policy if present. Never translate the diagnostic plan into ad-hoc
commands or apply it; the deploy role intentionally lacks creation permissions.
The fingerprint lane installs its own exact-ARN policy with only the read-only
`GetKeyRotationStatus` call Terraform needs during refresh, no rotation mutation
or alias permissions, because HMAC keys support neither this recipient-key
rotation path nor the recipient alias contract.

The administrator needs `sts:GetCallerIdentity`; `kms:ListKeys`, `DescribeKey`,
`ListResourceTags`, `CreateKey`, `TagResource`, `EnableKeyRotation`, `GetKeyRotationStatus`,
`ListAliases`, and `CreateAlias`; `iam:PutRolePolicy`, `ListRolePolicies`, and
`DeleteRolePolicy`; `dynamodb:PutItem` and `DeleteItem` restricted to
`arn:aws:dynamodb:eu-west-1:269416271598:table/vayada-terraform-lock`;
plus the normal Terraform state/read permissions. The unscoped creation
authority stays on the administrator and is never attached to
the deploy role. After import, use only the exact-ARN steady-state policy.

Rotation is a paused, two-change lane. First merge only the new `vN` map entry
while leaving `current` unchanged; the apply guard deliberately stops the
unimported create. Run the same bootstrap for `vN`, which imports the now-declared
address and verifies that the current alias still targets the old key. Review and
apply the post-import key-policy/allowed-list plan, run the aggregate inventory,
and validate decrypts. Only then use a separate reviewed promotion change to move
`current`; never import before the `for_each` entry exists or move the alias from
the bootstrap script.

The post-import apply guard permits only the imported key policy update, task-role
policy and inert inventory creation, and next-api create-before-destroy task
replacement. The alias must be a no-op targeting the imported key. It validates
the six tags, immutable key properties, outsider/grant denies, exact task actions
and camelCase context, and matching task environment ARNs. Any KMS/alias create,
alias retarget, or unrelated add/change/delete fails before `terraform apply`.
After this one-time set is applied, ordinary plans remain allowed subject to the
existing protected-resource checks; alias promotion requires its own reviewed
guard change. A rotation map-entry PR must likewise add the exact `vN`
post-import fixture/guard set before bootstrap; it must not retarget the alias.
The hosted wrapper derives pre-import, post-import, or steady phase from the
unique managed v1 key and alias plan state. PR diagnostics allow all three;
production apply rejects pre-import and accepts only a validated post-import or
steady plan.

Before the first platform-media plan/apply, extend that bootstrapped role with
CloudFront distribution and Origin Access Control lifecycle permissions, ACM
certificate lifecycle permissions in `us-east-1`, and S3 bucket/configuration
lifecycle permissions (including bucket policy) for `vayada-media-production`.
It also needs IAM role/inline-policy lifecycle permissions for
`vayada-next-api-media-task-role` plus `iam:PassRole` restricted to that role.
Keep the Cloudflare API token limited to DNS edits for the `vayada.com` zone.
These deployment permissions do not belong on the ECS task role; the task role
itself receives only the three object actions declared in `infra/media.tf`.

The app repo uses a separate role (`vayada-github-actions-deploy`) for ECR push only. Neither role holds the other's permissions.

## Preview environments

Not yet defined. Preview environment artifact handling will be specified in a follow-up issue. The production contract above is the initial implementation.

## Monitoring

CloudWatch log groups are created per service under `/ecs/<service-name>`. There is no centralised alerting configured yet — this is a follow-up item.
