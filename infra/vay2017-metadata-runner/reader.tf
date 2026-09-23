resource "aws_secretsmanager_secret" "vay2017_reader_credentials" {
  name        = local.vay2017_rehearsal_reader_secret_name
  description = "One isolated VAY-2043 inventory login; no direct table read, DDL, or write privileges."

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Purpose = "VAY-2043 count-only metadata reader credential"
  }
}

resource "aws_iam_role" "vay2017_inventory_execution" {
  name        = "vayada-vay2017-metadata-inventory-execution"
  description = "Pull the pinned metadata image, read the exact reader secret, and emit sanitized inventory logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.vay2017_rehearsal_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:*" }
      }
    }]
  })
  tags = {
    Purpose = "VAY-2043 inventory runner without master secret access"
  }
}

data "aws_iam_policy_document" "vay2017_inventory_execution" {
  statement {
    sid       = "AuthenticateEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PullPinnedScannerImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [local.vay2017_rehearsal_ecr_repository_arn]
  }

  statement {
    sid       = "ReadOnlyDedicatedMetadataCredential"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.vay2017_reader_credentials.arn]
  }

  statement {
    sid       = "WriteSanitizedScannerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.vay2017_metadata.arn}:*"]
  }
}

resource "aws_iam_role_policy" "vay2017_inventory_execution" {
  name   = "vay2017-metadata-inventory-execution"
  role   = aws_iam_role.vay2017_inventory_execution.id
  policy = data.aws_iam_policy_document.vay2017_inventory_execution.json
}

resource "aws_iam_role" "vay2017_bootstrap_task" {
  name        = "vayada-vay2017-metadata-bootstrap-task"
  description = "Write only the exact isolated metadata-reader secret from the one-time protected bootstrap task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.vay2017_rehearsal_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:*" }
      }
    }]
  })
  tags = {
    Purpose = "VAY-2043 one-time metadata-reader provisioning"
  }
}

data "aws_iam_policy_document" "vay2017_bootstrap_task" {
  statement {
    sid       = "WriteOnlyDedicatedMetadataCredential"
    actions   = ["secretsmanager:PutSecretValue"]
    resources = [aws_secretsmanager_secret.vay2017_reader_credentials.arn]
  }
}

resource "aws_iam_role_policy" "vay2017_bootstrap_task" {
  name   = "vay2017-metadata-bootstrap-secret-write"
  role   = aws_iam_role.vay2017_bootstrap_task.id
  policy = data.aws_iam_policy_document.vay2017_bootstrap_task.json
}

resource "aws_ecs_task_definition" "vay2017_reader_bootstrap" {
  family                   = local.vay2017_rehearsal_bootstrap_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.vay2017_task_execution.arn
  task_role_arn            = aws_iam_role.vay2017_bootstrap_task.arn
  container_definitions = jsonencode([{
    name      = "metadata-reader-bootstrap"
    image     = "${local.vay2017_rehearsal_ecr_repository_url}@${local.vay2017_rehearsal_image_digest}"
    essential = true
    command   = ["node", "--input-type=module", "-e", file("${path.module}/../../scripts/provision-vay2017-metadata-reader.mjs")]
    environment = [
      { name = "VAY2017_RUN_MAIN", value = "1" },
      { name = "VAY2017_RESTORE_INSTANCE_ID", value = local.vay2017_rehearsal_db_instance_id },
      { name = "VAY2017_SOURCE_SNAPSHOT_ID", value = local.vay2017_rehearsal_snapshot_id },
      { name = "VAY2017_RESTORE_RESOURCE_ID", value = aws_db_instance.vay2017_isolated_restore.resource_id },
      { name = "VAY2017_RESTORE_INSTANCE_ARN", value = aws_db_instance.vay2017_isolated_restore.arn },
      { name = "VAY2017_RESTORE_ATTESTATION_CHECKSUM", value = filesha256("${path.module}/../../scripts/fixtures/vay2017-isolated-restore-plan.json") },
      { name = "VAY2017_DB_HOST", value = aws_db_instance.vay2017_isolated_restore.address },
      { name = "VAY2017_DB_PORT", value = tostring(aws_db_instance.vay2017_isolated_restore.port) },
      { name = "VAY2017_READER_SECRET_ARN", value = aws_secretsmanager_secret.vay2017_reader_credentials.arn },
    ]
    secrets = [
      { name = "VAY2017_DB_USER", valueFrom = "${aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn}:username::" },
      { name = "VAY2017_DB_PASSWORD", valueFrom = "${aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn}:password::" },
    ]
    readonlyRootFilesystem = true
    privileged             = false
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.vay2017_metadata.name
        "awslogs-region"        = local.vay2017_rehearsal_region
        "awslogs-stream-prefix" = "vay2017-metadata-bootstrap"
      }
    }
  }])
  tags = {
    Purpose = "VAY-2043 fixed one-time read-only account bootstrap"
  }
}

resource "aws_sfn_state_machine" "vay2017_reader_bootstrap" {
  name     = local.vay2017_rehearsal_bootstrap_sm_name
  role_arn = aws_iam_role.vay2017_state_machine.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "One-time VAY-2043 metadata-reader setup on the exact isolated restored database. Input is intentionally unused."
    StartAt = "RunFixedBootstrapTask"
    States = {
      RunFixedBootstrapTask = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 1800
        Parameters = {
          Cluster              = aws_ecs_cluster.vay2017_metadata.arn
          TaskDefinition       = aws_ecs_task_definition.vay2017_reader_bootstrap.arn
          LaunchType           = "FARGATE"
          PlatformVersion      = "LATEST"
          EnableExecuteCommand = false
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = [aws_subnet.vay2017_runner_private.id]
              SecurityGroups = [aws_security_group.vay2017_rehearsal_runner.id]
              AssignPublicIp = "DISABLED"
            }
          }
        }
        ResultSelector = {
          "taskArn.$" = "$.Tasks[0].TaskArn"
        }
        ResultPath = "$.result"
        Next       = "DescribeCompletedBootstrapTask"
      }
      DescribeCompletedBootstrapTask = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:ecs:describeTasks"
        Parameters = {
          Cluster   = aws_ecs_cluster.vay2017_metadata.arn
          "Tasks.$" = "States.Array($.result.taskArn)"
        }
        ResultSelector = {
          "containerExitCode.$" = "$.Tasks[0].Containers[0].ExitCode"
          "stopCode.$"          = "$.Tasks[0].StopCode"
        }
        ResultPath = "$.completion"
        End        = true
      }
    }
  })
  tags = {
    Purpose = "VAY-2043 protected one-time metadata reader bootstrap"
  }
}

output "vay2017_rehearsal_reader_secret_arn" {
  description = "Exact Secrets Manager resource for the isolated count-only metadata login; never expose its value."
  value       = aws_secretsmanager_secret.vay2017_reader_credentials.arn
}
