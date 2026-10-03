# Staging only. Values, native DB logins and service launch require separate review.
variable "enable_hotel_setup_credential_infrastructure" {
  description = "Create empty hotel-setup secret containers and unattached ECS roles"
  type        = bool
  default     = false
}

locals {
  hotel_setup_secret_names = var.enable_hotel_setup_credential_infrastructure ? {
    reader_database_url = "hotel-setup-command/prod/reader-database-url"
    internal_token      = "hotel-setup-command/prod/internal-token"
  } : {}
  hotel_setup_property_secret_prefix = "hotel-setup-command/prod/property/"
  hotel_setup_property_secret_arn    = "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.hotel_setup_property_secret_prefix}vayada_next_hotel_setup_property_*"
  hotel_setup_role_trust = jsonencode({
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

resource "aws_secretsmanager_secret" "hotel_setup" {
  for_each = local.hotel_setup_secret_names

  name        = each.value
  description = "VAY-1092 private setup ${each.key}; no value managed by Terraform"
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "hotel_setup_execution" {
  count = var.enable_hotel_setup_credential_infrastructure ? 1 : 0

  name               = "vayada-hotel-setup-execution"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy" "hotel_setup_execution_secrets" {
  count = var.enable_hotel_setup_credential_infrastructure ? 1 : 0

  name = "hotel-setup-exact-injected-secret-read"
  role = aws_iam_role.hotel_setup_execution[0].id
  policy = templatefile("${path.module}/hotel_setup_secret_read_policy.json.tftpl", {
    secret_arns = jsonencode([for secret in aws_secretsmanager_secret.hotel_setup : secret.arn])
  })
}

resource "aws_iam_role" "hotel_setup_task" {
  count = var.enable_hotel_setup_credential_infrastructure ? 1 : 0

  name               = "vayada-hotel-setup-task"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy" "hotel_setup_property_secrets" {
  count = var.enable_hotel_setup_credential_infrastructure ? 1 : 0

  name = "hotel-setup-native-property-secret-read"
  role = aws_iam_role.hotel_setup_task[0].id
  policy = templatefile("${path.module}/hotel_setup_secret_read_policy.json.tftpl", {
    secret_arns = jsonencode([local.hotel_setup_property_secret_arn])
  })
}
