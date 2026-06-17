locals {
  base_services = {
    booking-backend = {
      name           = "vayada-booking-backend"
      container_port = 8001
      cpu            = 256
      memory         = 512
      health_check   = "/health"
      log_group      = "/ecs/vayada-booking-backend"
      environment = [
        { name = "CORS_ORIGINS", value = "https://admin.booking.vayada.com,https://admin.vayada.com,https://pms.vayada.com" },
        { name = "CORS_ORIGIN_REGEX", value = ".*" },
        { name = "API_PORT", value = "8001" },
        { name = "CLOUDFLARE_ZONE_ID", value = var.cloudflare_zone_id },
        { name = "FRONTEND_URL", value = "https://admin.booking.vayada.com" },
        { name = "EMAIL_ENABLED", value = "true" },
        { name = "EMAIL_SERVICE_PROVIDER", value = "smtp" },
        { name = "EMAIL_FROM_ADDRESS", value = "noreply@vayada.com" },
        { name = "EMAIL_FROM_NAME", value = "vayada" },
        { name = "SMTP_HOST", value = "email-smtp.eu-west-1.amazonaws.com" },
        { name = "SMTP_PORT", value = "587" },
        { name = "SMTP_USE_TLS", value = "true" },
        { name = "ENVIRONMENT", value = "production" },
        { name = "DEBUG", value = "false" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = "/vayada/prod/db-booking-url" },
        { name = "AUTH_DATABASE_URL", valueFrom = "/vayada/prod/db-auth-url" },
        { name = "PMS_DATABASE_URL", valueFrom = "/vayada/prod/db-pms-url" },
        { name = "JWT_SECRET_KEY", valueFrom = "/vayada/prod/jwt-secret-key" },
        { name = "CLOUDFLARE_API_TOKEN", valueFrom = "/vayada/prod/cloudflare-api-token" },
        { name = "SMTP_USER", valueFrom = "/vayada/prod/smtp-username" },
        { name = "SMTP_PASSWORD", valueFrom = "/vayada/prod/smtp-password" },
      ]
    }
    booking-frontend = {
      name           = "vayada-booking-frontend"
      container_port = 3002
      cpu            = 256
      memory         = 512
      health_check   = "/en"
      log_group      = "/ecs/vayada-booking-frontend"
      environment = [
        { name = "NEXT_PUBLIC_API_URL", value = "https://target-api.vayada.com" },
        { name = "NEXT_PUBLIC_BOOKING_WEB_API_URL", value = "https://target-api.vayada.com" },
        { name = "NEXT_PUBLIC_PMS_API_URL", value = "https://target-api.vayada.com" },
        { name = "NEXT_PUBLIC_PMS_URL", value = "https://target-api.vayada.com" },
        { name = "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", value = var.stripe_publishable_key },
      ]
      secrets = []
    }
    booking-admin = {
      name           = "vayada-booking-admin"
      container_port = 3003
      cpu            = 256
      memory         = 512
      health_check   = "/"
      log_group      = "/ecs/vayada-booking-admin"
      environment = [
        { name = "NEXT_PUBLIC_API_URL", value = "https://target-api.vayada.com" },
        { name = "NEXT_PUBLIC_AUTH_API_URL", value = "https://target-api.vayada.com" },
      ]
      secrets = []
    }
    pms-backend = {
      name           = "vayada-pms-backend"
      container_port = 8002
      cpu            = 256
      memory         = 512
      health_check   = "/health"
      log_group      = "/ecs/vayada-pms-backend"
      environment = [
        { name = "CORS_ORIGINS", value = "https://pms.vayada.com,https://admin.booking.vayada.com,https://admin.vayada.com" },
        { name = "CORS_ORIGIN_REGEX", value = ".*" },
        { name = "API_PORT", value = "8002" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET_NAME", value = "vayada-uploads-prod" },
        { name = "SMTP_HOST", value = "email-smtp.eu-west-1.amazonaws.com" },
        { name = "SMTP_PORT", value = "587" },
        { name = "SMTP_FROM", value = "noreply@vayada.com" },
        { name = "STRIPE_PLATFORM_ACCOUNT_ID", value = var.stripe_platform_account_id },
        { name = "BOOKING_ENGINE_API_URL", value = "https://booking-api.vayada.com" },
        { name = "CHANNEX_API_BASE_URL", value = "https://app.channex.io" },
        { name = "ENVIRONMENT", value = "production" },
        { name = "DEBUG", value = "false" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = "/vayada/prod/db-pms-url" },
        { name = "AUTH_DATABASE_URL", valueFrom = "/vayada/prod/db-auth-url" },
        # Booking-engine DB is read by the PMS backend for:
        #  - multi-hotel ID mapping (dashboard + booking-engine cross-DB joins)
        #  - currency sync during payment settings updates
        #  - room-creation fallback when PMS payment settings don't exist yet
        { name = "BOOKING_ENGINE_DATABASE_URL", valueFrom = "/vayada/prod/db-booking-url" },
        { name = "JWT_SECRET_KEY", valueFrom = "/vayada/prod/jwt-secret-key" },
        { name = "SMTP_USERNAME", valueFrom = "/vayada/prod/smtp-username" },
        { name = "SMTP_PASSWORD", valueFrom = "/vayada/prod/smtp-password" },
        { name = "STRIPE_SECRET_KEY", valueFrom = "/vayada/prod/stripe-secret-key" },
        { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "/vayada/prod/stripe-webhook-secret" },
        { name = "CHANNEX_API_KEY", valueFrom = "/vayada/prod/channex-api-key" },
        { name = "ANTHROPIC_API_KEY", valueFrom = "/vayada/prod/anthropic-api-key" },
        { name = "FIRECRAWL_API_KEY", valueFrom = "/vayada/prod/firecrawl-api-key" },
      ]
    }
    pms-frontend = {
      name           = "vayada-pms-frontend"
      container_port = 3004
      cpu            = 256
      memory         = 512
      health_check   = "/"
      log_group      = "/ecs/vayada-pms-frontend"
      environment = [
        { name = "NEXT_PUBLIC_AUTH_API_URL", value = "https://booking-api.vayada.com" },
        { name = "NEXT_PUBLIC_PMS_API_URL", value = "https://pms-api.vayada.com" },
      ]
      secrets = []
    }
    marketplace-backend = {
      name           = "vayada-marketplace-backend"
      container_port = 8000
      cpu            = 256
      memory         = 512
      health_check   = "/health"
      log_group      = "/ecs/vayada-marketplace-backend"
      environment = [
        # vayada.com = marketing site (contact form + /hotel-creator-network
        # live-data fetch); app.vayada.com = the creator marketplace app.
        # Both also match CORS_ORIGIN_REGEX below; listed explicitly for clarity.
        { name = "CORS_ORIGINS", value = "https://admin.vayada.com,https://vayada.com,https://app.vayada.com" },
        { name = "CORS_ORIGIN_REGEX", value = "https://(.*\\.)?vayada\\.com" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET_NAME", value = "vayada-uploads-prod" },
        { name = "SMTP_HOST", value = "email-smtp.eu-west-1.amazonaws.com" },
        { name = "SMTP_PORT", value = "587" },
        { name = "SMTP_FROM", value = "noreply@vayada.com" },
        { name = "ENVIRONMENT", value = "production" },
        { name = "DEBUG", value = "false" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = "/vayada/prod/db-marketplace-url" },
        { name = "AUTH_DATABASE_URL", valueFrom = "/vayada/prod/db-auth-url-ssl" },
        { name = "PMS_DATABASE_URL", valueFrom = "/vayada/prod/db-pms-url-ssl" },
        { name = "JWT_SECRET_KEY", valueFrom = "/vayada/prod/jwt-secret-key" },
        { name = "SMTP_USERNAME", valueFrom = "/vayada/prod/smtp-username" },
        { name = "SMTP_PASSWORD", valueFrom = "/vayada/prod/smtp-password" },
      ]
    }
    marketplace-admin = {
      name           = "vayada-marketplace-admin"
      container_port = 3001
      cpu            = 256
      memory         = 512
      health_check   = "/"
      log_group      = "/ecs/vayada-marketplace-admin"
      environment = [
        { name = "NEXT_PUBLIC_API_URL", value = "https://api.vayada.com" },
      ]
      secrets = []
    }
    affiliate-dashboard = {
      name           = "vayada-affiliate-dashboard"
      container_port = 3005
      cpu            = 256
      memory         = 512
      health_check   = "/"
      log_group      = "/ecs/vayada-affiliate-dashboard"
      environment = [
        { name = "NEXT_PUBLIC_API_URL", value = "https://pms-api.vayada.com" },
        { name = "NEXT_PUBLIC_AUTH_API_URL", value = "https://booking-api.vayada.com" },
      ]
      secrets = []
    }
    target-backend = {
      name           = "vayada-api"
      container_port = 8003
      cpu            = 512
      memory         = 1024
      desired_count  = var.target_backend_desired_count
      health_check   = "/health"
      log_group      = "/ecs/vayada-api"
      environment = concat([
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = "8003" },
        { name = "NODE_ENV", value = "production" },
        { name = "ENVIRONMENT", value = var.target_backend_production_cutover_enabled ? "production" : "staging" },
        { name = "STRIPE_WEBHOOK_INTAKE_MODE", value = "observe_only" },
        { name = "XENDIT_WEBHOOK_INTAKE_MODE", value = "observe_only" },
        { name = "CHANNEX_WEBHOOK_INTAKE_MODE", value = "observe_only" },
        { name = "MARKETPLACE_DISCOVERY_ALLOWED_ORIGINS", value = "https://app.vayada.com,https://vayada.com" },
        { name = "PMS_OPERATIONS_ALLOWED_ORIGINS", value = "https://pms.vayada.com" },
        ], var.target_backend_production_cutover_enabled ? [
        { name = "PUBLIC_HOTEL_PROFILE_SOURCE", value = "target" },
        { name = "BOOKING_DOMAIN_RESOLUTION_SOURCE", value = "target" },
        { name = "PUBLIC_BOOKABILITY_SOURCE", value = "target" },
        { name = "BOOKING_SETTINGS_SOURCE", value = "target" },
        { name = "BOOKING_RESERVATIONS_SOURCE", value = "target" },
        { name = "MARKETPLACE_DISCOVERY_SOURCE", value = "target" },
        { name = "MARKETPLACE_ADMIN_SOURCE", value = "target" },
        { name = "PMS_OPERATIONS_SOURCE", value = "target" },
        { name = "FINANCE_SOURCE", value = "target" },
        { name = "AFFILIATE_PUBLIC_SOURCE", value = "target" },
        { name = "BOOKING_CHECKOUT_COMMAND_SOURCE", value = "target" },
        { name = "BOOKING_WEB_EVENT_SINK", value = "target" },
        { name = "BOOKING_WEB_LEGACY_CHECKOUT_COMMAND_PROXY_ENABLED", value = "false" },
        { name = "BOOKING_HOST_BASE", value = "https://booking.vayada.com" },
        { name = "WORKOS_CLIENT_ID", value = var.workos_client_id },
        { name = "WORKOS_AUDIENCE", value = var.workos_audience },
        { name = "WORKOS_ISSUER", value = var.workos_issuer },
        { name = "WORKOS_JWKS_URL", value = var.workos_jwks_url },
        { name = "AUTH_CALLBACK_URL", value = "https://target-api.vayada.com/auth/workos/callback" },
        { name = "AUTH_SUCCESS_URL", value = "https://app.vayada.com/dashboard" },
        { name = "AUTH_LOGOUT_URL", value = "https://app.vayada.com/login" },
        { name = "AUTH_ALLOWED_ORIGINS", value = "https://target-api.vayada.com,https://app.vayada.com,https://admin.vayada.com,https://admin.booking.vayada.com,https://pms.vayada.com,https://affiliate.vayada.com,https://booking.vayada.com,https://vayada.com" },
        { name = "AUTH_COOKIE_DOMAIN", value = ".vayada.com" },
        { name = "AUTH_COOKIE_SECURE", value = "true" },
        { name = "AUTH_BOOKING_ADMIN_SUCCESS_URL", value = "https://admin.booking.vayada.com/dashboard" },
        { name = "AUTH_BOOKING_ADMIN_LOGOUT_URL", value = "https://admin.booking.vayada.com/login" },
        { name = "AUTH_PMS_WEB_SUCCESS_URL", value = "https://pms.vayada.com/dashboard" },
        { name = "AUTH_PMS_WEB_LOGOUT_URL", value = "https://pms.vayada.com/login" },
        { name = "AUTH_AFFILIATE_DASHBOARD_SUCCESS_URL", value = "https://affiliate.vayada.com/dashboard" },
        { name = "AUTH_AFFILIATE_DASHBOARD_LOGOUT_URL", value = "https://affiliate.vayada.com/login" },
      ] : [])
      secrets = concat([
        { name = "TARGET_DATABASE_URL", valueFrom = "/vayada/staging/target-database-url" },
        { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "/vayada/staging/stripe-webhook-secret" },
        { name = "XENDIT_WEBHOOK_SECRET", valueFrom = "/vayada/staging/xendit-webhook-secret" },
        { name = "CHANNEX_WEBHOOK_SECRET", valueFrom = "/vayada/staging/channex-webhook-secret" },
        ], var.target_backend_production_cutover_enabled ? [
        { name = "AUTH_DATABASE_URL", valueFrom = "/vayada/prod/db-auth-url-ssl" },
        { name = "WORKOS_API_KEY", valueFrom = "/vayada/prod/workos-api-key" },
        { name = "AUTH_COOKIE_SECRET", valueFrom = "/vayada/prod/auth-cookie-secret" },
        { name = "AUTH_LEGACY_MARKETPLACE_JWT_SECRET", valueFrom = "/vayada/prod/jwt-secret-key" },
        { name = "AUTH_LEGACY_BOOKING_JWT_SECRET", valueFrom = "/vayada/prod/jwt-secret-key" },
        { name = "AUTH_LEGACY_PMS_JWT_SECRET", valueFrom = "/vayada/prod/jwt-secret-key" },
        { name = "AUTH_LEGACY_AFFILIATE_PMS_JWT_SECRET", valueFrom = "/vayada/prod/jwt-secret-key" },
      ] : [])
    }
  }

  staging_pms_service = var.enable_staging_pms_runtime ? {
    staging-pms-backend = {
      name           = "vayada-staging-pms-backend"
      container_port = 8002
      cpu            = 256
      memory         = 512
      health_check   = "/health"
      log_group      = "/ecs/vayada-staging-pms-backend"
      environment = [
        { name = "CORS_ORIGINS", value = "https://staging-pms-api.vayada.com" },
        { name = "CORS_ORIGIN_REGEX", value = "" },
        { name = "API_PORT", value = "8002" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET_NAME", value = "vayada-uploads-prod" },
        { name = "SMTP_HOST", value = "email-smtp.eu-west-1.amazonaws.com" },
        { name = "SMTP_PORT", value = "587" },
        { name = "SMTP_FROM", value = "noreply@vayada.com" },
        { name = "STRIPE_PLATFORM_ACCOUNT_ID", value = var.stripe_platform_account_id },
        { name = "BOOKING_ENGINE_API_URL", value = "https://booking-api.vayada.com" },
        { name = "CHANNEX_API_BASE_URL", value = "https://app.channex.io" },
        { name = "ENVIRONMENT", value = "staging" },
        { name = "DEBUG", value = "false" },
        { name = "PMS_SCHEDULER_ENABLED", value = "false" },
        { name = "PMS_LEGACY_WEBHOOK_MODE", value = "ack_only_with_receipt" },
        { name = "PMS_LEGACY_STRIPE_WEBHOOK_MODE", value = "ack_only_with_receipt" },
        { name = "PMS_LEGACY_XENDIT_WEBHOOK_MODE", value = "ack_only_with_receipt" },
        { name = "PMS_LEGACY_CHANNEX_WEBHOOK_MODE", value = "ack_only_with_receipt" },
        { name = "CHANNEX_ADMIN_DEFAULT_MODE", value = "disabled" },
        { name = "FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE", value = "disabled" },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = "/vayada/staging/pms-database-url" },
        { name = "AUTH_DATABASE_URL", valueFrom = "/vayada/prod/db-auth-url" },
        { name = "BOOKING_ENGINE_DATABASE_URL", valueFrom = "/vayada/prod/db-booking-url" },
        { name = "JWT_SECRET_KEY", valueFrom = "/vayada/prod/jwt-secret-key" },
        { name = "SMTP_USERNAME", valueFrom = "/vayada/prod/smtp-username" },
        { name = "SMTP_PASSWORD", valueFrom = "/vayada/prod/smtp-password" },
        { name = "STRIPE_SECRET_KEY", valueFrom = "/vayada/prod/stripe-secret-key" },
        { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "/vayada/staging/stripe-webhook-secret" },
        { name = "CHANNEX_API_KEY", valueFrom = "/vayada/prod/channex-api-key" },
        { name = "ANTHROPIC_API_KEY", valueFrom = "/vayada/prod/anthropic-api-key" },
        { name = "FIRECRAWL_API_KEY", valueFrom = "/vayada/prod/firecrawl-api-key" },
      ]
    }
  } : {}

  services = merge(local.base_services, local.staging_pms_service)

  # Map from service key to ECR repo name
  ecr_repo_map = {
    "booking-backend"     = "vayada-booking-backend"
    "booking-frontend"    = "vayada-booking-frontend"
    "booking-admin"       = "vayada-booking-admin-frontend"
    "pms-backend"         = "vayada-pms-backend"
    "pms-frontend"        = "vayada-pms-frontend"
    "marketplace-backend" = "vayada-creator-marketplace-backend"
    "marketplace-admin"   = "vayada-admin-frontend"
    "affiliate-dashboard" = "vayada-affiliate-dashboard"
    "staging-pms-backend" = "vayada-pms-backend"
    "target-backend"      = "vayada-api"
  }
}

resource "aws_ecs_task_definition" "services" {
  for_each = local.services

  family                   = each.value.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = data.aws_iam_role.ecs_task_execution.arn
  task_role_arn            = data.aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = each.value.name
      image     = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${local.ecr_repo_map[each.key]}:latest"
      essential = true

      portMappings = [
        {
          containerPort = each.value.container_port
          hostPort      = each.value.container_port
          protocol      = "tcp"
        }
      ]

      environment = each.value.environment
      secrets = length(each.value.secrets) > 0 ? [
        for s in each.value.secrets : {
          name      = s.name
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${s.valueFrom}"
        }
      ] : null

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = each.value.log_group
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = contains(["staging-pms-backend", "target-backend"], each.key) ? {} : {
    Service = each.value.name
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_ecs_service" "services" {
  for_each = local.services

  name            = "${each.value.name}-service"
  cluster         = data.aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services[each.key].arn
  desired_count   = try(each.value.desired_count, 1)
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.services[each.key].arn
    container_name   = each.value.name
    container_port   = each.value.container_port
  }

  depends_on = [
    aws_lb_listener_rule.services,
  ]

  lifecycle {
    ignore_changes = [task_definition]

    precondition {
      condition = (
        each.key != "target-backend" ||
        var.target_backend_desired_count == 0 ||
        var.manage_staging_rehearsal_secrets ||
        var.target_backend_staging_secrets_preprovisioned
      )
      error_message = "target_backend_desired_count can only be greater than 0 when Terraform manages the staging rehearsal SSM parameters or target_backend_staging_secrets_preprovisioned is true. Required parameters: /vayada/staging/target-database-url, /vayada/staging/stripe-webhook-secret, /vayada/staging/xendit-webhook-secret, /vayada/staging/channex-webhook-secret."
    }
  }

  tags = contains(["staging-pms-backend", "target-backend"], each.key) ? {} : {
    Service = each.value.name
  }
}
