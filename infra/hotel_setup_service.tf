# Staging never starts a task. Activation and API forwarding need a later release.
variable "enable_hotel_setup_service_staging" {
  type    = bool
  default = false
}
variable "hotel_setup_image_digests" {
  type    = object({ primary = string, rollback = string })
  default = { primary = "", rollback = "" }
  validation {
    condition     = alltrue([for digest in values(var.hotel_setup_image_digests) : digest == "" || can(regex("^sha256:[a-f0-9]{64}$", digest))])
    error_message = "Hotel setup primary/rollback images must use immutable SHA256 digests."
  }
}

locals {
  hotel_setup_images = var.enable_hotel_setup_service_staging ? var.hotel_setup_image_digests : {}
  # An empty reviewed inventory intentionally blocks staging unverified images.
  hotel_setup_image_inventory = jsondecode(file("${path.module}/../deployment/hotel-setup-command-images.json"))
  hotel_setup_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = "8011" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT", value = "postgresql://${var.rds_endpoint}:5432/vayada_target_prod" },
    { name = "HOTEL_SETUP_COMMAND_SECRET_PREFIX", value = local.hotel_setup_property_secret_prefix },
    { name = "HOTEL_SETUP_COMMAND_WORKOS_JWKS_URL", value = var.workos_jwks_url },
    { name = "HOTEL_SETUP_COMMAND_WORKOS_ISSUER", value = var.workos_issuer },
    { name = "HOTEL_SETUP_COMMAND_WORKOS_AUDIENCE", value = var.workos_audience },
    { name = "HOTEL_SETUP_RDS_CA", value = file("${path.module}/../rehearsal/rds-ca-rsa2048-g1.pem") },
    { name = "NODE_EXTRA_CA_CERTS", value = "/runtime/rds-ca.pem" },
  ]
}

resource "aws_cloudwatch_log_group" "hotel_setup" {
  count = var.enable_hotel_setup_service_staging ? 1 : 0

  name              = "/ecs/vayada-hotel-setup"
  retention_in_days = 14
}

resource "aws_iam_role_policy" "hotel_setup_execution_runtime" {
  count = var.enable_hotel_setup_service_staging ? 1 : 0

  name = "hotel-setup-image-and-log-only"
  role = try(aws_iam_role.hotel_setup_execution[0].id, "")
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/vayada-next-api" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.hotel_setup[0].arn}:*" },
    ]
  })
}

resource "aws_ecs_task_definition" "hotel_setup" {
  for_each = local.hotel_setup_images

  family                   = "vayada-hotel-setup-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = try(aws_iam_role.hotel_setup_execution[0].arn, null)
  task_role_arn            = try(aws_iam_role.hotel_setup_task[0].arn, null)
  container_definitions = templatefile("${path.module}/hotel_setup_container.json.tftpl", {
    image_json       = jsonencode("${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/vayada-next-api@${each.value}")
    environment_json = jsonencode(local.hotel_setup_environment)
    reader_arn_json  = jsonencode(try(aws_secretsmanager_secret.hotel_setup["reader_database_url"].arn, ""))
    token_arn_json   = jsonencode(try(aws_secretsmanager_secret.hotel_setup["internal_token"].arn, ""))
    log_group_json   = jsonencode(aws_cloudwatch_log_group.hotel_setup[0].name)
    region_json      = jsonencode(var.aws_region)
  })
  volume { name = "runtime" }
  lifecycle {
    precondition {
      condition = (var.enable_hotel_setup_credential_infrastructure && var.enable_hotel_setup_private_network &&
        can(regex("^[a-f0-9]{40}$", lookup(local.hotel_setup_image_inventory, each.value, ""))) &&
      var.workos_audience != "" && var.workos_issuer != "" && var.workos_jwks_url != "")
      error_message = "Hotel setup staging requires isolated credentials/network, WorkOS configuration and reviewed private-executable image inventory for both primary and rollback."
    }
  }
}

resource "aws_ecs_service" "hotel_setup" {
  count = var.enable_hotel_setup_service_staging ? 1 : 0

  name                   = "vayada-hotel-setup-service"
  cluster                = var.ecs_cluster_name
  task_definition        = aws_ecs_task_definition.hotel_setup["primary"].arn
  desired_count          = 0
  launch_type            = "FARGATE"
  enable_execute_command = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [try(aws_security_group.hotel_setup["task"].id, "")]
    # Existing VPC has public subnets; SG permits no internet ingress. A private
    # subnet/NAT release can replace this pilot without changing command contracts.
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = try(aws_lb_target_group.hotel_setup[0].arn, "")
    container_name   = "hotel-setup"
    container_port   = 8011
  }
  depends_on = [aws_lb_listener.hotel_setup, aws_iam_role_policy.hotel_setup_execution_runtime, aws_iam_role_policy.hotel_setup_execution_secrets, aws_iam_role_policy.hotel_setup_property_secrets]
}
