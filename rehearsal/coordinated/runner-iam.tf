locals {
  runner_task_definitions = ["arn:aws:ecs:eu-west-1:269416271598:task-definition/${local.prefix}-probe:*"]
  runner_services         = [for service in aws_ecs_service.fixture : service.id]
  runner_tasks            = "arn:aws:ecs:eu-west-1:269416271598:task/${aws_ecs_cluster.fixture.name}/*"
}

resource "aws_iam_role" "runner" {
  name = "${local.prefix}-runner"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = "arn:aws:iam::269416271598:oidc-provider/token.actions.githubusercontent.com" }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:vayada-marketplace/vayada-platform:ref:refs/heads/main"
      } }
    }]
  })
}

resource "aws_iam_role_policy" "runner" {
  name = "fixture-only-recovery"
  role = aws_iam_role.runner.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:DescribeServices"], Resource = local.runner_services },
      { Effect = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"], Resource = local.runner_tasks },
      {
        Effect    = "Allow", Action = ["ecs:ListTasks"], Resource = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.fixture.arn } }
      },
      # Tag-on-create also requires explicit TagResource authorization.
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*" },
      {
        Effect    = "Allow", Action = ["ecs:RegisterTaskDefinition"], Resource = local.runner_task_definitions
        Condition = { StringEquals = { "aws:RequestTag/Environment" = "coordinated-recovery" } }
      },
      {
        Effect    = "Allow", Action = ["ecs:TagResource"], Resource = local.runner_task_definitions
        Condition = { StringEquals = { "ecs:CreateAction" = "RegisterTaskDefinition", "aws:RequestTag/Environment" = "coordinated-recovery" } }
      },
      {
        Effect    = "Allow", Action = ["ecs:RunTask"], Resource = local.runner_task_definitions
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.fixture.arn } }
      },
      {
        Effect    = "Allow", Action = ["iam:PassRole"], Resource = aws_iam_role.execution.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      # Explicit bounds remain effective if another policy is accidentally added.
      { Sid = "NoServiceMutation", Effect = "Deny", Action = ["ecs:UpdateService"], Resource = "*" },
      { Sid = "NoOtherTasks", Effect = "Deny", Action = ["ecs:StopTask"], NotResource = local.runner_tasks },
      { Sid = "NoOtherFamilies", Effect = "Deny", Action = ["ecs:RegisterTaskDefinition", "ecs:RunTask", "ecs:TagResource"], NotResource = local.runner_task_definitions },
      {
        Sid       = "NoOtherClusters", Effect = "Deny", Action = ["ecs:RunTask"], Resource = "*"
        Condition = { ArnNotEquals = { "ecs:cluster" = aws_ecs_cluster.fixture.arn } }
      },
      {
        Sid       = "RequireFixtureTag", Effect = "Deny", Action = ["ecs:RegisterTaskDefinition"], Resource = "*"
        Condition = { StringNotEquals = { "aws:RequestTag/Environment" = "coordinated-recovery" } }
      },
      { Sid = "NoStateMutation", Effect = "Deny", Action = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"], Resource = "*" },
      { Sid = "NoOtherRoles", Effect = "Deny", Action = ["iam:PassRole"], NotResource = aws_iam_role.execution.arn },
      { Sid = "NoStructuralEcsChanges", Effect = "Deny", Action = ["ecs:CreateService", "ecs:DeleteService", "ecs:CreateTaskSet", "ecs:UpdateTaskSet", "ecs:DeleteTaskSet", "ecs:UpdateServicePrimaryTaskSet", "ecs:StartTask", "ecs:ExecuteCommand", "ecs:DeleteCluster", "ecs:UpdateCluster", "ecs:UpdateClusterSettings", "ecs:DeregisterTaskDefinition", "ecs:DeleteTaskDefinitions"], Resource = "*" }
    ]
  })
}

output "runner_role_arn" {
  value = aws_iam_role.runner.arn
}
