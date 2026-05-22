locals {
  target_groups = {
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
  }

  listener_rules = {
    booking-admin = {
      priority  = 10
      host      = "admin.booking.vayada.com"
      target_group = "booking-admin"
    }
    admin = {
      priority  = 15
      host      = "admin.vayada.com"
      target_group = "marketplace-admin"
    }
    booking-api = {
      priority  = 20
      host      = "booking-api.vayada.com"
      target_group = "booking-backend"
    }
    marketplace-api = {
      priority  = 25
      host      = "api.vayada.com"
      target_group = "marketplace-backend"
    }
    pms-api = {
      priority  = 30
      host      = "pms-api.vayada.com"
      target_group = "pms-backend"
    }
    pms-frontend = {
      priority  = 40
      host      = "pms.vayada.com"
      target_group = "pms-frontend"
    }
    affiliate = {
      priority  = 45
      host      = "affiliate.vayada.com"
      target_group = "affiliate-dashboard"
    }
    booking-frontend = {
      priority  = 50
      host      = "*.booking.vayada.com"
      target_group = "booking-frontend"
    }
  }
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
