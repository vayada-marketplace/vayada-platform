# vayada-platform

Platform infrastructure for Vayada — Terraform, cloud environments, and deployment CI.

## What this repo owns

- AWS infrastructure (ECS, ECR, ALB, RDS, Route53, S3, SSM, CloudWatch, ACM) via Terraform
- Production and preview environment configuration
- Platform CI: infrastructure validation, planning, and apply
- Deployment CI: receives app image artifacts and deploys to ECS
- Secrets references and SSM parameter management
- Domain and networking configuration

## What this repo does not own

Application code, Docker builds, migrations, local development setup, and product feature code live in [`vayada`](https://github.com/FlamurMaliqi/vayada).

## Boundary rules

- This repo consumes deployable image artifacts produced by the app repo — it does not build them.
- Database schema migrations stay in the app repo.
- Runtime environment variable names are documented in the app repo; values and SSM references live here.
- ECR repository creation belongs here; image build and push belongs in app CI.

See the [App Artifact Contract](https://linear.app/vayadacom/document/app-artifact-contract-add468dbc00f) for the full interface definition between the two repos.

## Structure

```
infra/          Terraform for all AWS resources
.github/
  workflows/    Platform CI: tf-validate.yml, tf-plan.yml, tf-apply.yml, deploy.yml
docs/           Platform runbooks and environment documentation
```

## Local setup

```bash
cd infra
terraform init
terraform plan
```

Requires AWS credentials with appropriate permissions. See `infra/variables.tf` for required inputs.
