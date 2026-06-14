# Environments

How production is provisioned, deployed, and operated from this repository.

## Ownership boundary

This repository owns everything after an image is published to ECR:

| Concern | Owner |
|---|---|
| Application code, Docker builds, migrations | `vayada` (app repo) |
| ECR repository creation | `vayada-platform` (this repo) |
| ECS task definition updates and service deploys | `vayada-platform` CI |
| Production secrets and SSM parameters | `vayada-platform` (`infra/ssm.tf`) |
| DNS, TLS certificates, load balancer config | `vayada-platform` (`infra/route53.tf`, `infra/acm.tf`, `infra/alb.tf`) |
| CloudWatch log groups | `vayada-platform` (`infra/cloudwatch.tf`) |

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

| Service | ECR repository | ECS service | Domain |
|---|---|---|---|
| Booking API | `vayada-booking-backend` | `vayada-booking-backend-service` | `booking-api.vayada.com` |
| Booking Web | `vayada-booking-frontend` | `vayada-booking-frontend-service` | `*.booking.vayada.com` |
| Booking Admin | `vayada-booking-admin-frontend` | `vayada-booking-admin-service` | `admin.booking.vayada.com` |
| PMS API | `vayada-pms-backend` | `vayada-pms-backend-service` | `pms-api.vayada.com` |
| PMS Web | `vayada-pms-frontend` | `vayada-pms-frontend-service` | `pms.vayada.com` |
| Marketplace API | `vayada-creator-marketplace-backend` | `vayada-marketplace-backend-service` | `api.vayada.com` |
| Marketplace Admin | `vayada-admin-frontend` | `vayada-marketplace-admin-service` | (internal) |
| Affiliate Dashboard | `vayada-affiliate-dashboard` | `vayada-affiliate-dashboard-service` | `affiliate.vayada.com` |
| Landing | `vayada-landing` | App Runner | (App Runner auto-deploy) |

All ECS services run on `vayada-backend-cluster` (Fargate) in `eu-west-1`, fronted by `vayada-backend-alb`.

### Deployment flow

1. App CI pushes a Docker image to ECR with two tags: `:latest` and `:<git-sha>`
2. App CI fires a `repository_dispatch` event (`app-image-published`) to this repo
3. `.github/workflows/deploy.yml` picks up the event
4. Platform CI downloads the current ECS task definition, renders a new revision with the SHA-pinned image, and deploys it to the ECS service
5. The workflow waits for service stability before marking success

The Landing service is excluded — App Runner polls ECR for `:latest` and deploys automatically. No dispatch is needed.

ECS services use `lifecycle { ignore_changes = [task_definition] }` in Terraform, so `terraform apply` never rolls back in-flight CI deploys.

### Secrets

Runtime secrets are stored in AWS SSM Parameter Store under `/vayada/prod/`:

| Parameter | Used by |
|---|---|
| `/vayada/prod/db-booking-url` | `booking-api` |
| `/vayada/prod/db-pms-url` | `pms-api` |
| `/vayada/prod/db-pms-url-ssl` | `pms-api` |
| `/vayada/prod/db-auth-url` | all APIs |
| `/vayada/prod/db-auth-url-ssl` | all APIs |
| `/vayada/prod/db-marketplace-url` | `marketplace-api` |
| `/vayada/prod/jwt-secret-key` | all APIs |
| `/vayada/prod/stripe-secret-key` | `booking-api` |
| `/vayada/prod/stripe-webhook-secret` | `booking-api` |
| `/vayada/prod/smtp-username` | `booking-api`, `marketplace-api` |
| `/vayada/prod/smtp-password` | `booking-api`, `marketplace-api` |
| `/vayada/prod/anthropic-api-key` | `pms-api` |
| `/vayada/prod/channex-api-key` | `pms-api` |
| `/vayada/prod/firecrawl-api-key` | `pms-api` |
| `/vayada/prod/cloudflare-api-token` | platform Terraform |

SSM parameters are referenced by ARN in ECS task definitions — containers read them at startup via the `ecsTaskExecutionRole`.

### C1 staging rehearsal secrets

The Channex/webhook cutover rehearsal uses a separate SSM namespace so replay
credentials do not get mixed with production runtime secrets:

| Parameter | Used by |
|---|---|
| `/vayada/staging/target-database-url` | `TARGET_DATABASE_URL` for target parity and C1 rehearsal dashboard checks |
| `/vayada/staging/stripe-webhook-secret` | `STRIPE_WEBHOOK_SECRET` for signing Stripe replay fixtures |
| `/vayada/staging/xendit-webhook-secret` | `XENDIT_WEBHOOK_SECRET` / `x-callback-token` for Xendit replay fixtures |
| `/vayada/staging/channex-webhook-secret` | `CHANNEX_WEBHOOK_SECRET` / `x-vayada-webhook-token` for Channex replay fixtures |

Terraform creates these parameters only when `manage_staging_rehearsal_secrets`
is enabled and all matching variables are set:

```hcl
manage_staging_rehearsal_secrets = true
staging_target_database_url    = "..."
staging_stripe_webhook_secret  = "..."
staging_xendit_webhook_secret  = "..."
staging_channex_webhook_secret = "..."
```

Do not commit the real values. The C1 rehearsal operator should read these
parameters into the app repo rehearsal commands and pass them as environment
variables without printing them.

Example no-print local load for the app repo rehearsal commands:

```bash
export TARGET_DATABASE_URL="$(aws ssm get-parameter --name /vayada/staging/target-database-url --with-decryption --query Parameter.Value --output text)"
export STRIPE_WEBHOOK_SECRET="$(aws ssm get-parameter --name /vayada/staging/stripe-webhook-secret --with-decryption --query Parameter.Value --output text)"
export XENDIT_WEBHOOK_SECRET="$(aws ssm get-parameter --name /vayada/staging/xendit-webhook-secret --with-decryption --query Parameter.Value --output text)"
export CHANNEX_WEBHOOK_SECRET="$(aws ssm get-parameter --name /vayada/staging/channex-webhook-secret --with-decryption --query Parameter.Value --output text)"
```

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

## IAM

GitHub Actions authenticates via OIDC using the `vayada-github-actions-platform-deploy` role:

- **Trust**: `repo:vayada-marketplace/vayada-platform:*`
- **Permissions**: ECS deploy (RegisterTaskDefinition, UpdateService, Describe*), Terraform state (S3 + DynamoDB), ALB, ACM, Route53, CloudWatch, SSM, ECR management (create/describe repositories — not push)

The app repo uses a separate role (`vayada-github-actions-deploy`) for ECR push only. Neither role holds the other's permissions.

## Preview environments

Not yet defined. Preview environment artifact handling will be specified in a follow-up issue. The production contract above is the initial implementation.

## Monitoring

CloudWatch log groups are created per service under `/ecs/<service-name>`. There is no centralised alerting configured yet — this is a follow-up item.
