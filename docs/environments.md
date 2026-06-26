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
| Booking API           | `vayada-booking-backend`             | `vayada-booking-backend-service`     | `booking-api.vayada.com`   |
| Booking Web           | `vayada-booking-frontend`            | `vayada-booking-frontend-service`    | `*.booking.vayada.com`     |
| Booking Admin         | `vayada-booking-admin-frontend`      | `vayada-booking-admin-service`       | `admin.booking.vayada.com` |
| PMS API               | `vayada-pms-backend`                 | `vayada-pms-backend-service`         | `pms-api.vayada.com`       |
| PMS Web               | `vayada-pms-frontend`                | `vayada-pms-frontend-service`        | `pms.vayada.com`           |
| Marketplace API       | `vayada-creator-marketplace-backend` | `vayada-marketplace-backend-service` | `api.vayada.com`           |
| Marketplace Admin     | `vayada-admin-frontend`              | `vayada-marketplace-admin-service`   | (internal)                 |
| Affiliate Dashboard   | `vayada-affiliate-dashboard`         | `vayada-affiliate-dashboard-service` | `affiliate.vayada.com`     |
| TypeScript Target API | `vayada-api`                         | `vayada-api-service`                 | `target-api.vayada.com`    |
| Next TypeScript API   | `vayada-api`                         | `vayada-next-api-service`            | `next-api.vayada.com`      |
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

Before merging VAY-858 through VAY-862 platform changes, review
`infra/alb.tf`, `infra/route53.tf`, `infra/cloudflare.tf`, and `infra/ecs.tf`
with `terraform plan`. The plan must not repoint any existing production
hostname above to a `next-*` target group, Cloudflare record, Route 53 record,
or next-stack ECS environment.

Stripe, Xendit, and Channex dashboard/webhook endpoints also stay on the
current legacy Python production paths until an explicit provider cutover
window. Do not move provider callbacks to `next-api.vayada.com` during
next-stack validation; preserve the currently exported dashboard URLs, such as
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
When Terraform registers a newer `vayada-next-api` task definition, `tf-apply.yml`
deploys that latest next-api task definition with the service's current
container image. This rolls forward secret/config changes without replacing the
currently deployed app image.

The TypeScript Target API is intentionally separate from the legacy Booking,
PMS, and Marketplace APIs. It is exposed at `target-api.vayada.com` and defaults
to `target_backend_desired_count = 0` until an image has been published and the
runtime is intentionally enabled for rehearsal or cutover. Enabling it does not
repoint any legacy production traffic. The initial runtime is suitable for
health checks and observe-only provider webhook rehearsal. WorkOS-authenticated
product traffic must not be enabled until the full WorkOS runtime configuration
is managed in SSM and added to the task definition together.

Safe activation order:

1. Apply platform Terraform with `target_backend_desired_count = 0` to create
   the `vayada-api` ECR repository, target group, DNS, task definition, and ECS
   service without starting tasks before an image exists.
2. Merge or manually dispatch the app repo TypeScript API deploy workflow so it
   publishes `vayada-api:<git-sha>` and updates the `vayada-api-service` task
   definition.
3. Set `target_backend_desired_count = 1` and apply platform Terraform to start
   the target runtime on `target-api.vayada.com`. If the four
   `/vayada/staging/*` target secrets already exist outside this apply, also set
   `target_backend_staging_secrets_preprovisioned = true`; otherwise enable
   `manage_staging_rehearsal_secrets` and provide the matching values.
   In GitHub Actions, these map to repository secrets
   `TF_VAR_TARGET_BACKEND_DESIRED_COUNT` and
   `TF_VAR_TARGET_BACKEND_STAGING_SECRETS_PREPROVISIONED`.

The parallel Next TypeScript API at `next-api.vayada.com` is separate from the
C1 rehearsal runtime above. It reads production-owned target runtime secrets
from `/vayada/prod/*`, not `/vayada/staging/*`, while old production hostnames
continue to use their existing routing.

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
| `/vayada/prod/workos-webhook-secret`  | `next-api`                         |
| `/vayada/prod/auth-cookie-secret`     | `next-api`                         |
| `/vayada/prod/openai-api-key`         | `next-api` when `ASK_INTELLIGENCE_PROVIDER=openai` |

The `next-api` task maps those SSM parameters to the backend's runtime
environment as:

