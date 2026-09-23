locals {
  vay2017_rehearsal_vpc_id             = "vpc-055e8074dc3b2422a"
  vay2017_rehearsal_db_instance_id     = "vay2017-legacy-rehearsal-20260921"
  vay2017_rehearsal_snapshot_id        = "vay2017-legacy-source-freeze-20260920"
  vay2017_rehearsal_restore_event_id   = "6c80019b-26bd-460c-8750-5a950bf48441"
  vay2017_rehearsal_restore_event_time = "2026-09-20T16:19:33Z"
  vay2017_rehearsal_db_resource_id     = "db-MHCPB2UKUGKW6FLKDBQC4RQWJQ"
  vay2017_rehearsal_db_arn             = "arn:aws:rds:eu-west-1:269416271598:db:vay2017-legacy-rehearsal-20260921"
  vay2017_rehearsal_image_digest       = "sha256:a6f1001b1713e5f86e52cf757b3e67c794ec936639273dc041cedc7b95ea7b3c"
  vay2017_rehearsal_subnet_cidr        = "172.31.48.0/24"
  vay2017_rehearsal_subnet_az          = "eu-west-1a"
  vay2017_rehearsal_cluster_name       = "vay2017-metadata-rehearsal"
  vay2017_rehearsal_task_family        = "vay2017-metadata-runner"
  vay2017_rehearsal_state_machine_name = "vay2017-metadata-inventory"
  vay2017_rehearsal_log_group_name     = "/aws/ecs/vay2017-metadata-runner"
  vay2017_rehearsal_github_role_name   = "vayada-github-actions-vay2017-metadata"
  vay2017_rehearsal_endpoint_names = toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
  ])
}

data "aws_vpc" "vay2017_rehearsal" {
  id = local.vay2017_rehearsal_vpc_id
}

data "aws_db_instance" "vay2017_rehearsal" {
  db_instance_identifier = local.vay2017_rehearsal_db_instance_id
}

data "aws_db_snapshot" "vay2017_rehearsal_source" {
  db_snapshot_identifier = local.vay2017_rehearsal_snapshot_id
}

data "aws_ecr_repository" "vay2017_rehearsal" {
  name = "vayada-next-api"
}

data "aws_prefix_list" "vay2017_s3" {
  name = "com.amazonaws.eu-west-1.s3"
}

resource "aws_subnet" "vay2017_rehearsal_private" {
  vpc_id                  = local.vay2017_rehearsal_vpc_id
  cidr_block              = local.vay2017_rehearsal_subnet_cidr
  availability_zone       = local.vay2017_rehearsal_subnet_az
  map_public_ip_on_launch = false

  tags = {
    Name    = "vay2017-metadata-private"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }

  lifecycle {
    precondition {
      condition     = data.aws_vpc.vay2017_rehearsal.cidr_block == "172.31.0.0/16"
      error_message = "The VAY-2017 rehearsal VPC changed; re-review its address plan before creating a subnet."
    }
    precondition {
      condition     = data.aws_vpc.vay2017_rehearsal.enable_dns_support && data.aws_vpc.vay2017_rehearsal.enable_dns_hostnames
      error_message = "Private AWS interface endpoints require VPC DNS support and DNS hostnames."
    }
    precondition {
      condition = (
        data.aws_db_instance.vay2017_rehearsal.db_instance_identifier == local.vay2017_rehearsal_db_instance_id &&
        data.aws_db_instance.vay2017_rehearsal.engine == "postgres" &&
        data.aws_db_instance.vay2017_rehearsal.engine_version == "17.9" &&
        data.aws_db_instance.vay2017_rehearsal.storage_encrypted &&
        !data.aws_db_instance.vay2017_rehearsal.publicly_accessible &&
        data.aws_db_instance.vay2017_rehearsal.availability_zone == local.vay2017_rehearsal_subnet_az
      )
      error_message = "The restored database no longer matches the reviewed private PostgreSQL rehearsal identity."
    }
    precondition {
      condition     = length(data.aws_db_instance.vay2017_rehearsal.master_user_secret) == 1
      error_message = "The exact rehearsal RDS instance must expose one AWS-managed master secret."
    }
    precondition {
      condition = (
        data.aws_db_snapshot.vay2017_rehearsal_source.status == "available" &&
        data.aws_db_snapshot.vay2017_rehearsal_source.db_instance_identifier == "vayada-database" &&
        data.aws_db_snapshot.vay2017_rehearsal_source.encrypted &&
        data.aws_db_snapshot.vay2017_rehearsal_source.engine == "postgres" &&
        data.aws_db_snapshot.vay2017_rehearsal_source.engine_version == "17.9"
      )
      error_message = "The VAY-2017 source snapshot no longer matches the reviewed encrypted PostgreSQL source."
    }
  }
}

