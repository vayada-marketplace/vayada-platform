locals {
  rds_admin_rotation_policy_name = "vayada-rds-admin-rotation"
  rds_admin_rotation_policy_arn  = "arn:aws:iam::${var.aws_account_id}:policy/${local.rds_admin_rotation_policy_name}"
}

data "aws_iam_policy_document" "rds_admin_rotation" {
  statement {
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [local.rds_admin_rotation_policy_arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["rds:DescribeDBInstances"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["rds:ModifyDBInstance"]
    resources = ["arn:aws:rds:${var.aws_region}:${var.aws_account_id}:db:vayada-database"]
  }
}

resource "aws_iam_policy" "rds_admin_rotation" {
  name        = local.rds_admin_rotation_policy_name
  description = "Scoped permission for the reviewed RDS administrator rotation workflow"
  policy      = data.aws_iam_policy_document.rds_admin_rotation.json

  tags = {
    Project     = "vayada"
    Environment = "production"
    Purpose     = "VAY-2038-rds-admin-rotation"
  }
}

resource "aws_iam_role_policy_attachment" "rds_admin_rotation" {
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.rds_admin_rotation.arn
}

import {
  to = aws_iam_policy.rds_admin_rotation
  id = "arn:aws:iam::269416271598:policy/vayada-rds-admin-rotation"
}

import {
  to = aws_iam_role_policy_attachment.rds_admin_rotation
  id = "vayada-github-actions-platform-deploy/arn:aws:iam::269416271598:policy/vayada-rds-admin-rotation"
}