| Backend env var | SSM parameter or Terraform variable |
| --- | --- |
| `TARGET_DATABASE_URL` | `/vayada/prod/target-database-url` |
| `AUTH_DATABASE_URL` | `/vayada/prod/target-database-url` |
| `WORKOS_API_KEY` | `/vayada/prod/workos-api-key` |
| `WORKOS_WEBHOOK_SECRET` | `/vayada/prod/workos-webhook-secret` |
| `AUTH_COOKIE_SECRET` | `/vayada/prod/auth-cookie-secret` |
| `STRIPE_WEBHOOK_SECRET` | `/vayada/prod/stripe-webhook-secret` |
| `WORKOS_CLIENT_ID`, `WORKOS_AUDIENCE`, `WORKOS_ISSUER`, `WORKOS_JWKS_URL` | Terraform variables from matching GitHub Actions secrets |
| `ASK_INTELLIGENCE_PROVIDER`, `ASK_INTELLIGENCE_MODEL`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT` | Terraform variables from matching GitHub Actions secrets |
| `OPENAI_API_KEY` | `/vayada/prod/openai-api-key` when `ASK_INTELLIGENCE_PROVIDER=openai` |

Set the required GitHub Actions repository secrets before merging or applying a
live `next-api` task definition: `TF_VAR_TARGET_DATABASE_URL`,
`TF_VAR_WORKOS_API_KEY`, `TF_VAR_WORKOS_WEBHOOK_SECRET`,
`TF_VAR_WORKOS_CLIENT_ID`, `TF_VAR_WORKOS_AUDIENCE`,
`TF_VAR_WORKOS_ISSUER`, `TF_VAR_WORKOS_JWKS_URL`,
`TF_VAR_AUTH_COOKIE_SECRET`, and `TF_VAR_ASK_INTELLIGENCE_PROVIDER` if
overriding the default fixture Ask provider. When enabling
`ASK_INTELLIGENCE_PROVIDER=openai`, also set `TF_VAR_OPENAI_API_KEY` and
`TF_VAR_ASK_INTELLIGENCE_MODEL`. Optional OpenAI routing fields are
`TF_VAR_OPENAI_BASE_URL`, `TF_VAR_OPENAI_ORGANIZATION`, and
`TF_VAR_OPENAI_PROJECT`.

Xendit and Channex callback/API secrets remain outside the parallel next-stack
task definition while provider dashboard callbacks stay on legacy Python
production hostnames. Add production-owned `/vayada/prod/*` names for those
providers in the explicit provider cutover ticket that first routes their
traffic to `next-api.vayada.com`.

The TypeScript Target API at `target-api.vayada.com` additionally reads
rehearsal-scoped provider and target database secrets from `/vayada/staging/*`
while it is used for C1 observe-only rehearsal.

SSM parameters are referenced by ARN in ECS task definitions — containers read them at startup via the `ecsTaskExecutionRole`.

### C1 staging rehearsal secrets

The Channex/webhook cutover rehearsal uses a separate SSM namespace so replay
credentials do not get mixed with production runtime secrets:

| Parameter                                | Used by                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `/vayada/staging/target-database-url`    | `TARGET_DATABASE_URL` for target parity and C1 rehearsal dashboard checks       |
| `/vayada/staging/pms-database-url`       | `DATABASE_URL` for the frozen staging PMS backend runtime                       |
| `/vayada/staging/stripe-webhook-secret`  | `STRIPE_WEBHOOK_SECRET` for signing Stripe replay fixtures                      |
| `/vayada/staging/xendit-webhook-secret`  | `XENDIT_WEBHOOK_SECRET` / `x-callback-token` for Xendit replay fixtures         |
| `/vayada/staging/channex-webhook-secret` | `CHANNEX_WEBHOOK_SECRET` / `x-vayada-webhook-token` for Channex replay fixtures |

Terraform creates the replay parameters when `manage_staging_rehearsal_secrets`
is enabled and all matching variables are set:

```hcl
manage_staging_rehearsal_secrets    = true
staging_rehearsal_secret_owner      = "platform-runtime"
staging_rehearsal_secret_expires_at = "2026-06-30T18:00:00Z"
staging_target_database_url         = "..."
staging_stripe_webhook_secret       = "..."
staging_xendit_webhook_secret       = "..."
staging_channex_webhook_secret      = "..."
```

Do not commit the real values. The default rehearsal path is the one-off ECS
runner below so app repo CI does not need access to these secrets.

### C1 one-off rehearsal runner

Terraform registers task definition `vayada-c1-rehearsal-runner`. It is not an
ECS service and only runs when an operator starts it with `aws ecs run-task`.
The task uses the `vayada-api:next-latest` image, injects the four
`/vayada/staging/*` parameters through ECS `secrets`, and writes logs to
CloudWatch log group `/ecs/vayada-c1-rehearsal-runner`.
Operator IAM should allow `ecs:RunTask` only for this task definition and
`iam:PassRole` only for its execution role. Do not grant app repo CI access to
the `/vayada/staging/*` parameters or the runner execution role.

The default command runs the compiled dashboard checker without printing
secrets:

```bash
node packages/backend-migration/dist/cli/c1RehearsalChecks.js \
  --lookback-minutes 1440 \
  --pretty
```

Run the default dashboard check:

```bash
cd infra

TASK_DEFINITION="$(terraform output -raw c1_rehearsal_runner_task_definition)"
SECURITY_GROUP="$(terraform output -raw ecs_security_group_id)"

aws ecs run-task \
  --region eu-west-1 \
  --cluster vayada-backend-cluster \
  --launch-type FARGATE \
  --task-definition "$TASK_DEFINITION" \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-0cebe0311f380e8e6,subnet-0f5978ad929071531],securityGroups=[$SECURITY_GROUP],assignPublicIp=ENABLED}"
```

Provider replay uses the same task and must keep the exact-host allowlist at
`target-api.vayada.com`. The task definition sets:

```text
C1_REHEARSAL_WEBHOOK_BASE_URL=https://target-api.vayada.com
C1_REHEARSAL_ALLOW_SEND_TO_HOST=target-api.vayada.com
```

Run `--list` or a no-send dry run before any send:

```bash
cat >/tmp/c1-replay-overrides.json <<'JSON'
{
  "containerOverrides": [
    {
      "name": "vayada-c1-rehearsal-runner",
      "command": [
        "node",
        "scripts/c1-rehearsal-replay-fixtures.mjs",
        "--all",
        "--base-url",
        "https://target-api.vayada.com"
      ]
    }
  ]
}
JSON

aws ecs run-task \
  --region eu-west-1 \
  --cluster vayada-backend-cluster \
  --launch-type FARGATE \
  --task-definition "$TASK_DEFINITION" \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-0cebe0311f380e8e6,subnet-0f5978ad929071531],securityGroups=[$SECURITY_GROUP],assignPublicIp=ENABLED}" \
  --overrides file:///tmp/c1-replay-overrides.json
```

Only after the dry run is clean, add `--twice` and `--send` to the override
command. The replay script refuses non-local sends unless
`C1_REHEARSAL_ALLOW_SEND_TO_HOST` matches the base URL hostname exactly, and the
runbook keeps that value set to `target-api.vayada.com`.

Read the log stream without exposing secret values:

```bash
aws logs tail /ecs/vayada-c1-rehearsal-runner \
  --region eu-west-1 \
  --since 30m \
  --format short
```

### C1 staging rehearsal secret cleanup

VAY-794 is not complete until the rehearsal operator has either rotated or
deleted the provider replay secrets and recorded the parameter names, versions,
operator, and cleanup timestamp without secret values.

Normal deletion path after the rehearsal window:

```bash
cd infra
terraform plan -out=tfplan \
  -var='manage_staging_rehearsal_secrets=false' \
  -var='enable_staging_pms_runtime=false'
terraform apply tfplan
```

Normal rotation path for a follow-up rehearsal:

```bash
export TF_VAR_staging_stripe_webhook_secret="$STRIPE_WEBHOOK_SECRET_ROTATED"
export TF_VAR_staging_xendit_webhook_secret="$XENDIT_WEBHOOK_SECRET_ROTATED"
export TF_VAR_staging_channex_webhook_secret="$CHANNEX_WEBHOOK_SECRET_ROTATED"
export TF_VAR_staging_rehearsal_secret_expires_at="$REHEARSAL_SECRET_EXPIRES_AT"

cd infra
terraform plan -out=tfplan -var='manage_staging_rehearsal_secrets=true'
terraform apply tfplan

unset TF_VAR_staging_stripe_webhook_secret
unset TF_VAR_staging_xendit_webhook_secret
unset TF_VAR_staging_channex_webhook_secret
unset TF_VAR_staging_rehearsal_secret_expires_at
```

Keep the existing `staging_target_database_url` supplied through secure
`tfvars` or `TF_VAR_staging_target_database_url`; do not print it.

Emergency provider-secret deletion if Terraform cannot run:

```bash
for name in stripe-webhook-secret xendit-webhook-secret channex-webhook-secret; do
  aws ssm delete-parameter --region eu-west-1 --name "/vayada/staging/${name}"
done
```

### Frozen staging PMS runtime

The C1 rehearsal can create a dedicated staging PMS backend runtime for the
legacy scheduler-freeze proof. It is disabled by default and is controlled by:

```hcl
enable_staging_pms_runtime = true
staging_pms_database_url   = "..."
```

When enabled, Terraform creates:

- `/vayada/staging/pms-database-url`;
- ECS task definition/service `vayada-staging-pms-backend`;
- target group `staging-pms-backend-tg`;
- ALB listener rule and Route 53 alias for
  `https://staging-pms-api.vayada.com`;
- CloudWatch log group `/ecs/vayada-staging-pms-backend`.

The service uses the PMS backend image repository and starts with the legacy
scheduler frozen and legacy provider webhook modes set to
`ack_only_with_receipt`. Capture `https://staging-pms-api.vayada.com/health`
for the VAY-794 freeze evidence before inserting scheduler-freeze rows into the
target database.

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
These exist so `pms.vayada.com` and the legacy API hostnames can stay on the
known-good production rollback while the TypeScript backend and PMS frontend are
tested at `next-api.vayada.com` and `next-pms.vayada.com`.

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
