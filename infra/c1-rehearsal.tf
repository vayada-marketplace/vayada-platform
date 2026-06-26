locals {
  c1_rehearsal_runner_name      = "vayada-c1-rehearsal-runner"
  c1_rehearsal_runner_log_group = "/ecs/${local.c1_rehearsal_runner_name}"
  c1_rehearsal_runner_image     = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/vayada-api:next-latest"

  c1_rehearsal_runner_secrets = [
    { name = "TARGET_DATABASE_URL", valueFrom = "/vayada/staging/target-database-url" },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "/vayada/staging/stripe-webhook-secret" },
    { name = "XENDIT_WEBHOOK_SECRET", valueFrom = "/vayada/staging/xendit-webhook-secret" },
    { name = "CHANNEX_WEBHOOK_SECRET", valueFrom = "/vayada/staging/channex-webhook-secret" },
  ]

}

data "aws_iam_role" "c1_rehearsal_runner_execution" {
  name = "vayada-c1-rehearsal-runner-exec"
}

resource "aws_ecs_task_definition" "c1_rehearsal_runner" {
  family                   = local.c1_rehearsal_runner_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = data.aws_iam_role.c1_rehearsal_runner_execution.arn

  container_definitions = jsonencode([
    {
      name      = local.c1_rehearsal_runner_name
      image     = local.c1_rehearsal_runner_image
      essential = true
      command = [
        "node",
        "packages/backend-migration/dist/cli/c1RehearsalChecks.js",
        "--lookback-minutes",
        "1440",
        "--pretty",
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "ENVIRONMENT", value = "staging" },
        { name = "C1_REHEARSAL_WEBHOOK_BASE_URL", value = "https://target-api.vayada.com" },
        { name = "C1_REHEARSAL_ALLOW_SEND_TO_HOST", value = "target-api.vayada.com" },
      ]

      secrets = [
        for secret in local.c1_rehearsal_runner_secrets : {
          name      = secret.name
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${secret.valueFrom}"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs[local.c1_rehearsal_runner_log_group].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Project     = "vayada"
    Environment = "staging"
    Purpose     = "c1-rehearsal"
  }
}
