locals {
  target_database_preflight_deploy_policy_name = "vayada-target-database-runtime-preflight-deploy"
  target_database_preflight_deploy_policy_arn  = "arn:aws:iam::${var.aws_account_id}:policy/${local.target_database_preflight_deploy_policy_name}"
}

data "aws_iam_policy_document" "target_database_preflight_deploy" {
  statement {
    effect = "Allow"
    actions = [
      "ecs:CreateCluster",
      "ecs:DeleteCluster",
      "ecs:PutClusterCapacityProviders",
      "ecs:UpdateCluster",
      "ecs:UpdateClusterSettings",
    ]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/vayada-target-database-runtime-preflight",
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "ecs:ListTasks",
      "ecs:DescribeTasks",
    ]
    resources = ["*"]
  }

  statement {
    effect  = "Allow"
    actions = ["ecs:RunTask"]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-next-api-db-runtime-preflight:*",
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-finance-export-once:*",
    ]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values = [
        "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/vayada-target-database-runtime-preflight",
      ]
    }
  }

  statement {
    effect  = "Allow"
    actions = ["ecs:DeregisterTaskDefinition"]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-next-api-db-runtime-preflight:*",
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-finance-export-once:*",
    ]
  }

  statement {
    effect  = "Allow"
    actions = ["ecs:StopTask"]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task/vayada-target-database-runtime-preflight/*",
    ]
  }

  statement {
    effect  = "Allow"
    actions = ["logs:GetLogEvents"]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ecs/vayada-next-api:log-stream:*",
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [local.target_database_preflight_deploy_policy_arn]
  }
}

resource "aws_iam_policy" "target_database_preflight_deploy" {
  name        = local.target_database_preflight_deploy_policy_name
  description = "Scoped GitHub Actions permissions for the target database runtime preflight"
  policy      = data.aws_iam_policy_document.target_database_preflight_deploy.json
}

resource "aws_iam_role_policy_attachment" "target_database_preflight_deploy" {
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.target_database_preflight_deploy.arn
}

import {
  to = aws_iam_policy.target_database_preflight_deploy
  id = "arn:aws:iam::269416271598:policy/vayada-target-database-runtime-preflight-deploy"
}

import {
  to = aws_iam_role_policy_attachment.target_database_preflight_deploy
  id = "vayada-github-actions-platform-deploy/arn:aws:iam::269416271598:policy/vayada-target-database-runtime-preflight-deploy"
}
