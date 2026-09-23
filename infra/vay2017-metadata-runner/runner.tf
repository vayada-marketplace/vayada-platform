locals {
  vay2017_rehearsal_region             = "eu-west-1"
  vay2017_rehearsal_account_id         = "269416271598"
  vay2017_rehearsal_snapshot_id        = "vay2017-legacy-source-freeze-20260920"
  vay2017_rehearsal_source_database_id = "vayada-database"
  vay2017_rehearsal_db_instance_id     = "vay2017-metadata-rehearsal-isolated-20260923"
  vay2017_rehearsal_db_class           = "db.t3.micro"
  vay2017_runner_vpc_cidr              = "10.230.0.0/24"
  vay2017_runner_subnet_cidr           = "10.230.0.0/28"
  vay2017_endpoint_subnet_cidr         = "10.230.0.16/28"
  vay2017_database_subnet_a_cidr       = "10.230.0.32/28"
  vay2017_database_subnet_b_cidr       = "10.230.0.48/28"
  vay2017_rehearsal_subnet_az          = "eu-west-1a"
  vay2017_rehearsal_second_subnet_az   = "eu-west-1b"
  vay2017_rehearsal_image_digest       = "sha256:a6f1001b1713e5f86e52cf757b3e67c794ec936639273dc041cedc7b95ea7b3c"
  vay2017_rehearsal_cluster_name       = "vay2017-metadata-rehearsal"
  vay2017_rehearsal_task_family        = "vay2017-metadata-runner"
  vay2017_rehearsal_state_machine_name = "vay2017-metadata-inventory"
  vay2017_rehearsal_log_group_name     = "/aws/ecs/vay2017-metadata-runner"
  vay2017_rehearsal_github_role_name   = "vayada-github-actions-vay2017-metadata"
  vay2017_rehearsal_ecr_repository_arn = "arn:aws:ecr:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:repository/vayada-next-api"
  vay2017_rehearsal_ecr_repository_url = "${local.vay2017_rehearsal_account_id}.dkr.ecr.${local.vay2017_rehearsal_region}.amazonaws.com/vayada-next-api"
  vay2017_rehearsal_s3_prefix_list_id  = "pl-6da54004"
  vay2017_rehearsal_attestation        = jsondecode(file("${path.module}/../../scripts/fixtures/vay2017-isolated-restore-plan.json"))
  vay2017_rehearsal_endpoint_names = toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
  ])
}

resource "aws_vpc" "vay2017_runner" {
  cidr_block           = local.vay2017_runner_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "vay2017-metadata-runner"
    Purpose = "Dedicated VAY-2043 runner and isolated snapshot restore; no production VPC peering"
  }
}

resource "aws_subnet" "vay2017_runner_private" {
  vpc_id                  = aws_vpc.vay2017_runner.id
  cidr_block              = local.vay2017_runner_subnet_cidr
  availability_zone       = local.vay2017_rehearsal_subnet_az
  map_public_ip_on_launch = false

  tags = {
    Name    = "vay2017-metadata-runner-private"
    Purpose = "VAY-2043 one-off runner subnet; isolated VPC local route only"
  }

  lifecycle {
    precondition {
      condition = (
        local.vay2017_rehearsal_attestation.accountId == local.vay2017_rehearsal_account_id &&
        local.vay2017_rehearsal_attestation.region == local.vay2017_rehearsal_region &&
        local.vay2017_rehearsal_attestation.restoreInstanceId == local.vay2017_rehearsal_db_instance_id &&
        local.vay2017_rehearsal_attestation.restoreEngine == "postgres" &&
        local.vay2017_rehearsal_attestation.restoreEngineVersion == "17.9" &&
        local.vay2017_rehearsal_attestation.restoreStorageEncrypted &&
        !local.vay2017_rehearsal_attestation.restorePubliclyAccessible &&
        local.vay2017_rehearsal_attestation.restoreAvailabilityZone == local.vay2017_rehearsal_subnet_az &&
        local.vay2017_rehearsal_attestation.credentialManagement == "RDS-managed AWS Secrets Manager master credential" &&
        local.vay2017_rehearsal_attestation.sourceSnapshotId == local.vay2017_rehearsal_snapshot_id &&
        local.vay2017_rehearsal_attestation.sourceDatabaseId == local.vay2017_rehearsal_source_database_id &&
        local.vay2017_rehearsal_attestation.targetVpcCidr == local.vay2017_runner_vpc_cidr
      )
      error_message = "The planned isolated restore identity does not match the exact source snapshot and private VPC plan."
    }
  }
}

