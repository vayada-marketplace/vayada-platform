# Staging never starts a task. Activation and API forwarding need a later release.
variable "enable_hotel_setup_property_service_staging" {
  type    = bool
  default = false
}
variable "hotel_setup_property_image_digests" {
  type    = object({ primary = string, rollback = string })
  default = { primary = "", rollback = "" }
  validation {
    condition     = alltrue([for digest in values(var.hotel_setup_property_image_digests) : digest == "" || can(regex("^sha256:[a-f0-9]{64}$", digest))])
    error_message = "Property setup primary/rollback images must use immutable SHA256 digests."
  }
}

locals {
  hotel_setup_property_images = var.enable_hotel_setup_property_service_staging ? var.hotel_setup_property_image_digests : {}
  # Only independently verified immutable images may be staged.
  hotel_setup_property_image_inventory = jsondecode(file("${path.module}/../deployment/hotel-setup-property-images.json"))
  hotel_setup_property_environment = concat([for entry in local.hotel_setup_environment : {
    name = entry.name
    value = lookup({
      HOTEL_SETUP_COMMAND_MODE          = "property_commands"
      HOTEL_SETUP_COMMAND_SECRET_PREFIX = local.hotel_setup_property_secret_prefix
    }, entry.name, entry.value)
    }], [
    { name = "HOTEL_SETUP_LOGO_COMMAND_ADMISSION", value = var.hotel_setup_logo_private_admission },
    { name = "PLATFORM_MEDIA_BUCKET", value = aws_s3_bucket.private_profile_media.id },
    { name = "PLATFORM_MEDIA_CDN_BASE_URL", value = local.private_profile_media_cdn_base_url },
    { name = "PLATFORM_MEDIA_CDN_ORIGIN_HOST", value = aws_s3_bucket.private_profile_media.bucket_regional_domain_name },
    { name = "PLATFORM_MEDIA_PUBLIC_PATH_PREFIX", value = "media" },
    { name = "PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL", value = "public, max-age=31536000, immutable" },
  ])
}

resource "aws_cloudwatch_log_group" "hotel_setup_property" {
  count = var.enable_hotel_setup_property_service_staging ? 1 : 0

  name              = "/ecs/vayada-hotel-setup-property"
  retention_in_days = 14
}

resource "aws_iam_role_policy" "hotel_setup_property_execution_runtime" {
  count = var.enable_hotel_setup_property_service_staging ? 1 : 0

  name = "hotel-setup-property-image-and-log-only"
  role = try(aws_iam_role.hotel_setup_property_execution[0].id, "")
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/vayada-next-api" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.hotel_setup_property[0].arn}:*" },
    ]
  })
}

resource "aws_ecs_task_definition" "hotel_setup_property" {
  for_each = local.hotel_setup_property_images

  family                   = "vayada-hotel-setup-property-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  skip_destroy             = true
  execution_role_arn       = try(aws_iam_role.hotel_setup_property_execution[0].arn, null)
  task_role_arn            = try(aws_iam_role.hotel_setup_property_task[0].arn, null)
  container_definitions = templatefile("${path.module}/hotel_setup_container.json.tftpl", {
    image_json       = jsonencode("${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/vayada-next-api@${each.value}")
    environment_json = jsonencode(local.hotel_setup_property_environment)
    reader_arn_json  = jsonencode(try(aws_secretsmanager_secret.hotel_setup_property["reader_database_url"].arn, ""))
    token_arn_json   = jsonencode(try(aws_secretsmanager_secret.hotel_setup_property["internal_token"].arn, ""))
    log_group_json   = jsonencode(aws_cloudwatch_log_group.hotel_setup_property[0].name)
    region_json      = jsonencode(var.aws_region)
  })
  volume { name = "runtime" }
  lifecycle {
    precondition {
      condition = (var.hotel_setup_logo_private_admission == "blocked" ||
      (var.enable_hotel_setup_logo_storage && can(regex("^[a-f0-9]{40}$", lookup(local.hotel_setup_logo_image_inventory, each.value, "")))))
      error_message = "Enabled logo tasks require scoped storage and full lifecycle proof for both immutable primary and rollback images."
    }
    precondition {
      condition = (var.enable_hotel_setup_property_credentials && var.enable_hotel_setup_property_network &&
        can(regex("^[a-f0-9]{40}$", lookup(local.hotel_setup_property_image_inventory, each.value, ""))) &&
      var.workos_audience != "" && var.workos_issuer != "" && var.workos_jwks_url != "")
      error_message = "Property setup staging requires isolated credentials/network, WorkOS configuration and reviewed private-executable image inventory for both primary and rollback."
    }
  }
}

resource "aws_ecs_service" "hotel_setup_property" {
  count = var.enable_hotel_setup_property_service_staging ? 1 : 0

  name                   = "vayada-hotel-setup-property-service"
  cluster                = var.ecs_cluster_name
  task_definition        = aws_ecs_task_definition.hotel_setup_property["primary"].arn
  desired_count          = 0
  launch_type            = "FARGATE"
  enable_execute_command = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [try(aws_security_group.hotel_setup_property_task[0].id, "")]
    # Existing VPC has public subnets; SG permits no internet ingress. A private
    # subnet/NAT release can replace this pilot without changing command contracts.
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = try(aws_lb_target_group.hotel_setup_property[0].arn, "")
    container_name   = "hotel-setup"
    container_port   = 8011
  }
  lifecycle {
    prevent_destroy = true
    # The reviewed normal-CI release owns activation and immutable task selection.
    ignore_changes = [desired_count, task_definition]
  }

  depends_on = [aws_lb_listener_rule.hotel_setup_property, aws_iam_role_policy.hotel_setup_property_execution_runtime, aws_iam_role_policy.hotel_setup_property_execution_secrets, aws_iam_role_policy.hotel_setup_property_native_secrets, aws_iam_role_policy.hotel_setup_logo_media]
}
