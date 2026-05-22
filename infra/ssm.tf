# SSM Parameter Store — encrypted secrets for ECS services

resource "aws_ssm_parameter" "secrets" {
  for_each = {
    # Database connection URLs
    "db-booking-url"     = "postgresql://vayada_booking_user:${var.db_booking_password}@${var.rds_endpoint}:5432/vayada_booking_db"
    "db-auth-url"        = "postgresql://vayada_auth_user:${var.db_auth_password}@${var.rds_endpoint}:5432/vayada_auth_db"
    "db-pms-url"         = "postgresql://vayada_pms_user:${var.db_pms_password}@${var.rds_endpoint}:5432/vayada_pms_db"
    "db-marketplace-url" = "postgresql://vayada_admin:${var.db_master_password}@${var.rds_endpoint}:5432/postgres?sslmode=require"
    "db-auth-url-ssl"    = "postgresql://vayada_auth_user:${var.db_auth_password}@${var.rds_endpoint}:5432/vayada_auth_db?sslmode=require"
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

  name  = "/vayada/prod/${each.key}"
  type  = "SecureString"
  value = each.value

  tags = {
    Project     = "vayada"
    Environment = "production"
    ManagedBy   = "terraform"
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
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
      },
    ]
  })
}
