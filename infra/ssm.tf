# SSM Parameter Store — encrypted secrets for ECS services

locals {
  prod_core_ssm_secrets = {
    # Database connection URLs
    "db-booking-url"     = "postgresql://vayada_booking_user:${var.db_booking_password}@${var.rds_endpoint}:5432/vayada_booking_db"
    "db-auth-url"        = "postgresql://vayada_auth_user:${var.db_auth_password}@${var.rds_endpoint}:5432/vayada_auth_db"
    "db-pms-url"         = "postgresql://vayada_pms_user:${var.db_pms_password}@${var.rds_endpoint}:5432/vayada_pms_db"
    "db-marketplace-url" = "postgresql://vayada_admin:${var.db_master_password}@${var.rds_endpoint}:5432/postgres?sslmode=require"
    "db-auth-url-ssl"    = "postgresql://vayada_auth_user:${var.db_auth_password}@${var.rds_endpoint}:5432/vayada_auth_db?sslmode=require&uselibpqcompat=true"
    "db-pms-url-ssl"     = "postgresql://vayada_pms_user:${var.db_pms_password}@${var.rds_endpoint}:5432/vayada_pms_db?sslmode=require"

    # Application secrets
    "jwt-secret-key"        = var.jwt_secret_key
    "smtp-username"         = var.smtp_username
    "smtp-password"         = var.smtp_password
    "stripe-secret-key"     = var.stripe_secret_key
    "stripe-webhook-secret" = var.stripe_webhook_secret
    "cloudflare-api-token"  = var.cloudflare_api_token
    "channex-api-key"       = var.channex_api_key
    "anthropic-api-key"     = var.anthropic_api_key
    "firecrawl-api-key"     = var.firecrawl_api_key
  }

  prod_target_cutover_ssm_secrets = var.target_backend_production_cutover_enabled ? {
    "workos-api-key"     = var.workos_api_key
    "auth-cookie-secret" = var.auth_cookie_secret
  } : {}

  prod_ssm_secrets = merge(local.prod_core_ssm_secrets, local.prod_target_cutover_ssm_secrets)

  staging_rehearsal_ssm_secrets = {
    "target-database-url"    = var.staging_target_database_url
    "stripe-webhook-secret"  = var.staging_stripe_webhook_secret
    "xendit-webhook-secret"  = var.staging_xendit_webhook_secret
    "channex-webhook-secret" = var.staging_channex_webhook_secret
  }

  staging_pms_runtime_ssm_secrets = var.enable_staging_pms_runtime ? {
    "pms-database-url" = var.staging_pms_database_url
  } : {}

  staging_ssm_secrets = merge(
    var.manage_staging_rehearsal_secrets ? local.staging_rehearsal_ssm_secrets : {},
    local.staging_pms_runtime_ssm_secrets,
  )

  staging_ssm_parameter_arns = [
    for name in sort(keys(local.staging_ssm_secrets)) :
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/staging/${name}"
  ]

  target_backend_ssm_parameter_arns = [
    for secret in local.base_services["target-backend"].secrets :
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${secret.valueFrom}"
  ]
}

resource "aws_ssm_parameter" "secrets" {
  for_each = local.prod_ssm_secrets

  name  = "/vayada/prod/${each.key}"
  type  = "SecureString"
  value = each.value

  tags = {
    Project     = "vayada"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}

resource "aws_ssm_parameter" "staging_rehearsal_secrets" {
  for_each = toset(keys(local.staging_ssm_secrets))

  name  = "/vayada/staging/${each.key}"
  type  = "SecureString"
  value = local.staging_ssm_secrets[each.key]

  tags = {
    Project     = "vayada"
    Environment = "staging"
    ManagedBy   = "terraform"
    Purpose     = "c1-rehearsal"
  }

  lifecycle {
    precondition {
      condition     = trimspace(local.staging_ssm_secrets[each.key]) != ""
      error_message = "All enabled staging secret variables must be non-empty."
    }
  }
}

# Allow ECS task execution role to read SSM parameters
resource "aws_iam_role_policy" "ecs_exec_ssm" {
  name = "ecs-ssm-secrets-access"
  role = data.aws_iam_role.ecs_task_execution.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
          "ssm:GetParameter",
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
          "ssm:GetParameter",
        ]
        Resource = distinct(concat(local.staging_ssm_parameter_arns, local.target_backend_ssm_parameter_arns))
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
      },
    ]
  })
}
