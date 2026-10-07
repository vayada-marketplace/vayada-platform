variable "enable_hotel_setup_property_network" {
  description = "Stage a separate property-command destination on the private HTTPS listener"
  type        = bool
  default     = false
}

locals {
  hotel_setup_property_hostname = "hotel-setup-property-command.vayada.com"
}

resource "aws_security_group" "hotel_setup_property_task" {
  count = var.enable_hotel_setup_property_network ? 1 : 0

  name        = "vayada-hotel-setup-property-task"
  description = "Property setup task: internal hotel setup ALB only"
  vpc_id      = var.vpc_id
  lifecycle {
    precondition {
      condition     = var.enable_hotel_setup_private_network
      error_message = "Property setup network requires the shared private hotel setup network."
    }
  }
}

resource "aws_security_group_rule" "hotel_setup_property_alb" {
  for_each = var.enable_hotel_setup_property_network ? toset(["ingress", "egress"]) : toset([])

  type                     = each.value
  from_port                = 8011
  to_port                  = 8011
  protocol                 = "tcp"
  source_security_group_id = each.value == "ingress" ? try(aws_security_group.hotel_setup["alb"].id, "") : aws_security_group.hotel_setup_property_task[0].id
  security_group_id        = each.value == "ingress" ? aws_security_group.hotel_setup_property_task[0].id : try(aws_security_group.hotel_setup["alb"].id, "")
}

resource "aws_security_group_rule" "hotel_setup_property_database" {
  for_each = var.enable_hotel_setup_property_network ? toset(["ingress", "egress"]) : toset([])

  type                     = each.value
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = each.value == "ingress" ? aws_security_group.hotel_setup_property_task[0].id : var.rds_sg_id
  security_group_id        = each.value == "ingress" ? var.rds_sg_id : aws_security_group.hotel_setup_property_task[0].id
}

resource "aws_security_group_rule" "hotel_setup_property_https" {
  count = var.enable_hotel_setup_property_network ? 1 : 0

  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.hotel_setup_property_task[0].id
}

resource "aws_lb_target_group" "hotel_setup_property" {
  count = var.enable_hotel_setup_property_network ? 1 : 0

  name                 = "vayada-hotel-setup-property"
  port                 = 8011
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/"
    matcher             = "401"
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener_rule" "hotel_setup_property" {
  count = var.enable_hotel_setup_property_network ? 1 : 0

  listener_arn = try(aws_lb_listener.hotel_setup[0].arn, "")
  priority     = 2
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.hotel_setup_property[0].arn
  }
  condition {
    host_header { values = [local.hotel_setup_property_hostname] }
  }
}

resource "aws_route53_zone" "hotel_setup_property" {
  count = var.enable_hotel_setup_property_network ? 1 : 0

  name = local.hotel_setup_property_hostname
  vpc { vpc_id = var.vpc_id }
}

resource "aws_route53_record" "hotel_setup_property" {
  count = var.enable_hotel_setup_property_network ? 1 : 0

  zone_id = aws_route53_zone.hotel_setup_property[0].zone_id
  name    = local.hotel_setup_property_hostname
  type    = "A"
  alias {
    name                   = try(aws_lb.hotel_setup[0].dns_name, "")
    zone_id                = try(aws_lb.hotel_setup[0].zone_id, "")
    evaluate_target_health = true
  }
}