resource "aws_subnet" "vay2017_endpoints_private" {
  vpc_id                  = aws_vpc.vay2017_runner.id
  cidr_block              = local.vay2017_endpoint_subnet_cidr
  availability_zone       = local.vay2017_rehearsal_subnet_az
  map_public_ip_on_launch = false

  tags = {
    Name    = "vay2017-metadata-endpoints-private"
    Purpose = "VAY-2043 private AWS interface endpoint ENIs"
  }
}

resource "aws_subnet" "vay2017_database_a" {
  vpc_id                  = aws_vpc.vay2017_runner.id
  cidr_block              = local.vay2017_database_subnet_a_cidr
  availability_zone       = local.vay2017_rehearsal_subnet_az
  map_public_ip_on_launch = false
  tags = {
    Name    = "vay2017-metadata-database-a"
    Purpose = "VAY-2043 isolated restored RDS subnet"
  }
}

resource "aws_subnet" "vay2017_database_b" {
  vpc_id                  = aws_vpc.vay2017_runner.id
  cidr_block              = local.vay2017_database_subnet_b_cidr
  availability_zone       = local.vay2017_rehearsal_second_subnet_az
  map_public_ip_on_launch = false
  tags = {
    Name    = "vay2017-metadata-database-b"
    Purpose = "VAY-2043 isolated restored RDS subnet"
  }
}

resource "aws_db_subnet_group" "vay2017_isolated_restore" {
  name        = "vay2017-metadata-isolated-restore"
  description = "Private subnets for the isolated VAY-2043 snapshot restore"
  subnet_ids  = [aws_subnet.vay2017_database_a.id, aws_subnet.vay2017_database_b.id]
  tags = {
    Name    = "vay2017-metadata-isolated-restore"
    Purpose = "VAY-2043 isolated source snapshot copy"
  }
}

resource "aws_route_table" "vay2017_runner_private" {
  vpc_id = aws_vpc.vay2017_runner.id
  tags = {
    Name    = "vay2017-metadata-runner-private"
    Purpose = "VAY-2043 runner: local, one restored DB /32, and ECR S3 endpoint only"
  }
}

resource "aws_route_table_association" "vay2017_runner_private" {
  subnet_id      = aws_subnet.vay2017_runner_private.id
  route_table_id = aws_route_table.vay2017_runner_private.id
}

resource "aws_route_table" "vay2017_endpoints_private" {
  vpc_id = aws_vpc.vay2017_runner.id
  tags = {
    Name    = "vay2017-metadata-endpoints-private"
    Purpose = "VAY-2043 interface endpoints; local VPC traffic only"
  }
}

resource "aws_route_table_association" "vay2017_endpoints_private" {
  subnet_id      = aws_subnet.vay2017_endpoints_private.id
  route_table_id = aws_route_table.vay2017_endpoints_private.id
}

resource "aws_route_table" "vay2017_database_private" {
  vpc_id = aws_vpc.vay2017_runner.id
  tags = {
    Name    = "vay2017-metadata-database-private"
    Purpose = "VAY-2043 isolated RDS subnets; local route only"
  }
}

resource "aws_route_table_association" "vay2017_database_a" {
  subnet_id      = aws_subnet.vay2017_database_a.id
  route_table_id = aws_route_table.vay2017_database_private.id
}

resource "aws_route_table_association" "vay2017_database_b" {
  subnet_id      = aws_subnet.vay2017_database_b.id
  route_table_id = aws_route_table.vay2017_database_private.id
}

resource "aws_security_group" "vay2017_rehearsal_runner" {
  name        = "vay2017-metadata-runner"
  description = "VAY-2043 runner: only rehearsal PostgreSQL, AWS endpoints, and ECR S3 layers"
  vpc_id      = aws_vpc.vay2017_runner.id
  egress      = []

  tags = {
    Name    = "vay2017-metadata-runner"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }
}

resource "aws_security_group" "vay2017_rehearsal_endpoints" {
  name        = "vay2017-metadata-endpoints"
  description = "HTTPS from the VAY-2043 one-off metadata runner only"
  vpc_id      = aws_vpc.vay2017_runner.id
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
  description                  = "PostgreSQL only to the isolated restored RDS security group"
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
  prefix_list_id    = local.vay2017_rehearsal_s3_prefix_list_id
}

