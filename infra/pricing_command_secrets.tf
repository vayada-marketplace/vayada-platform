# Empty secret containers only. A separate reviewed bootstrap supplies values after
# the database roles and their property-scoped grants pass the actual-role preflight.
variable "enable_pricing_command_metadata_refresh" {
  description = "Enable only after the seven empty pricing resources exist and a separate operator plan is reviewed"
  type        = bool
  default     = false
}

locals {
  pricing_command_secret_names = {
    identity_read  = "pricing-command/prod/identity-read-database-url"
    owner_read     = "pricing-command/prod/owner-read-database-url"
    owner_manage   = "pricing-command/prod/owner-manage-database-url"
    public         = "pricing-command/prod/public-database-url"
    internal_token = "pricing-command/prod/internal-token"
  }
  pricing_command_metadata_statements = jsondecode(var.enable_pricing_command_metadata_refresh ? templatefile("${path.module}/pricing_command_metadata_policy.json.tftpl", {
    secret_arns = jsonencode([for secret in aws_secretsmanager_secret.pricing_command : secret.arn])
    role_arn    = jsonencode(aws_iam_role.pricing_command_execution.arn)
  }) : jsonencode({ Statement = [] })).Statement
}

resource "aws_secretsmanager_secret" "pricing_command" {
  for_each = local.pricing_command_secret_names

  name        = each.value
  description = "VAY-1543 isolated pricing command ${each.key}; no value managed by Terraform"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Project     = "vayada"
    Environment = "production"
    Purpose     = "pricing-command-${each.key}"
  }
}

# Deliberately not assigned to a task definition or permitted by the current
# deployment roles. Service launch and PassRole require a separate reviewed PR.
resource "aws_iam_role" "pricing_command_execution" {
  name        = "vayada-pricing-command-execution"
  description = "ECS execution role for exact pricing-command secrets only"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "pricing_command_secrets" {
  name = "pricing-command-exact-secret-read"
  role = aws_iam_role.pricing_command_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [for secret in aws_secretsmanager_secret.pricing_command : secret.arn]
    }]
  })
}
