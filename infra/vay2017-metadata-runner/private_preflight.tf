locals {
  vay2042_preflight_name = "vay2042-private-expiry-preflight"
  vay2042_preflight_arn  = "arn:aws:states:eu-west-1:269416271598:stateMachine:${local.vay2042_preflight_name}"
}

resource "aws_cloudwatch_log_group" "vay2042_preflight" {
  name              = "/aws/ecs/${local.vay2042_preflight_name}"
  retention_in_days = 14
}

resource "aws_iam_role" "vay2042_preflight_execution" {
  name               = "vayada-vay2042-private-preflight-execution"
  assume_role_policy = local.vay2042_ecs_trust
}

resource "aws_iam_role_policy" "vay2042_preflight_execution" {
  role = aws_iam_role.vay2042_preflight_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = local.vay2017_rehearsal_ecr_repository_arn },
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = [aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn, aws_secretsmanager_secret.vay2042_source_reader.arn, aws_secretsmanager_secret.vay2042_target_writer.arn] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.vay2042_preflight.arn}:*" },
    ]
  })
}

resource "aws_iam_role" "vay2042_preflight_task" {
  name               = "vayada-vay2042-private-preflight-task"
  assume_role_policy = local.vay2042_ecs_trust
}

resource "aws_iam_role_policy" "vay2042_preflight_task" {
  role = aws_iam_role.vay2042_preflight_task.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "secretsmanager:DescribeSecret", Resource = [aws_secretsmanager_secret.vay2042_source_reader.arn, aws_secretsmanager_secret.vay2042_target_writer.arn] }]
  })
}

resource "aws_ecs_task_definition" "vay2042_preflight" {
  family                   = local.vay2042_preflight_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.vay2042_preflight_execution.arn
  task_role_arn            = aws_iam_role.vay2042_preflight_task.arn
  container_definitions = jsonencode([{
    name    = "private-preflight", essential = true
    image   = "${local.vay2017_rehearsal_ecr_repository_url}@${local.vay2017_rehearsal_image_digest}"
    command = ["node", "--input-type=module", "-e", file("${path.module}/../../scripts/generated/vay2042-private-preflight.mjs")]
    environment = [
      { name = "AWS_REGION", value = "eu-west-1" },
      { name = "VAY2042_PRECHECK_MAIN", value = "1" },
      { name = "VAY2042_RESTORE_INSTANCE_ID", value = local.vay2017_rehearsal_db_instance_id },
      { name = "VAY2042_SOURCE_SNAPSHOT_ID", value = local.vay2017_rehearsal_snapshot_id },
      { name = "VAY2042_RESTORE_RESOURCE_ID", value = aws_db_instance.vay2017_isolated_restore.resource_id },
      { name = "VAY2042_RESTORE_INSTANCE_ARN", value = aws_db_instance.vay2017_isolated_restore.arn },
      { name = "VAY2042_RESTORE_ATTESTATION_CHECKSUM", value = filesha256("${path.module}/../../scripts/fixtures/vay2017-isolated-restore-plan.json") },
      { name = "VAY2042_RDS_CA_BUNDLE_GZIP", value = base64gzip(file("${path.module}/../../rehearsal/rds-ca-rsa2048-g1.pem")) },
      { name = "VAY2042_DB_HOST", value = aws_db_instance.vay2017_isolated_restore.address },
      { name = "VAY2042_DB_PORT", value = tostring(aws_db_instance.vay2017_isolated_restore.port) },
      { name = "VAY2042_READER_SECRET_ARN", value = aws_secretsmanager_secret.vay2042_source_reader.arn },
      { name = "VAY2042_TARGET_SECRET_ARN", value = aws_secretsmanager_secret.vay2042_target_writer.arn },
    ]
    secrets = [
      { name = "VAY2042_DB_USER", valueFrom = "${aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn}:username::" },
      { name = "VAY2042_DB_PASSWORD", valueFrom = "${aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn}:password::" },
      { name = "VAY2042_SOURCE_USER", valueFrom = "${aws_secretsmanager_secret.vay2042_source_reader.arn}:username::91d7b931-e78e-419f-8a9f-b1aeb9c259ba" },
      { name = "VAY2042_SOURCE_PASSWORD", valueFrom = "${aws_secretsmanager_secret.vay2042_source_reader.arn}:password::91d7b931-e78e-419f-8a9f-b1aeb9c259ba" },
      { name = "VAY2042_TARGET_USER", valueFrom = "${aws_secretsmanager_secret.vay2042_target_writer.arn}:username::220507a8-4ac8-4bab-bd57-221862dd2dcc" },
      { name = "VAY2042_TARGET_PASSWORD", valueFrom = "${aws_secretsmanager_secret.vay2042_target_writer.arn}:password::220507a8-4ac8-4bab-bd57-221862dd2dcc" },
    ]
    readonlyRootFilesystem = true
    privileged             = false
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"  = aws_cloudwatch_log_group.vay2042_preflight.name
        "awslogs-region" = "eu-west-1", "awslogs-stream-prefix" = "preflight"
      }
    }
  }])
  lifecycle {
    precondition {
      condition     = aws_db_instance.vay2017_isolated_restore.resource_id == "db-BB7GOFQ3BQTLTBG444I2Q75X6Y" && aws_vpc.vay2017_runner.cidr_block == "10.230.0.0/24"
      error_message = "Private preflight requires the reviewed isolated restore and private network."
    }
  }
}

