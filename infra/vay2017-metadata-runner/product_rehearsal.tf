# Inert foundation for VAY-2042's product CLI rehearsal. A separate reviewed
# revision must pin the run file, short-lived credentials and dispatch path.
locals {
  vay2042_product_name   = "vay2042-isolated-product-rehearsal"
  vay2042_product_arn    = "arn:aws:states:eu-west-1:269416271598:stateMachine:${local.vay2042_product_name}"
  vay2042_product_source = "f6beaed255ef6a83509948c297f19cab7e62c499"
  vay2042_product_digest = "sha256:8caa417dfa8eb4822c37a9169f982795691d6dcbb1080b06a8530aba6c52b4ed"
}

resource "aws_iam_role" "vay2042_product_orchestrator" {
  name = "vayada-vay2042-product-rehearsal-orchestrator"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.vay2017_rehearsal_account_id }, ArnEquals = { "aws:SourceArn" = local.vay2042_product_arn } }
    }]
  })
}

resource "aws_iam_role_policy" "vay2042_product_orchestrator" {
  role = aws_iam_role.vay2042_product_orchestrator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecs:RunTask", Resource = aws_ecs_task_definition.vay2042_product.arn, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.vay2017_metadata.arn } } },
      { Effect = "Allow", Action = "iam:PassRole", Resource = aws_iam_role.vay2042_product_execution.arn, Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
      { Effect = "Allow", Action = "ecs:DescribeTasks", Resource = local.vay2042_task_arns, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.vay2017_metadata.arn } } },
      { Effect = "Allow", Action = "ecs:StopTask", Resource = local.vay2042_task_arns, Condition = { StringEquals = { "aws:ResourceTag/VayadaOperation" = local.vay2042_product_name } } },
      { Effect = "Allow", Action = "ecs:TagResource", Resource = local.vay2042_task_arns, Condition = { StringEquals = { "ecs:CreateAction" = "RunTask", "aws:RequestTag/VayadaOperation" = local.vay2042_product_name } } },
      { Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"], Resource = "arn:aws:events:eu-west-1:269416271598:rule/StepFunctionsGetEventsForECSTaskRule" },
    ]
  })
}

resource "aws_sfn_state_machine" "vay2042_product" {
  name     = local.vay2042_product_name
  role_arn = aws_iam_role.vay2042_product_orchestrator.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "Fixed private product rehearsal task; caller input is unused."
    StartAt = "Rehearse"
    States = {
      Rehearse = {
        Type = "Task", Resource = "arn:aws:states:::ecs:runTask.sync", TimeoutSeconds = 14400
        Parameters = {
          Cluster    = aws_ecs_cluster.vay2017_metadata.arn, TaskDefinition = aws_ecs_task_definition.vay2042_product.arn
          LaunchType = "FARGATE", PlatformVersion = "1.4.0", EnableExecuteCommand = false
          Tags       = [{ Key = "VayadaOperation", Value = local.vay2042_product_name }]
          NetworkConfiguration = { AwsvpcConfiguration = {
            Subnets = [aws_subnet.vay2017_runner_private.id], SecurityGroups = [aws_security_group.vay2017_rehearsal_runner.id], AssignPublicIp = "DISABLED"
          } }
        }
        ResultSelector = { "taskArn.$" = "$.TaskArn" }
        ResultPath     = "$.result", Next = "Completion"
      }
      Completion = {
        Type           = "Task", Resource = "arn:aws:states:::aws-sdk:ecs:describeTasks"
        Parameters     = { Cluster = aws_ecs_cluster.vay2017_metadata.arn, "Tasks.$" = "States.Array($.result.taskArn)" }
        ResultSelector = { "exitCode.$" = "$.Tasks[0].Containers[0].ExitCode", "imageDigest.$" = "$.Tasks[0].Containers[0].ImageDigest", "taskDefinitionArn.$" = "$.Tasks[0].TaskDefinitionArn" }
        ResultPath     = "$.completion", End = true
      }
    }
  })
}

resource "aws_iam_role" "vay2042_product_github" {
  name = "vayada-github-actions-vay2042-product-rehearsal"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::269416271598:oidc-provider/token.actions.githubusercontent.com" }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:vayada-marketplace/vayada-platform:environment:vay2042-data-rehearsal"
      } }
    }]
  })
}

resource "aws_iam_role_policy" "vay2042_product_github" {
  role = aws_iam_role.vay2042_product_github.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # StartExecution remains absent until the armed task enforces the reviewed run file before CLI entry.
      { Effect = "Allow", Action = ["states:DescribeStateMachine", "states:ListExecutions"], Resource = aws_sfn_state_machine.vay2042_product.arn },
      { Effect = "Allow", Action = "states:DescribeExecution", Resource = "arn:aws:states:eu-west-1:269416271598:execution:${local.vay2042_product_name}:*" },
      { Effect = "Allow", Action = "ecs:DescribeTaskDefinition", Resource = aws_ecs_task_definition.vay2042_product.arn },
      { Effect = "Allow", Action = "ecs:ListTasks", Resource = "*", Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.vay2017_metadata.arn } } },
      { Effect = "Allow", Action = "rds:DescribeDBInstances", Resource = "arn:aws:rds:eu-west-1:269416271598:db:vay2017-metadata-rehearsal-isolated-20260923" },
    ]
  })
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