resource "aws_route_table" "vay2017_rehearsal_private" {
  vpc_id = local.vay2017_rehearsal_vpc_id
  tags = {
    Name    = "vay2017-metadata-private"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal; no internet route"
  }
}

resource "aws_route_table_association" "vay2017_rehearsal_private" {
  subnet_id      = aws_subnet.vay2017_rehearsal_private.id
  route_table_id = aws_route_table.vay2017_rehearsal_private.id
}

resource "aws_security_group" "vay2017_rehearsal_runner" {
  name        = "vay2017-metadata-runner"
  description = "VAY-2043 runner: only rehearsal PostgreSQL, AWS endpoints, and ECR S3 layers"
  vpc_id      = local.vay2017_rehearsal_vpc_id
  egress      = []

  tags = {
    Name    = "vay2017-metadata-runner"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }
}

resource "aws_security_group" "vay2017_rehearsal_endpoints" {
  name        = "vay2017-metadata-endpoints"
  description = "HTTPS from the VAY-2043 one-off metadata runner only"
  vpc_id      = local.vay2017_rehearsal_vpc_id
  egress      = []

  ingress {
    description     = "Runner to AWS interface endpoints"
    protocol        = "tcp"
    from_port       = 443
    to_port         = 443
    security_groups = [aws_security_group.vay2017_rehearsal_runner.id]
  }

  tags = {
    Name    = "vay2017-metadata-endpoints"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }
}

resource "aws_vpc_security_group_egress_rule" "vay2017_runner_postgres" {
  security_group_id            = aws_security_group.vay2017_rehearsal_runner.id
  description                  = "PostgreSQL to the dedicated rehearsal DB group only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.vay2017_rehearsal_database.id
}

resource "aws_vpc_security_group_egress_rule" "vay2017_runner_https" {
  security_group_id            = aws_security_group.vay2017_rehearsal_runner.id
  description                  = "HTTPS to dedicated AWS endpoint ENIs only"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.vay2017_rehearsal_endpoints.id
}

resource "aws_vpc_security_group_egress_rule" "vay2017_runner_ecr_s3" {
  security_group_id = aws_security_group.vay2017_rehearsal_runner.id
  description       = "HTTPS to the S3 gateway endpoint for ECR image layers"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_prefix_list.vay2017_s3.id
}

resource "aws_security_group" "vay2017_rehearsal_database" {
  name        = "vay2017-metadata-database"
  description = "Dedicated access group for the VAY-2017 restored rehearsal database"
  vpc_id      = local.vay2017_rehearsal_vpc_id
  egress      = []

  ingress {
    description     = "PostgreSQL from the fixed metadata runner only"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.vay2017_rehearsal_runner.id]
  }

  tags = {
    Name    = "vay2017-metadata-database"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }
}

resource "aws_vpc_endpoint" "vay2017_interface" {
  for_each = local.vay2017_rehearsal_endpoint_names

  vpc_id              = local.vay2017_rehearsal_vpc_id
  service_name        = "com.amazonaws.eu-west-1.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [aws_subnet.vay2017_rehearsal_private.id]
  security_group_ids  = [aws_security_group.vay2017_rehearsal_endpoints.id]

  tags = {
    Name    = "vay2017-metadata-${replace(each.key, ".", "-")}"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }
}

