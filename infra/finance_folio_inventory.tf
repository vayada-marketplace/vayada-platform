# Aggregate-only activation inventory: no service, public route, or task role.
resource "aws_ecs_task_definition" "finance_folio_recipient_inventory" {
  family                   = "vayada-next-api-finance-folio-recipient-inventory"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  enable_fault_injection   = false
  execution_role_arn       = data.aws_iam_role.ecs_task_execution.arn

  container_definitions = jsonencode([
    {
      name      = "vayada-next-api-finance-folio-recipient-inventory"
      image     = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/vayada-next-api:next-latest"
      essential = true
      command   = ["node", "-e", "console.log(JSON.stringify({status:'INERT',message:'use scripts/run-finance-folio-recipient-inventory.sh'}))"]
      secrets = [
        {
          name      = "TARGET_DATABASE_URL"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/target-database-url"
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/vayada-next-api"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "folio-recipient-inventory"
        }
      }
    }
  ])

  tags = {
    Project     = "vayada"
    Environment = "production"
    Purpose     = "finance-folio-recipient-inventory"
  }
}
