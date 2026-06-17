# Permissions needed by platform Terraform when provisioning new ECS services.
resource "aws_iam_role_policy" "github_actions_ecs_service_management" {
  name = "platform-ecs-service-management"
  role = data.aws_iam_role.github_actions_platform_deploy.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:CreateService",
          "ecs:DeleteService",
        ]
        Resource = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:service/${var.ecs_cluster_name}/vayada-*"
      },
    ]
  })
}
