# Separate from the API service: the bounded runner has no direct S3 access.
# The reviewed app assumes the writer with an exact-key, deadline-bound session
# policy. Never put the resulting short-lived credentials into task definitions.
resource "aws_iam_role" "finance_export_once" {
  name = "vayada-finance-export-once"
  assume_role_policy = jsonencode({
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

resource "aws_iam_role" "finance_export_once_writer" {
  name = "vayada-finance-export-once-writer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.finance_export_once.arn }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "finance_export_once_assume_writer" {
  name = "assume-export-writer"
  role = aws_iam_role.finance_export_once.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = aws_iam_role.finance_export_once_writer.arn
    }]
  })
}

resource "aws_iam_role_policy" "finance_export_once_write" {
  name = "write-private-financials-export"
  role = aws_iam_role.finance_export_once_writer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "s3:PutObject"
      Resource = "${aws_s3_bucket.private_profile_media.arn}/private/finance/financials-exports/*"
    }]
  })
}

# A separate cluster keeps the existing shared role's preflight StopTask grant
# from reaching finance tasks. Shared callers receive no new finance permissions.
resource "aws_ecs_cluster" "finance_export_once" {
  name = "vayada-finance-export-once"
}

resource "aws_iam_role" "finance_export_controller" {
  name = "vayada-github-actions-finance-export"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com" }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = local.platform_mutation_subject
      } }
    }]
  })
}

resource "aws_iam_role_policy" "finance_export_controller" {
  name = "run-isolated-finance-export"
  role = aws_iam_role.finance_export_controller.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListTasks", "ecs:TagResource"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = "ecs:RegisterTaskDefinition"
        Resource = [
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-finance-export-once:*",
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-next-api-db-runtime-preflight:*"
        ]
      },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = [aws_iam_role.finance_export_once.arn, "arn:aws:iam::${var.aws_account_id}:role/ecsTaskExecutionRole"]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect    = "Allow"
        Action    = "ecs:RunTask"
        Resource  = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-finance-export-once:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.finance_export_once.arn } }
      },
      {
        Effect    = "Allow"
        Action    = "ecs:RunTask"
        Resource  = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-next-api-db-runtime-preflight:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.target_database_runtime_preflight.arn } }
      },
      {
        Effect = "Allow"
        Action = "ecs:DeregisterTaskDefinition"
        Resource = [
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-finance-export-once:*",
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-next-api-db-runtime-preflight:*"
        ]
      },
      {
        Effect = "Allow"
        Action = "ecs:StopTask"
        Resource = [
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task/vayada-finance-export-once/*",
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task/vayada-target-database-runtime-preflight/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = "logs:GetLogEvents"
        Resource = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ecs/vayada-next-api:log-stream:*"
      }
    ]
  })
}

# Installed by the authorized bootstrap principal. The shared apply role can
# refresh these resources but cannot create/change the finance roles or run them.
# Explicit denies also close its existing wildcard ECS registration/service paths.
resource "aws_iam_policy" "finance_export_refresh" {
  name = "vayada-finance-export-refresh"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRoleTags"]
        Resource = [aws_iam_role.finance_export_once.arn, aws_iam_role.finance_export_once_writer.arn, aws_iam_role.finance_export_controller.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]
        Resource = "arn:aws:iam::${var.aws_account_id}:policy/vayada-finance-export-refresh"
      },
      {
        Effect   = "Deny"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:RunTask", "ecs:StartTask", "ecs:DeregisterTaskDefinition", "ecs:DeleteTaskDefinitions"]
        Resource = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-finance-export-once:*"
      },
      {
        Effect   = "Deny"
        Action   = ["ecs:StopTask", "ecs:ExecuteCommand"]
        Resource = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task/vayada-finance-export-once/*"
      },
      {
        Effect    = "Deny"
        Action    = ["ecs:CreateService", "ecs:UpdateService", "ecs:CreateTaskSet"]
        Resource  = "*"
        Condition = { ArnLike = { "ecs:task-definition" = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-finance-export-once:*" } }
      },
      {
        Effect   = "Deny"
        Action   = "iam:PassRole"
        Resource = [aws_iam_role.finance_export_once.arn, aws_iam_role.finance_export_once_writer.arn]
      },
      {
        Effect   = "Allow"
        Action   = "ecs:ListTagsForResource"
        Resource = aws_ecs_cluster.finance_export_once.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "finance_export_refresh" {
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.finance_export_refresh.arn
}
