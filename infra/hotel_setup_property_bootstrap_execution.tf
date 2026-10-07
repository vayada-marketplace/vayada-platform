# ECS injection identity only; the operational SDK task role cannot fetch SSM.
resource "aws_iam_role" "hotel_setup_property_bootstrap_execution" {
  count              = var.enable_hotel_setup_property_credentials ? 1 : 0
  name               = "vayada-hotel-setup-property-bootstrap-execution"
  assume_role_policy = local.hotel_setup_role_trust
}

resource "aws_iam_role_policy_attachment" "hotel_setup_property_bootstrap_execution" {
  count      = var.enable_hotel_setup_property_credentials ? 1 : 0
  role       = aws_iam_role.hotel_setup_property_bootstrap_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "hotel_setup_property_bootstrap_owner_parameter" {
  count = var.enable_hotel_setup_property_credentials ? 1 : 0
  name  = "property-bootstrap-owner-injection-only"
  role  = aws_iam_role.hotel_setup_property_bootstrap_execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["ssm:GetParameters"]
      Resource = [
        "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/db-marketplace-url",
        "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/target-database-url",
      ]
    }]
  })
}
