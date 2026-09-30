# Inert foundation for VAY-2042's product CLI rehearsal. A separate reviewed
# revision must pin the run file, short-lived credentials and dispatch path.
locals {
  vay2042_product_name   = "vay2042-isolated-product-rehearsal"
  vay2042_product_source = "f6beaed255ef6a83509948c297f19cab7e62c499"
  vay2042_product_digest = "sha256:8caa417dfa8eb4822c37a9169f982795691d6dcbb1080b06a8530aba6c52b4ed"
}

resource "aws_cloudwatch_log_group" "vay2042_product" {
  name              = "/aws/ecs/${local.vay2042_product_name}"
  retention_in_days = 14
}

resource "aws_iam_role" "vay2042_product_execution" {
  name               = "vayada-vay2042-product-rehearsal-execution"
  assume_role_policy = local.vay2042_ecs_trust
}

resource "aws_iam_role_policy" "vay2042_product_execution" {
  role = aws_iam_role.vay2042_product_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = local.vay2017_rehearsal_ecr_repository_arn },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.vay2042_product.arn}:*" },
    ]
  })
}

resource "aws_ecs_task_definition" "vay2042_product" {
  family                   = local.vay2042_product_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "4096"
  execution_role_arn       = aws_iam_role.vay2042_product_execution.arn
  container_definitions = jsonencode([{
    name      = "product-rehearsal"
    essential = true
    image     = "${local.vay2017_rehearsal_ecr_repository_url}@${local.vay2042_product_digest}"
    # No source/target secrets, media role or dispatch authority exist yet.
    entryPoint = ["node"]
    command    = ["--eval", "process.exit(78)"]
    environment = [
      { name = "APPLICATION_RELEASE", value = local.vay2042_product_source },
    ]
    readonlyRootFilesystem = true
    privileged             = false
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.vay2042_product.name
        "awslogs-region"        = local.vay2017_rehearsal_region
        "awslogs-stream-prefix" = "product"
      }
    }
  }])
  lifecycle {
    precondition {
      condition     = aws_db_instance.vay2017_isolated_restore.resource_id == "db-BB7GOFQ3BQTLTBG444I2Q75X6Y"
      error_message = "Product rehearsal requires the reviewed isolated restore."
    }
  }
}