resource "aws_vpc_endpoint" "vay2017_ecr_s3" {
  vpc_id            = local.vay2017_rehearsal_vpc_id
  service_name      = "com.amazonaws.eu-west-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.vay2017_rehearsal_private.id]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "arn:aws:s3:::prod-eu-west-1-starport-layer-bucket/*"
    }]
  })

  tags = {
    Name    = "vay2017-metadata-ecr-s3"
    Purpose = "VAY-2043 ECR image-layer access only"
  }
}

resource "aws_cloudwatch_log_group" "vay2017_metadata" {
  name              = local.vay2017_rehearsal_log_group_name
  retention_in_days = 14
  tags = {
    Purpose = "Sanitized VAY-2043 metadata inventory evidence"
  }
}

resource "aws_iam_role" "vay2017_task_execution" {
  name        = "vayada-vay2017-metadata-task-execution"
  description = "Pull the pinned scanner image, fetch one RDS-managed rehearsal secret, and emit inventory logs"
  assume_role_policy = jsonencode({
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
  tags = {
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }
}

data "aws_iam_policy_document" "vay2017_task_execution" {
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
    resources = [data.aws_ecr_repository.vay2017_rehearsal.arn]
  }

  statement {
    sid       = "ReadOnlyRestoredDatabaseMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [data.aws_db_instance.vay2017_rehearsal.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "WriteSanitizedScannerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.vay2017_metadata.arn}:*"]
  }
}

resource "aws_iam_role_policy" "vay2017_task_execution" {
  name   = "vay2017-metadata-runner-execution"
  role   = aws_iam_role.vay2017_task_execution.id
  policy = data.aws_iam_policy_document.vay2017_task_execution.json
}

resource "aws_ecs_cluster" "vay2017_metadata" {
  name = local.vay2017_rehearsal_cluster_name
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  tags = {
    Purpose = "VAY-2043 one-off isolated metadata inventory"
  }
}

resource "aws_ecs_task_definition" "vay2017_metadata" {
  family                   = local.vay2017_rehearsal_task_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.vay2017_task_execution.arn
  container_definitions = jsonencode([{
    name      = "metadata-runner"
    image     = "${data.aws_ecr_repository.vay2017_rehearsal.repository_url}@${local.vay2017_rehearsal_image_digest}"
    essential = true
    command   = ["node", "--input-type=module", "-e", file("${path.module}/../scripts/vay2017-rehearsal-metadata.mjs")]
    environment = [
      { name = "VAY2017_RUN_MAIN", value = "1" },
      { name = "VAY2017_RESTORE_INSTANCE_ID", value = local.vay2017_rehearsal_db_instance_id },
      { name = "VAY2017_SOURCE_SNAPSHOT_ID", value = local.vay2017_rehearsal_snapshot_id },
      { name = "VAY2017_RESTORE_EVENT_ID", value = local.vay2017_rehearsal_restore_event_id },
      { name = "VAY2017_RESTORE_EVENT_TIME", value = local.vay2017_rehearsal_restore_event_time },
      { name = "VAY2017_RESTORE_RESOURCE_ID", value = local.vay2017_rehearsal_db_resource_id },
      { name = "VAY2017_RESTORE_INSTANCE_ARN", value = local.vay2017_rehearsal_db_arn },
      { name = "VAY2017_RESTORE_ATTESTATION_CHECKSUM", value = filesha256("${path.module}/../scripts/fixtures/vay2017-restore-attestation.json") },
      { name = "VAY2017_IMAGE_DIGEST", value = local.vay2017_rehearsal_image_digest },
      { name = "VAY2017_SCANNER_SOURCE_CHECKSUM", value = filesha256("${path.module}/../scripts/vay2017-rehearsal-metadata.mjs") },
    ]
    secrets = [
      { name = "VAY2017_DB_HOST", valueFrom = "${data.aws_db_instance.vay2017_rehearsal.master_user_secret[0].secret_arn}:host::" },
      { name = "VAY2017_DB_PORT", valueFrom = "${data.aws_db_instance.vay2017_rehearsal.master_user_secret[0].secret_arn}:port::" },
      { name = "VAY2017_DB_USER", valueFrom = "${data.aws_db_instance.vay2017_rehearsal.master_user_secret[0].secret_arn}:username::" },
      { name = "VAY2017_DB_PASSWORD", valueFrom = "${data.aws_db_instance.vay2017_rehearsal.master_user_secret[0].secret_arn}:password::" },
    ]
    readonlyRootFilesystem = true
    privileged             = false
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.vay2017_metadata.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "vay2017-metadata"
      }
    }
  }])
  tags = {
    Purpose = "VAY-2043 fixed read-only metadata scanner"
  }
}

data "aws_iam_policy_document" "vay2017_state_machine_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.vay2017_rehearsal_state_machine_name}"]
    }
  }
}

resource "aws_iam_role" "vay2017_state_machine" {
  name               = "vayada-vay2017-metadata-state-machine"
  assume_role_policy = data.aws_iam_policy_document.vay2017_state_machine_trust.json
  tags = {
    Purpose = "VAY-2043 fixed one-off Fargate orchestration"
  }
}

data "aws_iam_policy_document" "vay2017_state_machine" {
  statement {
    sid       = "RunOnlyFixedMetadataTask"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.vay2017_metadata.arn]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.vay2017_metadata.arn]
    }
  }

  statement {
    sid       = "PassOnlyFixedTaskExecutionRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.vay2017_task_execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "ObserveAndStopOnlyEcsTasks"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task/${local.vay2017_rehearsal_cluster_name}/*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.vay2017_metadata.arn]
    }
  }

  statement {
    sid       = "ManageStepFunctionsCompletionRule"
    actions   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "events:ManagedBy"
      values   = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "vay2017_state_machine" {
  name   = "vay2017-fixed-task-execution"
  role   = aws_iam_role.vay2017_state_machine.id
  policy = data.aws_iam_policy_document.vay2017_state_machine.json
}

resource "aws_sfn_state_machine" "vay2017_metadata" {
  name     = local.vay2017_rehearsal_state_machine_name
  role_arn = aws_iam_role.vay2017_state_machine.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "Run one fixed VAY-2043 read-only metadata inventory task. Input is intentionally unused."
    StartAt = "RunFixedMetadataTask"
    States = {
      RunFixedMetadataTask = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 600
        Parameters = {
          Cluster              = aws_ecs_cluster.vay2017_metadata.arn
          TaskDefinition       = aws_ecs_task_definition.vay2017_metadata.arn
          LaunchType           = "FARGATE"
          PlatformVersion      = "LATEST"
          EnableExecuteCommand = false
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = [aws_subnet.vay2017_rehearsal_private.id]
              SecurityGroups = [aws_security_group.vay2017_rehearsal_runner.id]
              AssignPublicIp = "DISABLED"
            }
          }
        }
        ResultSelector = {
          "taskArn.$" = "$.Tasks[0].TaskArn"
        }
        ResultPath = "$.result"
        End        = true
      }
    }
  })
  tags = {
    Purpose = "VAY-2043 fixed read-only metadata inventory"
  }
}

data "aws_iam_policy_document" "vay2017_github_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:vayada-marketplace/vayada-platform:environment:next"]
    }
  }
}

resource "aws_iam_role" "vay2017_github_inventory" {
  name                 = local.vay2017_rehearsal_github_role_name
  description          = "Invoke only the fixed VAY-2043 metadata inventory; no production secrets or mutations"
  assume_role_policy   = data.aws_iam_policy_document.vay2017_github_trust.json
  max_session_duration = 3600
  lifecycle {
    prevent_destroy = true
  }
  tags = {
    Purpose = "VAY-2043 least-privilege GitHub workflow"
  }
}

data "aws_iam_policy_document" "vay2017_github_inventory" {
  statement {
    sid       = "StartFixedMetadataInventory"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.vay2017_metadata.arn]
  }
  statement {
    sid       = "ReadFixedMetadataInventoryExecution"
    actions   = ["states:DescribeExecution"]
    resources = ["arn:aws:states:${var.aws_region}:${var.aws_account_id}:execution:${local.vay2017_rehearsal_state_machine_name}:*"]
  }
  statement {
    sid       = "ReadOnlySanitizedInventoryLogs"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.vay2017_metadata.arn}:*"]
  }
  statement {
    sid = "InspectOnlyRehearsalNetworkAndSource"
    actions = [
      "ec2:DescribePrefixLists",
      "ec2:DescribeRouteTables",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcEndpoints",
      "ec2:DescribeVpcs",
      "rds:DescribeDBInstances",
      "rds:DescribeDBSnapshots",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "vay2017_github_inventory" {
  name   = "vay2017-fixed-metadata-inventory"
  role   = aws_iam_role.vay2017_github_inventory.id
  policy = data.aws_iam_policy_document.vay2017_github_inventory.json
}

output "vay2017_rehearsal_database_security_group_id" {
  description = "Dedicated database SG; attach only to the named restored VAY-2017 rehearsal instance."
  value       = aws_security_group.vay2017_rehearsal_database.id
}

output "vay2017_rehearsal_metadata_state_machine_arn" {
  description = "Fixed VAY-2043 metadata inventory state machine."
  value       = aws_sfn_state_machine.vay2017_metadata.arn
}

output "vay2017_rehearsal_metadata_github_role_arn" {
  description = "Least-privilege OIDC role for the manual VAY-2017 inventory workflow."
  value       = aws_iam_role.vay2017_github_inventory.arn
}
