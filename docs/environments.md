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
| Next TypeScript API   | `vayada-api`                         | `vayada-next-api-service`            | `next-api.vayada.com`      |
| Legacy Booking API    | `vayada-booking-backend`             | `vayada-booking-backend-service`     | `booking-api.vayada.com`   |
| Booking Web           | `vayada-booking-frontend`            | `vayada-booking-frontend-service`    | `*.booking.vayada.com`     |
| Booking Admin         | `vayada-booking-admin-frontend`      | `vayada-booking-admin-service`       | `admin.booking.vayada.com` |
| Legacy PMS API        | `vayada-pms-backend`                 | `vayada-pms-backend-service`         | `pms-api.vayada.com`       |
| PMS Web               | `vayada-pms-frontend`                | `vayada-pms-frontend-service`        | `pms.vayada.com`           |
| Legacy Marketplace API | `vayada-creator-marketplace-backend` | `vayada-marketplace-backend-service` | `api.vayada.com`           |
| Marketplace Admin     | `vayada-admin-frontend`              | `vayada-marketplace-admin-service`   | (internal)                 |
| Affiliate Dashboard   | `vayada-affiliate-dashboard`         | `vayada-affiliate-dashboard-service` | `affiliate.vayada.com`     |
| Next PMS Web          | `vayada-pms-frontend`                | `vayada-next-pms-frontend-service`   | `next-pms.vayada.com`      |
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

### Deployment flow

1. App CI pushes a Docker image to ECR with a moving environment tag and
   `:<git-sha>`; legacy production deploys own `:latest`, next deploys own
   `:next-latest`
2. App CI fires a `repository_dispatch` event (`app-image-published`) to this repo
3. `.github/workflows/deploy.yml` picks up the event
4. Platform CI downloads the current ECS task definition, renders a new revision with the SHA-pinned image, and deploys it to the ECS service
5. The workflow waits for service stability before marking success

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
| `/vayada/prod/stripe-secret-key`      | `booking-api`                      |
| `/vayada/prod/stripe-webhook-secret`  | `booking-api`, `next-api`          |
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
| `/vayada/prod/openai-api-key`         | `next-api` when `ASK_INTELLIGENCE_PROVIDER=openai` |

The `next-api` task maps those SSM parameters to the backend's runtime
environment as:

| Backend env var | SSM parameter or Terraform variable |
| --- | --- |
| `TARGET_DATABASE_URL` | `/vayada/prod/target-database-url` |
| `AUTH_DATABASE_URL` | `/vayada/prod/target-database-url` |
| `WORKOS_CLIENT_ID` | `/vayada/prod/workos-client-id` |
| `WORKOS_WEBHOOK_SECRET` | `/vayada/prod/workos-webhook-secret` |
| `AUTH_COOKIE_SECRET` | `/vayada/prod/auth-cookie-secret` |
| `STRIPE_WEBHOOK_SECRET` | `/vayada/prod/stripe-webhook-secret` |
| `WORKOS_AUDIENCE`, `WORKOS_ISSUER`, `WORKOS_JWKS_URL` | Terraform variables from matching GitHub Actions secrets |
| `ASK_INTELLIGENCE_PROVIDER`, `ASK_INTELLIGENCE_MODEL`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT` | Terraform variables from matching GitHub Actions secrets |
| `OPENAI_API_KEY` | `/vayada/prod/openai-api-key` when `ASK_INTELLIGENCE_PROVIDER=openai` |

Set the required GitHub Actions repository secrets before merging or applying a
live `next-api` task definition: `TF_VAR_TARGET_DATABASE_URL`,
`TF_VAR_WORKOS_API_KEY`, `TF_VAR_WORKOS_WEBHOOK_SECRET`,
`TF_VAR_WORKOS_AUDIENCE`, `TF_VAR_WORKOS_ISSUER`, `TF_VAR_WORKOS_JWKS_URL`,
`TF_VAR_AUTH_COOKIE_SECRET`, and `TF_VAR_ASK_INTELLIGENCE_PROVIDER` if
overriding the default fixture Ask provider. When enabling
`ASK_INTELLIGENCE_PROVIDER=openai`, also set `TF_VAR_OPENAI_API_KEY` and
`TF_VAR_ASK_INTELLIGENCE_MODEL`. Optional OpenAI routing fields are
`TF_VAR_OPENAI_BASE_URL`, `TF_VAR_OPENAI_ORGANIZATION`, and
`TF_VAR_OPENAI_PROJECT`.

Provider callback/API secrets remain outside the `next-api` task definition
while provider dashboard callbacks stay on accepted legacy production paths.
Add production-owned `/vayada/prod/*` names for those providers in the explicit
provider cutover ticket that first routes their traffic to the TypeScript API.

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

## IAM

GitHub Actions authenticates via OIDC using the `vayada-github-actions-platform-deploy` role:

- **Trust**: `repo:vayada-marketplace/vayada-platform:*`
- **Permissions**: ECS deploy (RegisterTaskDefinition, CreateService, UpdateService, Describe\*), Terraform state (S3 + DynamoDB), ALB, ACM, Route53, CloudWatch, SSM, ECR management (create/describe repositories — not push)

The `vayada-github-actions-platform-deploy` role is bootstrapped outside this
Terraform module, so changes to that role must be applied before platform
Terraform can use the new permission.

The app repo uses a separate role (`vayada-github-actions-deploy`) for ECR push only. Neither role holds the other's permissions.

## Preview environments

Not yet defined. Preview environment artifact handling will be specified in a follow-up issue. The production contract above is the initial implementation.

## Monitoring

CloudWatch log groups are created per service under `/ecs/<service-name>`. There is no centralised alerting configured yet — this is a follow-up item.
