# VAY-1362: protected one-off production runner for the legacy migration CLIs.
# Inert: only the reviewed workflow on main, approved on platform-mutations-v2,
# can start it, and only with a reviewed run file. An authorized operator
# installs it; the shared apply role may only refresh it.
# See docs/legacy-migration-runner.md.

locals {
  legacy_migration_runner      = "vayada-legacy-migration-runner"
  legacy_migration_runner_pin  = jsondecode(file("${path.module}/../deployment/legacy-migration-runner.json"))
  legacy_migration_runner_code = file("${path.module}/../scripts/legacy-migration-runner.mjs")
  legacy_migration_target_url  = "/vayada/prod/target-database-url"
  # Created for the go-day restore of the frozen legacy databases; absent until then.
  legacy_migration_source_urls = {
    for database in ["auth", "booking", "marketplace", "pms"] :
    "${upper(database)}_SOURCE_DATABASE_URL" => "/vayada/prod/legacy-migration-source-${database}-url"
  }
  legacy_migration_runner_kinds = {
    # migration-status and abort read or mark only the target run ledger.
    target = { secrets = { TARGET_DATABASE_URL = local.legacy_migration_target_url }, environment = [] }
    # extract and cutover also read the frozen sources and import media. The cutover
    # dry-run needs a preprod target and stays out of this production runner.
    source = {
      secrets = merge({ TARGET_DATABASE_URL = local.legacy_migration_target_url }, local.legacy_migration_source_urls)
      environment = [
        { name = "PLATFORM_MEDIA_BUCKET", value = aws_s3_bucket.private_profile_media.id },
        { name = "PLATFORM_MEDIA_CDN_BASE_URL", value = local.private_profile_media_cdn_base_url },
        { name = "LEGACY_PMS_MEDIA_BUCKET", value = "vayada-uploads-prod" },
        { name = "LEGACY_MEDIA_BUCKET_ALLOWLIST", value = "vayada-uploads-prod,vayada-creator-marketplace-images" },
      ]
    }
  }
  legacy_migration_runner_family_arn = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/${local.legacy_migration_runner}-*"
  legacy_migration_ecs_trust = jsonencode({
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

# A separate cluster keeps the shared role's preflight StopTask grant away from migration tasks.
resource "aws_ecs_cluster" "legacy_migration_runner" {
  name = local.legacy_migration_runner
}

resource "aws_cloudwatch_log_group" "legacy_migration_runner" {
  name              = "/ecs/${local.legacy_migration_runner}"
  retention_in_days = 365
}

resource "aws_iam_role" "legacy_migration_runner_execution" {
  name               = "${local.legacy_migration_runner}-execution"
  assume_role_policy = local.legacy_migration_ecs_trust
}

resource "aws_iam_role_policy_attachment" "legacy_migration_runner_execution" {
  role       = aws_iam_role.legacy_migration_runner_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "legacy_migration_runner_execution" {
  name = "exact-migration-parameters"
  role = aws_iam_role.legacy_migration_runner_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ssm:GetParameters"
      Resource = [for parameter in values(local.legacy_migration_runner_kinds.source.secrets) : "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${parameter}"]
    }]
  })
}

# Only source tasks get this role: legacy media reads and platform media imports.
resource "aws_iam_role" "legacy_migration_runner_task" {
  name               = "${local.legacy_migration_runner}-task"
  assume_role_policy = local.legacy_migration_ecs_trust
}

resource "aws_iam_role_policy" "legacy_migration_runner_task" {
  name = "legacy-media-import"
  role = aws_iam_role.legacy_migration_runner_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          "arn:aws:s3:::vayada-uploads-prod/creators/*",
          "arn:aws:s3:::vayada-uploads-prod/hotels/*",
          "arn:aws:s3:::vayada-uploads-prod/listings/*",
          "arn:aws:s3:::vayada-creator-marketplace-images/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.private_profile_media.arn}/public/media/*", "${aws_s3_bucket.private_profile_media.arn}/private/media/*"]
      },
    ]
  })
}

