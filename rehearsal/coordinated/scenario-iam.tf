locals {
  scenario_families     = [for service in sort(tolist(local.services)) : "arn:aws:ecs:eu-west-1:269416271598:task-definition/${local.prefix}-${service}:*"]
  scenario_definitions  = concat(local.scenario_families, local.runner_task_definitions)
  scenario_state        = "arn:aws:ssm:eu-west-1:269416271598:parameter/vayada/rehearsal/coordinated-deployments/v1/*"
  scenario_repositories = [for repository in aws_ecr_repository.fixture : repository.arn]
  scenario_ecr_actions  = ["ecr:DescribeImages", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"]
  scenario_actions = concat(local.scenario_ecr_actions, [
    "sts:GetCallerIdentity", "ecr:GetAuthorizationToken", "ssm:GetParameter", "ssm:PutParameter", "iam:PassRole",
    "ecs:DescribeServices", "ecs:DescribeTasks", "ecs:DescribeTaskDefinition", "ecs:ListTasks", "ecs:ListServices",
    "ecs:RegisterTaskDefinition", "ecs:TagResource", "ecs:RunTask", "ecs:StopTask", "ecs:UpdateService"
  ])
}

resource "aws_iam_role" "scenario" {
  for_each = toset(["scenarios", "state-denial"])
  name     = "${local.prefix}-${each.key}"
  # Reuse the reviewed audience and platform/main-only OIDC trust exactly.
  assume_role_policy = aws_iam_role.runner.assume_role_policy
}

resource "aws_iam_role_policy" "scenario" {
  for_each = aws_iam_role.scenario
  name     = "fixture-only-scenarios"
  role     = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["ecs:DescribeTasks"], Resource = local.runner_tasks },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*" },
      {
        Effect    = "Allow", Action = ["ecs:ListTasks", "ecs:ListServices"], Resource = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.fixture.arn } }
      },
      {
        Effect    = "Allow", Action = ["ecs:RegisterTaskDefinition"], Resource = local.scenario_definitions
        Condition = { StringEquals = { "aws:RequestTag/Environment" = "coordinated-recovery" } }
      },
      {
        Effect    = "Allow", Action = ["ecs:TagResource"], Resource = local.scenario_definitions
        Condition = { StringEquals = { "ecs:CreateAction" = "RegisterTaskDefinition", "aws:RequestTag/Environment" = "coordinated-recovery" } }
      },
      {
        Effect    = "Allow", Action = ["ecs:RunTask"], Resource = local.runner_task_definitions
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.fixture.arn }, StringEquals = { "aws:RequestTag/Purpose" = "recovery-probe" } }
      },
      {
        Effect    = "Allow", Action = ["ecs:TagResource"], Resource = local.runner_tasks
        Condition = { StringEquals = { "ecs:CreateAction" = "RunTask", "aws:RequestTag/Purpose" = "recovery-probe" } }
      },
      {
        Effect    = "Allow", Action = ["ecs:StopTask"], Resource = local.runner_tasks
        Condition = { StringEquals = { "aws:ResourceTag/Purpose" = "recovery-probe" } }
      },
      {
        Effect    = "Allow", Action = ["ecs:DescribeServices", "ecs:UpdateService"], Resource = local.runner_services
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.fixture.arn }, ArnLikeIfExists = { "ecs:task-definition" = local.scenario_families } }
      },
      { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:PutParameter"], Resource = local.scenario_state },
      { Effect = "Allow", Action = each.key == "scenarios" ? local.scenario_ecr_actions : ["ecr:DescribeImages"], Resource = local.scenario_repositories },
      {
        Effect    = "Allow", Action = ["iam:PassRole"], Resource = aws_iam_role.execution.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      # Deny every unneeded action, including all deletes, IAM writes, ECS structural
      # changes and state destruction, even if another policy is attached later.
      { Effect = "Deny", NotAction = local.scenario_actions, Resource = "*" },
      { Effect = "Deny", Action = ["ssm:GetParameter", "ssm:PutParameter"], NotResource = local.scenario_state },
      { Effect = "Deny", Action = ["ecs:UpdateService"], NotResource = local.runner_services },
      { Effect = "Deny", Action = ["ecs:StopTask"], NotResource = local.runner_tasks },
      { Effect = "Deny", Action = ["ecs:RegisterTaskDefinition"], NotResource = local.scenario_definitions },
      { Effect = "Deny", Action = ["ecs:RunTask"], NotResource = local.runner_task_definitions },
      { Effect = "Deny", Action = ["ecs:TagResource"], NotResource = concat(local.scenario_definitions, [local.runner_tasks]) },
      {
        Effect    = "Deny", Action = ["ecs:TagResource"], Resource = "*"
        Condition = { StringNotEquals = { "ecs:CreateAction" = ["RegisterTaskDefinition", "RunTask"] } }
      },
      { Effect = "Deny", Action = local.scenario_ecr_actions, NotResource = local.scenario_repositories },
      { Effect = "Deny", Action = ["iam:PassRole"], NotResource = aws_iam_role.execution.arn },
      {
        Effect    = "Deny", Action = ["iam:PassRole"], Resource = "*"
        Condition = { StringNotEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect    = "Deny", Action = ["ecs:RunTask", "ecs:UpdateService"], Resource = "*"
        Condition = { ArnNotEquals = { "ecs:cluster" = aws_ecs_cluster.fixture.arn } }
      },
      {
        Effect    = "Deny", Action = ["ecs:UpdateService"], Resource = "*"
        Condition = { ArnNotLike = { "ecs:task-definition" = local.scenario_families } }
      },
      {
        Effect    = "Deny", Action = ["ecs:RegisterTaskDefinition"], Resource = "*"
        Condition = { StringNotEquals = { "aws:RequestTag/Environment" = "coordinated-recovery" } }
      },
      {
        Effect    = "Deny", Action = ["ecs:StopTask"], Resource = "*"
        Condition = { StringNotEquals = { "aws:ResourceTag/Purpose" = "recovery-probe" } }
      }
      ], [for statement in [
        { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" }
        ] : statement if each.key == "scenarios"], [for statement in [
        { Sid = "FailProvenanceWrite", Effect = "Deny", Action = ["ssm:PutParameter"], Resource = "arn:aws:ssm:eu-west-1:269416271598:parameter/vayada/rehearsal/coordinated-deployments/v1/runs/*/services/booking-admin/provenance" }
    ] : statement if each.key == "state-denial"])
  })
}

output "scenario_role_arns" {
  value = { for name, role in aws_iam_role.scenario : name => role.arn }
}