resource "aws_security_group" "vay2017_rehearsal_database" {
  name        = "vay2017-metadata-database"
  description = "Dedicated access group for the VAY-2017 restored rehearsal database"
  vpc_id      = aws_vpc.vay2017_runner.id
  egress      = []

  ingress {
    description     = "PostgreSQL from the fixed metadata runner security group only"
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

resource "aws_db_instance" "vay2017_isolated_restore" {
  identifier                  = local.vay2017_rehearsal_db_instance_id
  snapshot_identifier         = local.vay2017_rehearsal_snapshot_id
  instance_class              = local.vay2017_rehearsal_db_class
  db_subnet_group_name        = aws_db_subnet_group.vay2017_isolated_restore.name
  vpc_security_group_ids      = [aws_security_group.vay2017_rehearsal_database.id]
  availability_zone           = local.vay2017_rehearsal_subnet_az
  publicly_accessible         = false
  multi_az                    = false
  manage_master_user_password = true
  storage_encrypted           = true
  backup_retention_period     = 0
  deletion_protection         = false
  skip_final_snapshot         = true
  copy_tags_to_snapshot       = false

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = local.vay2017_rehearsal_db_instance_id
    Purpose = "VAY-2043 isolated read-only metadata rehearsal copy"
  }
}

resource "aws_vpc_endpoint" "vay2017_interface" {
  for_each = local.vay2017_rehearsal_endpoint_names

  vpc_id              = aws_vpc.vay2017_runner.id
  service_name        = "com.amazonaws.${local.vay2017_rehearsal_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [aws_subnet.vay2017_endpoints_private.id]
  security_group_ids  = [aws_security_group.vay2017_rehearsal_endpoints.id]

  tags = {
    Name    = "vay2017-metadata-${replace(each.key, ".", "-")}"
    Purpose = "VAY-2043 isolated legacy metadata rehearsal"
  }
}

resource "aws_vpc_endpoint" "vay2017_ecr_s3" {
  vpc_id            = aws_vpc.vay2017_runner.id
  service_name      = "com.amazonaws.${local.vay2017_rehearsal_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.vay2017_runner_private.id]
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
    Purpose = "VAY-2043 runner subnet ECR image-layer access only"
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
        StringEquals = { "aws:SourceAccount" = local.vay2017_rehearsal_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:*" }
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
    resources = [local.vay2017_rehearsal_ecr_repository_arn]
  }

  statement {
    sid       = "ReadOnlyRestoredDatabaseMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn]
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
    image     = "${local.vay2017_rehearsal_ecr_repository_url}@${local.vay2017_rehearsal_image_digest}"
    essential = true
    command   = ["node", "--input-type=module", "-e", file("${path.module}/../../scripts/vay2017-rehearsal-metadata.mjs")]
    environment = [
      { name = "VAY2017_RUN_MAIN", value = "1" },
      { name = "VAY2017_RESTORE_INSTANCE_ID", value = local.vay2017_rehearsal_db_instance_id },
      { name = "VAY2017_SOURCE_SNAPSHOT_ID", value = local.vay2017_rehearsal_snapshot_id },
      { name = "VAY2017_RESTORE_RESOURCE_ID", value = aws_db_instance.vay2017_isolated_restore.resource_id },
      { name = "VAY2017_RESTORE_INSTANCE_ARN", value = aws_db_instance.vay2017_isolated_restore.arn },
      { name = "VAY2017_RESTORE_ATTESTATION_CHECKSUM", value = filesha256("${path.module}/../../scripts/fixtures/vay2017-isolated-restore-plan.json") },
      { name = "VAY2017_IMAGE_DIGEST", value = local.vay2017_rehearsal_image_digest },
      { name = "VAY2017_SCANNER_SOURCE_CHECKSUM", value = filesha256("${path.module}/../../scripts/vay2017-rehearsal-metadata.mjs") },
    ]
    secrets = [
      { name = "VAY2017_DB_HOST", valueFrom = "${aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn}:host::" },
      { name = "VAY2017_DB_PORT", valueFrom = "${aws_db_instance.vay2017_isolated_restore.master_user_secret[0].secret_arn}:port::" },
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
      values   = [local.vay2017_rehearsal_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:stateMachine:${local.vay2017_rehearsal_state_machine_name}"]
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
    resources = ["arn:aws:ecs:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:task/${local.vay2017_rehearsal_cluster_name}/*"]
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
      identifiers = ["arn:aws:iam::${local.vay2017_rehearsal_account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:vayada-marketplace/vayada-platform:environment:vay2017-metadata-preflight"]
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
    resources = ["arn:aws:states:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:execution:${local.vay2017_rehearsal_state_machine_name}:*"]
  }
  statement {
    sid       = "ReadOnlySanitizedInventoryLogs"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.vay2017_metadata.arn}:*"]
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