resource "aws_ecs_task_definition" "legacy_migration_runner" {
  for_each = local.legacy_migration_runner_kinds

  family                   = "${local.legacy_migration_runner}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 1024
  memory                   = 4096
  execution_role_arn       = aws_iam_role.legacy_migration_runner_execution.arn
  task_role_arn            = each.key == "source" ? aws_iam_role.legacy_migration_runner_task.arn : null

  container_definitions = jsonencode([{
    name        = local.legacy_migration_runner
    image       = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/vayada-next-api@${local.legacy_migration_runner_pin.image_digest}"
    essential   = true
    command     = ["node", "--input-type=module", "--eval", local.legacy_migration_runner_code, each.key]
    environment = concat([{ name = "AWS_REGION", value = var.aws_region }], each.value.environment)
    secrets = [for name, parameter in each.value.secrets : {
      name      = name
      valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${parameter}"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.legacy_migration_runner.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = can(regex("^[0-9a-f]{40}$", local.legacy_migration_runner_pin.source_sha)) && can(regex("^sha256:[0-9a-f]{64}$", local.legacy_migration_runner_pin.image_digest))
      error_message = "deployment/legacy-migration-runner.json must pin a full source SHA and an image digest."
    }
  }
}

# Assumable only by workflows approved on the protected platform-mutations-v2 environment.
resource "aws_iam_role" "legacy_migration_runner_controller" {
  name                 = "vayada-github-actions-legacy-migration-runner"
  max_session_duration = 14400
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

resource "aws_iam_role_policy" "legacy_migration_runner_controller" {
  name = "run-legacy-migration-task"
  role = aws_iam_role.legacy_migration_runner_controller.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListTasks"]
        Resource = "*"
      },
      {
        Effect    = "Allow"
        Action    = "ecs:RunTask"
        Resource  = "${local.legacy_migration_runner_family_arn}:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.legacy_migration_runner.arn } }
      },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = [aws_iam_role.legacy_migration_runner_execution.arn, aws_iam_role.legacy_migration_runner_task.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect   = "Allow"
        Action   = "logs:GetLogEvents"
        Resource = "${aws_cloudwatch_log_group.legacy_migration_runner.arn}:log-stream:*"
      },
    ]
  })
}

# Installed by the authorized operator with the runner. The shared apply role can
# refresh these resources but cannot change, pass or run them.
resource "aws_iam_policy" "legacy_migration_runner_refresh" {
  name = "${local.legacy_migration_runner}-refresh"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRoleTags"]
        Resource = [aws_iam_role.legacy_migration_runner_execution.arn, aws_iam_role.legacy_migration_runner_task.arn, aws_iam_role.legacy_migration_runner_controller.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]
        Resource = "arn:aws:iam::${var.aws_account_id}:policy/${local.legacy_migration_runner}-refresh"
      },
      {
        Effect   = "Allow"
        Action   = "ecs:ListTagsForResource"
        Resource = aws_ecs_cluster.legacy_migration_runner.arn
      },
      {
        Effect   = "Deny"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:RunTask", "ecs:StartTask", "ecs:DeleteTaskDefinitions"]
        Resource = "${local.legacy_migration_runner_family_arn}:*"
      },
      {
        Effect   = "Deny"
        Action   = ["ecs:StopTask", "ecs:ExecuteCommand"]
        Resource = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task/${local.legacy_migration_runner}/*"
      },
      {
        Effect    = "Deny"
        Action    = ["ecs:CreateService", "ecs:UpdateService", "ecs:CreateTaskSet"]
        Resource  = "*"
        Condition = { ArnLike = { "ecs:task-definition" = "${local.legacy_migration_runner_family_arn}:*" } }
      },
      {
        Effect   = "Deny"
        Action   = "iam:PassRole"
        Resource = [aws_iam_role.legacy_migration_runner_execution.arn, aws_iam_role.legacy_migration_runner_task.arn]
      },
      {
        Effect   = "Deny"
        Action   = ["logs:DeleteLogGroup", "logs:PutRetentionPolicy"]
        Resource = [aws_cloudwatch_log_group.legacy_migration_runner.arn, "${aws_cloudwatch_log_group.legacy_migration_runner.arn}:*"]
      },
      {
        Effect   = "Deny"
        Action   = ["ssm:PutParameter", "ssm:DeleteParameter"]
        Resource = [for parameter in values(local.legacy_migration_source_urls) : "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${parameter}"]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "legacy_migration_runner_refresh" {
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.legacy_migration_runner_refresh.arn
}
