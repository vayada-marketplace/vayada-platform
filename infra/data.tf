data "aws_ecs_cluster" "main" {
  cluster_name = var.ecs_cluster_name
}

data "aws_lb" "main" {
  name = "vayada-backend-alb"
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.main.arn
  port              = 443
}

data "aws_route53_zone" "main" {
  zone_id = var.route53_zone_id
}

data "aws_iam_role" "ecs_task_execution" {
  name = "ecsTaskExecutionRole"
}

data "aws_iam_role" "ecs_task" {
  name = "ecsTaskRole"
}
