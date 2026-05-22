# AGENTS.md

Agent guide for the `vayada-platform` repository.

## What this repo is

Platform infrastructure for Vayada. Owns Terraform, deployment CI, and cloud environment configuration. Does not contain product application code.

See `README.md` for the full boundary definition.

## Key directories

| Path | Purpose |
|------|---------|
| `infra/` | Terraform for all AWS resources (ECS, ECR, ALB, RDS, Route53, S3, SSM, CloudWatch) |
| `.github/workflows/` | Platform CI workflows |
| `docs/` | Runbooks and environment documentation |

## Terraform

```bash
cd infra
terraform init
terraform validate
terraform plan
terraform apply
```

State is stored in S3. Never run `terraform apply` without a clean `terraform plan` first.

## CI workflows (to be added in VAY-423)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `tf-validate.yml` | PR | Validate and lint Terraform |
| `tf-plan.yml` | PR | Run terraform plan and post output |
| `tf-apply.yml` | Push to main | Apply infrastructure changes |
| `deploy.yml` | `repository_dispatch: app-image-published` | Deploy new app image to ECS |

## Deployment

Platform CI receives a `repository_dispatch` event from the app repo when a new image is published. It then updates the ECS task definition with the SHA-pinned image and deploys.

Do not manually trigger ECS deploys outside of this workflow during normal operations.

## What not to do

- Do not add product feature code or application business logic here.
- Do not run `terraform destroy` without explicit approval.
- Do not modify the ECS task definition directly in the AWS console — all changes go through CI.
