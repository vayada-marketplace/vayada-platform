resource "aws_iam_role_policy" "github_actions_platform_ecs_task_definition" {
  name = "github-actions-ecs-task-definition-management"
  role = data.aws_iam_role.github_actions_platform_deploy.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:DeregisterTaskDefinition",
        ]
        Resource = "*"
      },
    ]
  })
}
