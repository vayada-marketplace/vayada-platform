locals {
  vay2042_compare_name = "vay2042-source-preservation-compare"
  vay2042_compare_arn  = "arn:aws:states:eu-west-1:269416271598:stateMachine:${local.vay2042_compare_name}"
}

data "aws_db_instance" "vay2042_control" {
  db_instance_identifier = "vay2042-preservation-control-20260927"
}

resource "aws_cloudwatch_log_group" "vay2042_compare" {
  name              = "/aws/ecs/${local.vay2042_compare_name}"
  retention_in_days = 14
}

resource "aws_iam_role" "vay2042_compare_execution" {
  name               = "vayada-vay2042-preservation-compare-execution"
  assume_role_policy = local.vay2042_ecs_trust
}

resource "aws_iam_role_policy" "vay2042_compare_execution" {
  role = aws_iam_role.vay2042_compare_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = local.vay2017_rehearsal_ecr_repository_arn },
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = [aws_secretsmanager_secret.vay2042_source_reader.arn, data.aws_db_instance.vay2042_control.master_user_secret[0].secret_arn] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.vay2042_compare.arn}:*" },
    ]
  })
}

resource "aws_ecs_task_definition" "vay2042_compare" {
  family                   = local.vay2042_compare_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.vay2042_compare_execution.arn
  container_definitions = jsonencode([{
    name    = "source-preservation", essential = true
    image   = "${local.vay2017_rehearsal_ecr_repository_url}@${local.vay2017_rehearsal_image_digest}"
    command = ["node", "--input-type=module", "-e", file("${path.module}/../../scripts/generated/vay2042-preservation-compare.mjs")]
    environment = [
      { name = "AWS_REGION", value = "eu-west-1" },
      { name = "VAY2042_COMPARE_MAIN", value = "1" },
      { name = "VAY2042_SOURCE_ID", value = local.vay2017_rehearsal_db_instance_id },
      { name = "VAY2042_SOURCE_RESOURCE", value = aws_db_instance.vay2017_isolated_restore.resource_id },
      { name = "VAY2042_CONTROL_ID", value = data.aws_db_instance.vay2042_control.db_instance_identifier },
      { name = "VAY2042_CONTROL_RESOURCE", value = data.aws_db_instance.vay2042_control.resource_id },
      { name = "VAY2042_CONTROL_RESTORE_EVENT", value = "7781e4d4-0024-4baa-85ea-0ec293175d8b" },
      { name = "VAY2042_SNAPSHOT_ID", value = local.vay2017_rehearsal_snapshot_id },
      { name = "VAY2042_SOURCE_HOST", value = aws_db_instance.vay2017_isolated_restore.address },
      { name = "VAY2042_CONTROL_HOST", value = data.aws_db_instance.vay2042_control.address },
      { name = "VAY2042_RDS_CA_BUNDLE_GZIP", value = base64gzip(file("${path.module}/../../rehearsal/rds-ca-rsa2048-g1.pem")) },
    ]
    secrets = [
      { name = "VAY2042_SOURCE_USER", valueFrom = "${aws_secretsmanager_secret.vay2042_source_reader.arn}:username::91d7b931-e78e-419f-8a9f-b1aeb9c259ba" },
      { name = "VAY2042_SOURCE_PASSWORD", valueFrom = "${aws_secretsmanager_secret.vay2042_source_reader.arn}:password::91d7b931-e78e-419f-8a9f-b1aeb9c259ba" },
      { name = "VAY2042_CONTROL_USER", valueFrom = "${data.aws_db_instance.vay2042_control.master_user_secret[0].secret_arn}:username::b42c0e24-9074-496c-a816-deeaab3ad1b9" },
      { name = "VAY2042_CONTROL_PASSWORD", valueFrom = "${data.aws_db_instance.vay2042_control.master_user_secret[0].secret_arn}:password::b42c0e24-9074-496c-a816-deeaab3ad1b9" },
    ]
    readonlyRootFilesystem = true
    privileged             = false
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"  = aws_cloudwatch_log_group.vay2042_compare.name
        "awslogs-region" = "eu-west-1", "awslogs-stream-prefix" = "compare"
      }
    }
  }])
  lifecycle {
    precondition {
      condition = (aws_db_instance.vay2017_isolated_restore.resource_id == "db-BB7GOFQ3BQTLTBG444I2Q75X6Y" &&
        data.aws_db_instance.vay2042_control.resource_id == "db-KWO2HSCRBXNV75OK7LNIBZN7TQ" &&
        data.aws_db_instance.vay2042_control.db_subnet_group == "vay2017-metadata-isolated-restore" &&
        data.aws_db_instance.vay2042_control.storage_encrypted &&
        !data.aws_db_instance.vay2042_control.publicly_accessible &&
      toset(data.aws_db_instance.vay2042_control.vpc_security_groups) == toset([aws_security_group.vay2017_rehearsal_database.id]))
      error_message = "Source-preservation compare requires the two exact private encrypted restores."
    }
  }
}

resource "aws_iam_role" "vay2042_compare_orchestrator" {
  name = "vayada-vay2042-preservation-compare-orchestrator"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = "269416271598" }, ArnEquals = { "aws:SourceArn" = local.vay2042_compare_arn } }
    }]
  })
}

resource "aws_iam_role_policy" "vay2042_compare_orchestrator" {
  role = aws_iam_role.vay2042_compare_orchestrator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecs:RunTask", Resource = aws_ecs_task_definition.vay2042_compare.arn, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.vay2017_metadata.arn } } },
      { Effect = "Allow", Action = "iam:PassRole", Resource = aws_iam_role.vay2042_compare_execution.arn, Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
      { Effect = "Allow", Action = "ecs:DescribeTasks", Resource = local.vay2042_task_arns, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.vay2017_metadata.arn } } },
      { Effect = "Allow", Action = "ecs:StopTask", Resource = local.vay2042_task_arns, Condition = { StringEquals = { "aws:ResourceTag/VayadaOperation" = local.vay2042_compare_name } } },
      { Effect = "Allow", Action = "ecs:TagResource", Resource = local.vay2042_task_arns, Condition = { StringEquals = { "ecs:CreateAction" = "RunTask", "aws:RequestTag/VayadaOperation" = local.vay2042_compare_name } } },
      { Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"], Resource = "arn:aws:events:eu-west-1:269416271598:rule/StepFunctionsGetEventsForECSTaskRule" },
    ]
  })
}

resource "aws_sfn_state_machine" "vay2042_compare" {
  name     = local.vay2042_compare_name
  role_arn = aws_iam_role.vay2042_compare_orchestrator.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "Fixed read-only 83-table comparison of two exact snapshot restores; caller input unused."
    StartAt = "Compare"
    States = {
      Compare = {
        Type = "Task", Resource = "arn:aws:states:::ecs:runTask.sync", TimeoutSeconds = 7200
        Parameters = {
          Cluster    = aws_ecs_cluster.vay2017_metadata.arn, TaskDefinition = aws_ecs_task_definition.vay2042_compare.arn
          LaunchType = "FARGATE", PlatformVersion = "1.4.0", EnableExecuteCommand = false
          Tags       = [{ Key = "VayadaOperation", Value = local.vay2042_compare_name }]
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
