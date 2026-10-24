# VAY-2339: vayada-database gets its own security group. It used to share the
# default VPC group (var.rds_sg_id), which also opened port 8000 to the internet.
# The instance itself is not in Terraform: docs/vay2339-database-network.md
# attaches this group to it. The rules mirror the 5432 rules on the default group.
resource "aws_security_group" "database" {
  name        = "vayada-database-sg"
  description = "vayada-database: PostgreSQL from the ECS task groups only"
  vpc_id      = var.vpc_id

  tags = {
    Name = "vayada-database-sg"
  }
}

resource "aws_security_group_rule" "database_from_ecs_tasks" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ecs_tasks.id
  security_group_id        = aws_security_group.database.id
  description              = "Allow ECS tasks to reach RDS"
}

resource "aws_security_group_rule" "database_from_next_api_pricing_caller" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.next_api_pricing_caller.id
  security_group_id        = aws_security_group.database.id
  description              = "Allow the next API pricing caller to reach RDS"
}

resource "aws_security_group_rule" "database_from_pricing_command" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.pricing_command.id
  security_group_id        = aws_security_group.database.id
  description              = "Allow the pricing command service to reach RDS"
}

# Same outbound rule as the default group, so nothing the database starts can break.
resource "aws_security_group_rule" "database_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.database.id
  description       = "Allow all outbound traffic"
}
