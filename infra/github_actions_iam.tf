import {
  to = aws_iam_role.github_actions_platform_deploy
  id = "vayada-github-actions-platform-deploy"
}

import {
  to = aws_iam_role_policy.github_actions_platform_deploy
  id = "vayada-github-actions-platform-deploy:vayada-platform-deploy-policy"
}

data "aws_iam_policy_document" "github_actions_platform_deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:vayada-marketplace/vayada-platform:*"]
    }
  }
}

resource "aws_iam_role" "github_actions_platform_deploy" {
  name                 = "vayada-github-actions-platform-deploy"
  description          = "GitHub Actions OIDC role for vayada-platform: Terraform apply and ECS deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_actions_platform_deploy_trust.json
  max_session_duration = 3600

  lifecycle {
    prevent_destroy = true
  }
}

data "aws_iam_policy_document" "github_actions_platform_deploy" {
  statement {
    effect = "Allow"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
      "ecs:UpdateService",
      "ecs:DescribeTaskSets",
      "ecs:DescribeClusters",
      "ecs:TagResource",
    ]
    resources = ["*"]
  }

  statement {
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/ecsTaskExecutionRole",
      "arn:aws:iam::${var.aws_account_id}:role/ecsTaskRole",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-next-api-media-task-role",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:CreateRepository",
      "ecr:DeleteRepository",
      "ecr:SetRepositoryPolicy",
      "ecr:TagResource",
      "ecr:ListTagsForResource",
      "ecr:GetLifecyclePolicy",
      "ecr:PutLifecyclePolicy",
      "ecr:DeleteLifecyclePolicy",
    ]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketVersioning",
      "s3:GetBucketPolicy",
      "s3:GetBucketAcl",
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:PutBucketVersioning",
      "s3:PutBucketAcl",
      "s3:PutBucketPolicy",
      "s3:GetEncryptionConfiguration",
      "s3:PutEncryptionConfiguration",
      "s3:GetBucketCORS",
      "s3:PutBucketCORS",
      "s3:GetBucketPublicAccessBlock",
      "s3:PutBucketPublicAccessBlock",
      "s3:GetBucketWebsite",
      "s3:GetAccelerateConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetBucketLogging",
      "s3:GetBucketTagging",
      "s3:GetBucketOwnershipControls",
      "s3:GetBucketNotification",
      "s3:GetReplicationConfiguration",
      "s3:GetBucketRequestPayment",
      "s3:GetBucketObjectLockConfiguration",
    ]
    resources = ["arn:aws:s3:::vayada-*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
    ]
    resources = [
      "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/vayada-terraform-lock",
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["elasticloadbalancing:*"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["acm:*"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["route53:*"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:DescribeLogGroups",
      "logs:ListTagsLogGroup",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    effect  = "Allow"
    actions = ["ssm:DescribeParameters"]
    resources = [
      "*",
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:PutParameter",
      "ssm:DeleteParameter",
      "ssm:ListTagsForResource",
      "ssm:AddTagsToResource",
    ]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/*",
      "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/staging/*",
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "ec2:DescribeSecurityGroups",
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:DescribeVpcs",
      "ec2:DescribeSubnets",
      "ec2:DescribeNetworkInterfaces",
      "ec2:CreateTags",
      "ec2:DeleteTags",
      "ec2:DescribeSecurityGroupRules",
    ]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:ListRolePolicies",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/ecsTaskExecutionRole",
      "arn:aws:iam::${var.aws_account_id}:role/ecsTaskRole",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-github-actions-platform-deploy",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-next-api-media-task-role",
    ]
  }

  statement {
    effect  = "Allow"
    actions = ["iam:PutRolePolicy"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/ecsTaskExecutionRole",
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectTagging",
      "s3:PutObjectTagging",
      "s3:DeleteObjectTagging",
    ]
    resources = ["arn:aws:s3:::vayada-*/*"]
  }
}

resource "aws_iam_role_policy" "github_actions_platform_deploy" {
  name   = "vayada-platform-deploy-policy"
  role   = aws_iam_role.github_actions_platform_deploy.id
  policy = data.aws_iam_policy_document.github_actions_platform_deploy.json

  lifecycle {
    prevent_destroy = true
  }
}
