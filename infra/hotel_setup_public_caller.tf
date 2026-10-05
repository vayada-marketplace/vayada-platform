# Caller activation is separate from zero-task private service staging.
variable "hotel_setup_public_caller" {
  type    = object({ creation = string, property = string, logo = optional(string, "off") })
  default = { creation = "off", property = "off" }
  validation {
    condition     = alltrue([for state in values(var.hotel_setup_public_caller) : contains(["off", "hold", "blocked", "enabled"], state)])
    error_message = "Caller states are off (pre-cutover), hold (bootstrap), blocked (retained private pair) or enabled."
  }
}

locals {
  hotel_setup_caller_configured = { for purpose, state in var.hotel_setup_public_caller : purpose => state if contains(["blocked", "enabled"], state) }
  hotel_setup_caller_prefixes   = { creation = "HOTEL_SETUP_CREATION_COMMAND", property = "HOTEL_SETUP_COMMAND", logo = "HOTEL_SETUP_LOGO_COMMAND" }
  hotel_setup_caller_origins    = { creation = "https://hotel-setup-command.vayada.com", property = "https://hotel-setup-property-command.vayada.com", logo = "https://hotel-setup-property-command.vayada.com" }
  hotel_setup_caller_tokens = {
    creation = try(aws_secretsmanager_secret.hotel_setup["internal_token"].arn, "")
    property = try(aws_secretsmanager_secret.hotel_setup_property["internal_token"].arn, "")
    logo     = try(aws_secretsmanager_secret.hotel_setup_property["internal_token"].arn, "")
  }
  hotel_setup_caller_environment = concat(
    [for purpose, state in var.hotel_setup_public_caller : {
      name = "${local.hotel_setup_caller_prefixes[purpose]}_ADMISSION", value = state == "enabled" ? "enabled" : "blocked"
    } if state != "off"],
    [for purpose, state in local.hotel_setup_caller_configured : {
      name = "${local.hotel_setup_caller_prefixes[purpose]}_ORIGIN", value = local.hotel_setup_caller_origins[purpose]
    }],
  )
  hotel_setup_caller_secrets = [for purpose, state in local.hotel_setup_caller_configured : {
    name = "${local.hotel_setup_caller_prefixes[purpose]}_INTERNAL_TOKEN", valueFrom = local.hotel_setup_caller_tokens[purpose]
  }]
}

# Only the public API uses this execution identity; no native setup secret access.
resource "aws_iam_role" "hotel_setup_public_execution" {
  count = length(local.hotel_setup_caller_configured) > 0 ? 1 : 0

  name               = "vayada-next-api-setup-caller-execution"
  assume_role_policy = local.hotel_setup_role_trust
  lifecycle {
    precondition {
      condition = ((length(local.hotel_setup_caller_configured) == 0 || var.enable_hotel_setup_private_network) &&
        (!contains(keys(local.hotel_setup_caller_configured), "creation") || (var.enable_hotel_setup_credential_infrastructure && var.hotel_setup_command_mode == "property_creation")) &&
        (!contains(keys(local.hotel_setup_caller_configured), "property") || (var.enable_hotel_setup_property_credentials && var.enable_hotel_setup_property_network)) &&
        (!contains(keys(local.hotel_setup_caller_configured), "logo") || (var.enable_hotel_setup_property_credentials && var.enable_hotel_setup_property_network && var.enable_hotel_setup_logo_storage &&
      (var.hotel_setup_public_caller.logo != "enabled" || var.hotel_setup_logo_private_admission == "enabled"))))
      error_message = "Configured callers require their isolated credentials and network."
    }
  }
}
resource "aws_iam_role_policy_attachment" "hotel_setup_public_execution" {
  count      = length(local.hotel_setup_caller_configured) > 0 ? 1 : 0
  role       = aws_iam_role.hotel_setup_public_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "hotel_setup_public_execution" {
  count = length(local.hotel_setup_caller_configured) > 0 ? 1 : 0

  name = "public-api-existing-parameters-and-exact-setup-tokens"
  role = aws_iam_role.hotel_setup_public_execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ssm:GetParameters"], Resource = distinct([for secret in local.services["next-target-backend"].secrets : "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${secret.valueFrom}"]) },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = distinct([for secret in local.hotel_setup_caller_secrets : secret.valueFrom]) },
    ]
  })
}