resource "aws_iam_role" "vay2042_preflight_orchestrator" {
  name = "vayada-vay2042-private-preflight-orchestrator"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = "269416271598" }, ArnEquals = { "aws:SourceArn" = local.vay2042_preflight_arn } }
    }]
  })
}

resource "aws_iam_role_policy" "vay2042_preflight_orchestrator" {
  role = aws_iam_role.vay2042_preflight_orchestrator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecs:RunTask", Resource = aws_ecs_task_definition.vay2042_preflight.arn, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.vay2017_metadata.arn } } },
      { Effect = "Allow", Action = "iam:PassRole", Resource = [aws_iam_role.vay2042_preflight_execution.arn, aws_iam_role.vay2042_preflight_task.arn], Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
      { Effect = "Allow", Action = "ecs:DescribeTasks", Resource = local.vay2042_task_arns, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.vay2017_metadata.arn } } },
      { Effect = "Allow", Action = "ecs:StopTask", Resource = local.vay2042_task_arns, Condition = { StringEquals = { "aws:ResourceTag/VayadaOperation" = local.vay2042_preflight_name } } },
      { Effect = "Allow", Action = "ecs:TagResource", Resource = local.vay2042_task_arns, Condition = { StringEquals = { "ecs:CreateAction" = "RunTask", "aws:RequestTag/VayadaOperation" = local.vay2042_preflight_name } } },
      { Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"], Resource = "arn:aws:events:eu-west-1:269416271598:rule/StepFunctionsGetEventsForECSTaskRule" },
    ]
  })
}

resource "aws_sfn_state_machine" "vay2042_preflight" {
  name     = local.vay2042_preflight_name
  role_arn = aws_iam_role.vay2042_preflight_orchestrator.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "Fixed isolated preflight and expiry renewal; caller input is unused."
    StartAt = "Preflight"
    States = {
      Preflight = {
        Type = "Task", Resource = "arn:aws:states:::ecs:runTask.sync", TimeoutSeconds = 1800
        Parameters = {
          Cluster    = aws_ecs_cluster.vay2017_metadata.arn, TaskDefinition = aws_ecs_task_definition.vay2042_preflight.arn
          LaunchType = "FARGATE", PlatformVersion = "1.4.0", EnableExecuteCommand = false
          Tags       = [{ Key = "VayadaOperation", Value = local.vay2042_preflight_name }]
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
        ResultSelector = { "exitCode.$" = "$.Tasks[0].Containers[0].ExitCode" }
        ResultPath     = "$.completion", End = true
      }
    }
  })
}
