# Hotel permissions use a managed policy because existing inline policies are
# already near the role-wide 10,240-byte limit. Permission scope is unchanged.
locals {
  hotel_setup_platform_deploy_enabled = var.enable_hotel_setup_credential_infrastructure || var.enable_hotel_setup_property_credentials || length(local.hotel_setup_caller_configured) > 0
  # The PR planner refreshes only the four staged containers, never their values.
  hotel_setup_plan_metadata_statements = jsondecode(length(local.hotel_setup_secret_names) + length(local.hotel_setup_property_secret_names) > 0 ? jsonencode({ Statement = [{
    Sid      = "HotelSetupSecretMetadata"
    Effect   = "Allow"
    Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"]
    Resource = concat([for secret in aws_secretsmanager_secret.hotel_setup : secret.arn], [for secret in aws_secretsmanager_secret.hotel_setup_property : secret.arn])
  }] }) : jsonencode({ Statement = [] })).Statement

}

data "aws_iam_policy_document" "hotel_setup_platform_deploy" {
  # Ordinary Terraform refresh reads only this installed policy's metadata.
  statement {
    effect    = "Allow"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags"]
    resources = ["arn:aws:iam::${var.aws_account_id}:policy/vayada-hotel-setup-platform-deploy"]
  }
  # IaC may stage only empty fixed reader/token containers; no secret-value read.
  dynamic "statement" {
    for_each = length(local.hotel_setup_secret_names) + length(local.hotel_setup_property_secret_names) > 0 ? [true] : []
    content {
      effect  = "Allow"
      actions = ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:TagResource", "secretsmanager:UntagResource"]
      resources = [for name in concat(values(local.hotel_setup_secret_names), values(local.hotel_setup_property_secret_names)) :
      "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${name}-??????"]
    }
  }

  statement {
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-creation-bootstrap",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-creation-reader-bootstrap",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-property-reader-bootstrap",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-property-bootstrap",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-logo-cleanup",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-property-bootstrap-execution",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-next-api-setup-caller-execution",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-execution",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-task",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-property-execution",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-hotel-setup-property-task",
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  # After the separate reviewed bootstrap, ordinary refresh needs metadata only.
  # This neither creates roles nor changes trust, policy contents or attachments.
  dynamic "statement" {
    for_each = var.enable_hotel_setup_credential_infrastructure || var.enable_hotel_setup_property_credentials || length(local.hotel_setup_caller_configured) > 0 ? [true] : []
    content {
      effect = "Allow"
      actions = [
        "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies", "iam:ListRoleTags",
      ]
      resources = [for name in [
        "vayada-hotel-setup-execution",
        "vayada-hotel-setup-task",
        "vayada-hotel-setup-creation-bootstrap",
        "vayada-hotel-setup-creation-reader-bootstrap",
        "vayada-hotel-setup-property-reader-bootstrap",
        "vayada-hotel-setup-property-bootstrap",
        "vayada-hotel-setup-logo-cleanup",
        "vayada-hotel-setup-property-bootstrap-execution",
        "vayada-hotel-setup-property-execution",
        "vayada-hotel-setup-property-task",
        "vayada-next-api-setup-caller-execution",
        "vayada-github-actions-hotel-setup-online",
      ] : "arn:aws:iam::${var.aws_account_id}:role/${name}"]
    }
  }

}

resource "aws_iam_policy" "hotel_setup_platform_deploy" {
  count  = local.hotel_setup_platform_deploy_enabled ? 1 : 0
  name   = "vayada-hotel-setup-platform-deploy"
  policy = data.aws_iam_policy_document.hotel_setup_platform_deploy.json
}

resource "aws_iam_role_policy_attachment" "hotel_setup_platform_deploy" {
  count      = local.hotel_setup_platform_deploy_enabled ? 1 : 0
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.hotel_setup_platform_deploy[0].arn
}
