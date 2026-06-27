locals {
  base_target_groups = {
    booking-backend = {
      name         = "booking-backend-tg"
      port         = 8001
      health_check = "/health"
    }
    booking-frontend = {
      name         = "booking-frontend-tg"
      port         = 3002
      health_check = "/en"
    }
    booking-admin = {
      name         = "booking-admin-tg"
      port         = 3003
      health_check = "/"
    }
    pms-backend = {
      name         = "pms-backend-tg"
      port         = 8002
      health_check = "/health"
    }
    pms-frontend = {
      name         = "pms-frontend-tg"
      port         = 3004
      health_check = "/"
    }
    marketplace-backend = {
      name         = "marketplace-backend-tg"
      port         = 8000
      health_check = "/health"
    }
    marketplace-admin = {
      name         = "marketplace-admin-tg"
      port         = 3001
      health_check = "/"
    }
    affiliate-dashboard = {
      name         = "affiliate-dashboard-tg"
      port         = 3005
      health_check = "/"
    }
    target-backend = {
      name         = "target-backend-tg"
      port         = 8003
      health_check = "/health"
    }
    next-target-backend = {
      name         = "next-target-backend-tg"
      port         = 8003
      health_check = "/health"
    }
    next-pms-frontend = {
      name         = "next-pms-frontend-tg"
      port         = 3004
      health_check = "/"
    }
    next-booking-frontend = {
      name         = "next-booking-front-tg"
      port         = 3002
      health_check = "/en"
    }
    next-booking-admin = {
      name         = "next-booking-admin-tg"
      port         = 3003
      health_check = "/"
    }
    next-marketplace-admin = {
      name         = "next-mkt-admin-tg"
      port         = 3001
      health_check = "/"
    }
    next-marketplace-frontend = {
      name         = "next-mkt-front-tg"
      port         = 3000
      health_check = "/api/health"
    }
    next-affiliate-dashboard = {
      name         = "next-affiliate-tg"
      port         = 3005
      health_check = "/"
    }
  }

  staging_pms_target_groups = var.enable_staging_pms_runtime ? {
    staging-pms-backend = {
      name         = "staging-pms-backend-tg"
      port         = 8002
      health_check = "/health"
    }
  } : {}

  target_groups = merge(local.base_target_groups, local.staging_pms_target_groups)

  base_listener_rules = {
    booking-admin = {
      priority     = 10
      host         = "admin.booking.vayada.com"
      target_group = "booking-admin"
    }
    admin = {
      priority     = 15
      host         = "admin.vayada.com"
      target_group = "marketplace-admin"
    }
    booking-api = {
      priority     = 20
      host         = "booking-api.vayada.com"
      target_group = "next-target-backend"
    }
    marketplace-api = {
      priority     = 25
      host         = "api.vayada.com"
      target_group = "next-target-backend"
    }
    pms-api-provider-webhooks = {
      priority     = 28
      host         = "pms-api.vayada.com"
      paths        = ["/webhooks/*"]
      target_group = "pms-backend"
    }
    pms-api = {
      priority     = 30
      host         = "pms-api.vayada.com"
      target_group = "next-target-backend"
    }
    pms-frontend = {
      priority     = 40
      host         = "pms.vayada.com"
      target_group = "pms-frontend"
    }
    affiliate = {
      priority     = 45
      host         = "affiliate.vayada.com"
      target_group = "affiliate-dashboard"
    }
    booking-root = {
      priority     = 46
      host         = "booking.vayada.com"
      target_group = "booking-frontend"
    }
    target-api = {
      priority     = 47
      host         = "target-api.vayada.com"
      target_group = "target-backend"
    }
    next-api = {
      priority     = 48
      host         = "next-api.vayada.com"
      target_group = "next-target-backend"
    }
    next-pms-frontend = {
      priority     = 49
      host         = "next-pms.vayada.com"
      target_group = "next-pms-frontend"
    }
    next-admin = {
      priority     = 51
      host         = "next-admin.vayada.com"
      target_group = "next-marketplace-admin"
    }
    next-booking-admin = {
      priority     = 52
      host         = "next-booking-admin.vayada.com"
      target_group = "next-booking-admin"
    }
    next-booking = {
      priority     = 53
      host         = "next-booking.vayada.com"
      target_group = "next-booking-frontend"
    }
    next-booking-wildcard = {
      priority     = 54
      host         = "*.next-booking.vayada.com"
      target_group = "next-booking-frontend"
    }
    next-marketplace = {
      priority     = 55
      host         = "next-marketplace.vayada.com"
      target_group = "next-marketplace-frontend"
    }
    next-affiliate = {
      priority     = 56
      host         = "next-affiliate.vayada.com"
      target_group = "next-affiliate-dashboard"
    }
    booking-frontend = {
      priority     = 50
      host         = "*.booking.vayada.com"
      target_group = "booking-frontend"
    }
  }

  staging_pms_listener_rules = var.enable_staging_pms_runtime ? {
    staging-pms-api = {
      priority     = 35
      host         = "staging-pms-api.vayada.com"
      target_group = "staging-pms-backend"
    }
  } : {}

  listener_rules = merge(local.base_listener_rules, local.staging_pms_listener_rules)
}

resource "aws_lb_target_group" "services" {
  for_each = local.target_groups

  name        = each.value.name
  port        = each.value.port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 3
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = each.value.health_check
    protocol            = "HTTP"
    matcher             = "200-399"
  }

  tags = {
    Name = each.value.name
  }
}

resource "aws_lb_listener_rule" "services" {
  for_each = local.listener_rules

  listener_arn = data.aws_lb_listener.https.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.services[each.value.target_group].arn
  }

  condition {
    host_header {
      values = [each.value.host]
    }
  }

  dynamic "condition" {
    for_each = try(each.value.paths, null) == null ? [] : [each.value.paths]

    content {
      path_pattern {
        values = condition.value
      }
    }
  }

  tags = {
    Name = each.key
  }
}

# Default action: forward unmatched traffic (custom domains) to booking frontend
resource "aws_lb_listener_rule" "default_booking_frontend" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = 99

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.services["booking-frontend"].arn
  }

  # Match everything not caught by higher-priority rules
  condition {
    path_pattern {
      values = ["/*"]
    }
  }

  tags = {
    Name = "default-custom-domains"
  }
}
