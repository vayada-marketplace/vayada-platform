# Pre-provisioned only: no ECS service uses these groups until the reviewed
# pricing-command rollout attaches them in a separate change.
resource "aws_security_group" "next_api_pricing_caller" {
  name        = "vayada-next-api-pricing-caller-sg"
  description = "Isolated next API caller for the pricing command service"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "next_api_pricing_caller_from_alb" {
  type                     = "ingress"
  from_port                = 8003
  to_port                  = 8003
  protocol                 = "tcp"
  source_security_group_id = var.alb_sg_id
  security_group_id        = aws_security_group.next_api_pricing_caller.id
}

resource "aws_security_group_rule" "next_api_pricing_caller_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.next_api_pricing_caller.id
}

resource "aws_security_group_rule" "rds_from_next_api_pricing_caller" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.next_api_pricing_caller.id
  security_group_id        = var.rds_sg_id
}

resource "aws_security_group" "pricing_command" {
  name        = "vayada-pricing-command-sg"
  description = "Pricing command service: next API only, no public ingress"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "pricing_command_from_next_api" {
  type                     = "ingress"
  from_port                = 8010
  to_port                  = 8010
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.next_api_pricing_caller.id
  security_group_id        = aws_security_group.pricing_command.id
}

# Security groups cannot filter the WorkOS JWKS hostname. HTTPS egress to the
# internet is a documented residual risk of the selected public-IP pilot.
resource "aws_security_group_rule" "pricing_command_https_egress" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.pricing_command.id
}

resource "aws_security_group_rule" "pricing_command_rds_egress" {
  type                     = "egress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = var.rds_sg_id
  security_group_id        = aws_security_group.pricing_command.id
}

resource "aws_security_group_rule" "rds_from_pricing_command" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.pricing_command.id
  security_group_id        = var.rds_sg_id
}
