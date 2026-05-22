resource "aws_security_group" "ecs_tasks" {
  name        = "vayada-ecs-tasks-sg"
  description = "Security group for ECS Fargate tasks"
  vpc_id      = var.vpc_id

  tags = {
    Name = "vayada-ecs-tasks-sg"
  }
}

# Allow inbound from ALB on all service ports
resource "aws_security_group_rule" "ecs_from_alb" {
  for_each = toset(["3001", "3002", "3003", "3004", "3005", "8000", "8001", "8002"])

  type                     = "ingress"
  from_port                = tonumber(each.value)
  to_port                  = tonumber(each.value)
  protocol                 = "tcp"
  source_security_group_id = var.alb_sg_id
  security_group_id        = aws_security_group.ecs_tasks.id
  description              = "Allow ALB to reach port ${each.value}"
}

# Allow all outbound (for RDS, S3, ECR access)
resource "aws_security_group_rule" "ecs_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "Allow all outbound traffic"
}

# Allow ECS tasks to reach RDS on port 5432
resource "aws_security_group_rule" "rds_from_ecs" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ecs_tasks.id
  security_group_id        = var.rds_sg_id
  description              = "Allow ECS tasks to reach RDS"
}
