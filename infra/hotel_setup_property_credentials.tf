# Separate property-command identities; never repurpose the creation service.
variable "enable_hotel_setup_property_credentials" {
  description = "Stage empty Financials setup secrets and unattached private ECS roles"
  type        = bool
  default     = false
}

# Actor-bound property_profile logins (VAY-965); no caller is admitted by this flag.
variable "enable_hotel_setup_profile_credentials" {
  description = "Allow the property task and protected bootstrap to use only property_profile native secrets"
  type        = bool
  default     = false
}

locals {
  # Exact native prefixes per purpose: property always, logo and profile only when separately staged.
  hotel_setup_property_native_secret_arns = concat([local.hotel_setup_property_secret_arn],
    var.enable_hotel_setup_logo_storage ? [local.hotel_setup_logo_secret_arn] : [],
  var.enable_hotel_setup_profile_credentials ? [local.hotel_setup_profile_secret_arn] : [])
  hotel_setup_property_secret_names = var.enable_hotel_setup_property_credentials ? {
    reader_database_url = "hotel-setup-command/prod/reader-database-url"
    internal_token      = "hotel-setup-command/prod/internal-token"
  } : {}
}

resource "aws_secretsmanager_secret" "hotel_setup_property" {
  depends_on = [aws_iam_role_policy_attachment.hotel_setup_platform_deploy]
  for_each   = local.hotel_setup_property_secret_names

  name        = each.value
  description = "Private property_commands setup ${each.key}; no value managed by Terraform"
  # VAY-2056 step 5: destroy schedules deletion with the stored recovery window; never force-delete.
  lifecycle {
    precondition {
      condition     = !var.enable_hotel_setup_credential_infrastructure || var.hotel_setup_command_mode == "property_creation"
      error_message = "Separate property credentials require the original credential identities to be off or reserved for property_creation."
    }
  }
}

resource "aws_iam_role" "hotel_setup_property_execution" {
  count = var.enable_hotel_setup_property_credentials ? 1 : 0

  name               = "vayada-hotel-setup-property-execution"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy" "hotel_setup_property_execution_secrets" {
  count = var.enable_hotel_setup_property_credentials ? 1 : 0

  name = "hotel-setup-property-exact-injected-secret-read"
  role = aws_iam_role.hotel_setup_property_execution[0].id
  policy = templatefile("${path.module}/hotel_setup_secret_read_policy.json.tftpl", {
    secret_arns = jsonencode([for secret in aws_secretsmanager_secret.hotel_setup_property : secret.arn])
  })
}

resource "aws_iam_role" "hotel_setup_property_task" {
  count = var.enable_hotel_setup_property_credentials ? 1 : 0

  name               = "vayada-hotel-setup-property-task"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy" "hotel_setup_property_native_secrets" {
  count = var.enable_hotel_setup_property_credentials ? 1 : 0

  name = "hotel-setup-property-native-secret-read"
  role = aws_iam_role.hotel_setup_property_task[0].id
  policy = templatefile("${path.module}/hotel_setup_secret_read_policy.json.tftpl", {
    secret_arns = jsonencode(local.hotel_setup_property_native_secret_arns)
  })
}
