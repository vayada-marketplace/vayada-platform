# VAY-2339: vayada-database has its own security group. It used to share the
# default VPC group, which also opened port 8000 to the internet. The instance
# itself is not in Terraform: docs/vay2339-database-network.md attached this group.
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

# The default VPC group keeps no rules: Terraform removes every rule when it
# adopts the group (the old 8000 rules from 0.0.0.0/0 and the ALB, and the self
# rules). Anything launched without a group gets no access. The precondition
# stops the plan while an RDS interface is still in the group (runbook R2).
data "aws_security_group" "default" {
  vpc_id = var.vpc_id
  name   = "default"
}

data "aws_network_interfaces" "default_security_group_rds" {
  filter {
    name   = "group-id"
    values = [data.aws_security_group.default.id]
  }

  filter {
    name   = "requester-id"
    values = ["amazon-rds"]
  }
}

resource "aws_default_security_group" "default" {
  vpc_id = var.vpc_id

  lifecycle {
    precondition {
      condition     = length(data.aws_network_interfaces.default_security_group_rds.ids) == 0
      error_message = "A database still uses the default VPC security group; finish docs/vay2339-database-network.md R2 first."
    }
  }
}
