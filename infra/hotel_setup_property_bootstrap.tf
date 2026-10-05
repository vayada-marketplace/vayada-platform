# Operational one-off only; never attached to the property command service.
resource "aws_iam_role" "hotel_setup_property_bootstrap" {
  count              = var.enable_hotel_setup_property_credentials ? 1 : 0
  name               = "vayada-hotel-setup-property-bootstrap"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy" "hotel_setup_property_bootstrap" {
  count = var.enable_hotel_setup_property_credentials ? 1 : 0
  name  = "property-native-secret-bootstrap-only"
  role  = aws_iam_role.hotel_setup_property_bootstrap[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
      Resource = concat([local.hotel_setup_property_secret_arn], var.enable_hotel_setup_logo_storage ? [local.hotel_setup_logo_secret_arn] : [])
    }]
  })
}
