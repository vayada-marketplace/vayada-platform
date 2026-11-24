# VAY-2441: run-on-demand task that registers a partner app (Creator Links) in the live database.
# Only ECS tasks reach the database, so the registration runs here, as the API login, with a command
# override (apps/api/src/cli/registerPartnerApp.ts). Its default command exits without doing anything.
# The app's client id and secret go straight into a new Secrets Manager secret under
# partner-apps/prod/, never into output or logs; on the Mac that hands them to the partner,
# `partner:secret-to-keychain` copies them into the Keychain and deletes the secret.

# next-api's own task role runs the registration: the platform apply role may change its policies
# but can't create a new role. This adds only creating secrets under partner-apps/prod/; the role
# still can't read, change or delete any secret.
resource "aws_iam_role_policy" "next_api_create_partner_app_secrets" {
  name = "create-partner-app-secrets"
  role = aws_iam_role.next_api_media.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:CreateSecret"
      Resource = "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:partner-apps/prod/*"
    }]
  })
}

resource "aws_ecs_task_definition" "partner_app_registration" {
  family                   = "vayada-next-api-partner-app-registration"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = data.aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.next_api_media.arn

  container_definitions = jsonencode([
    {
      name      = "vayada-next-api-partner-app-registration"
      image     = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/vayada-next-api:next-latest"
      essential = true
      command = [
        "node",
        "-e",
        "console.log('partner app registration task is inert without an explicit command override')",
      ]
      environment = [
        { name = "NODE_ENV", value = "production" },
      ]
      secrets = [
        {
          name      = "TARGET_DATABASE_URL"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/target-database-runtime-url"
        },
        # Derives the webhook signing secret of an app registered with a webhook address (VAY-2438).
        {
          name      = "PARTNER_WEBHOOK_SIGNING_KEY"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/partner-webhook-signing-key"
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/vayada-next-api"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "partner-app-registration"
        }
      }
    }
  ])

  tags = {
    Project     = "vayada"
    Environment = "production"
    Purpose     = "partner-app-registration"
  }
}
