# No API attachment or service launch: those need separate reviewed cutover.
variable "enable_hotel_setup_private_network" {
  description = "Stage the isolated hotel-setup internal HTTPS network"
  type        = bool
  default     = false
}

locals {
  hotel_setup_hostname = "hotel-setup-command.vayada.com"
  hotel_setup_security_groups = var.enable_hotel_setup_private_network ? {
    caller = "Supplemental marker for the next API only; not attached here"
    alb    = "Hotel setup internal HTTPS: dedicated next API caller only"
    task   = "Hotel setup task: internal ALB only"
  } : {}
  hotel_setup_network_rules = var.enable_hotel_setup_private_network ? {
    alb_from_caller = { type = "ingress", port = 443, owner = "alb", peer = "caller" }
    caller_to_alb   = { type = "egress", port = 443, owner = "caller", peer = "alb" }
    task_from_alb   = { type = "ingress", port = 8011, owner = "task", peer = "alb" }
    alb_to_task     = { type = "egress", port = 8011, owner = "alb", peer = "task" }
  } : {}
}

resource "aws_security_group" "hotel_setup" {
  for_each = local.hotel_setup_security_groups

  name        = "vayada-hotel-setup-${each.key}"
  description = each.value
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "hotel_setup_internal" {
  for_each = local.hotel_setup_network_rules

  type                     = each.value.type
  from_port                = each.value.port
  to_port                  = each.value.port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.hotel_setup[each.value.peer].id
  security_group_id        = aws_security_group.hotel_setup[each.value.owner].id
}

# HTTPS is needed for WorkOS JWKS and AWS APIs. SGs cannot pin DNS destinations.
resource "aws_security_group_rule" "hotel_setup_https" {
  count = var.enable_hotel_setup_private_network ? 1 : 0

  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.hotel_setup["task"].id
}

resource "aws_security_group_rule" "hotel_setup_database" {
  for_each = var.enable_hotel_setup_private_network ? toset(["ingress", "egress"]) : toset([])

  type                     = each.value
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = each.value == "ingress" ? aws_security_group.hotel_setup["task"].id : var.rds_sg_id
  security_group_id        = each.value == "ingress" ? var.rds_sg_id : aws_security_group.hotel_setup["task"].id
}

resource "aws_lb" "hotel_setup" {
  count = var.enable_hotel_setup_private_network ? 1 : 0

  name                       = "vayada-hotel-setup"
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = var.subnet_ids
  security_groups            = [aws_security_group.hotel_setup["alb"].id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "hotel_setup" {
  count = var.enable_hotel_setup_private_network ? 1 : 0

  name                 = "vayada-hotel-setup"
  port                 = 8011
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = 30
  health_check {
    # Startup DB guards run before listen. No token/bearer is used by the ALB.
    path                = "/"
    matcher             = "401"
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "hotel_setup" {
  count = var.enable_hotel_setup_private_network ? 1 : 0

  load_balancer_arn = aws_lb.hotel_setup[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.wildcard_vayada.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "hotel_setup_creation" {
  count = var.enable_hotel_setup_private_network ? 1 : 0

  listener_arn = aws_lb_listener.hotel_setup[0].arn
  priority     = 1
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.hotel_setup[0].arn
  }
  condition {
    host_header { values = [local.hotel_setup_hostname] }
  }
}

# A host-specific zone avoids shadowing all public vayada.com records in this VPC.
resource "aws_route53_zone" "hotel_setup" {
  count = var.enable_hotel_setup_private_network ? 1 : 0

  name = local.hotel_setup_hostname
  vpc { vpc_id = var.vpc_id }
}

resource "aws_route53_record" "hotel_setup" {
  count = var.enable_hotel_setup_private_network ? 1 : 0

  zone_id = aws_route53_zone.hotel_setup[0].zone_id
  name    = local.hotel_setup_hostname
  type    = "A"
  alias {
    name                   = aws_lb.hotel_setup[0].dns_name
    zone_id                = aws_lb.hotel_setup[0].zone_id
    evaluate_target_health = true
  }
}
