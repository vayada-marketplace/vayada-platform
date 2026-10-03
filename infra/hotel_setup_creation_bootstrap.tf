# Operational one-off task only. Never attach this role to the private service.
locals {
  hotel_setup_creation_bootstrap_enabled = var.enable_hotel_setup_credential_infrastructure && var.hotel_setup_command_mode == "property_creation"
  hotel_setup_creation_bootstrap_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:CreateSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
      Resource = [local.hotel_setup_creation_secret_arn]
    }]
  })

}

resource "aws_iam_role" "hotel_setup_creation_bootstrap" {
  count = local.hotel_setup_creation_bootstrap_enabled ? 1 : 0

  name               = "vayada-hotel-setup-creation-bootstrap"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy" "hotel_setup_creation_bootstrap" {
  count = local.hotel_setup_creation_bootstrap_enabled ? 1 : 0

  name   = "creation-native-secret-bootstrap-only"
  role   = aws_iam_role.hotel_setup_creation_bootstrap[0].id
  policy = local.hotel_setup_creation_bootstrap_policy
}

# Reader bootstrap cannot read or write native organization credentials.
resource "aws_iam_role" "hotel_setup_creation_reader_bootstrap" {
  count = local.hotel_setup_creation_bootstrap_enabled ? 1 : 0

  name               = "vayada-hotel-setup-creation-reader-bootstrap"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy" "hotel_setup_creation_reader_bootstrap" {
  count = local.hotel_setup_creation_bootstrap_enabled ? 1 : 0

  name = "creation-reader-and-token-bootstrap-only"
  role = aws_iam_role.hotel_setup_creation_reader_bootstrap[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
      Resource = [for secret in aws_secretsmanager_secret.hotel_setup : secret.arn]
    }]
  })
}
