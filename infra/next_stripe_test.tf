# Isolated, run-on-demand task definition for real Stripe test-mode checkout
# verification. It has no ECS service, listener, or public route, and its
# default command exits without starting the API or any background worker.

resource "aws_ecs_task_definition" "next_stripe_test_smoke" {
  family                   = "vayada-next-api-stripe-test-smoke"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = data.aws_iam_role.ecs_task_execution.arn

  container_definitions = jsonencode([
    {
      name      = "vayada-next-api-stripe-test-smoke"
      image     = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/vayada-next-api:next-latest"
      essential = true
      command = [
        "node",
        "-e",
        "console.log('next Stripe test smoke task is inert without an explicit command override')",
      ]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "VAYADA_STRIPE_SMOKE_SCOPE", value = "isolated-qa-only" },
      ]
      secrets = [
        {
          name      = "TARGET_DATABASE_URL"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/target-database-url"
        },
        {
          name      = "STRIPE_SECRET_KEY"
          valueFrom = aws_ssm_parameter.next_stripe_test_secret.arn
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/vayada-next-api"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "stripe-test-smoke"
        }
      }
    }
  ])

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = nonsensitive(startswith(trimspace(var.next_stripe_test_secret_key), "rk_test_"))
      error_message = "The isolated next-checkout smoke task requires an rk_test_ Stripe key."
    }
  }

  tags = {
    Project     = "vayada"
    Environment = "staging"
    Purpose     = "next-checkout-stripe-smoke"
  }
}
