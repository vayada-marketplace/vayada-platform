# Staging requires a separate reviewed apply. Scheduling is independently off.
variable "enable_hotel_setup_online_runner" {
  type    = bool
  default = false
}

locals {
  hotel_setup_online_cluster_arn = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/vayada-backend-cluster"
  hotel_setup_online_tasks_arn   = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task/vayada-backend-cluster/*"
  hotel_setup_online_definitions = [for mode in ["organization", "property"] : "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/vayada-hotel-setup-online-${mode}:*"]
  hotel_setup_online_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com" }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:vayada-marketplace/vayada-platform:environment:hotel-setup-automatic-provisioning"
      } }
    }]
  })
  hotel_setup_online_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ecs:DescribeServices"]
        Resource = [for name in ["vayada-next-api-service", "vayada-hotel-setup-service", "vayada-hotel-setup-property-service"] :
        "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:service/vayada-backend-cluster/${name}"]
      },
      {
        # These metadata actions have no resource-level authorization support.
        Effect    = "Allow"
        Action    = ["ecs:DescribeTaskDefinition", "ecs:ListTasks", "elasticloadbalancing:DescribeTargetHealth"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks"]
        Resource  = local.hotel_setup_online_tasks_arn
        Condition = { ArnEquals = { "ecs:cluster" = local.hotel_setup_online_cluster_arn } }
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:RegisterTaskDefinition"]
        Resource = local.hotel_setup_online_definitions
        Condition = {
          StringEquals                = { "aws:RequestTag/vayada:hotel-setup-online" = "true" }
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["vayada:hotel-setup-online"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = local.hotel_setup_online_definitions
        Condition = {
          ArnEquals                   = { "ecs:cluster" = local.hotel_setup_online_cluster_arn }
          StringEquals                = { "aws:RequestTag/vayada:hotel-setup-online" = "true" }
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["vayada:hotel-setup-online"] }
        }
      },
      {
        # CreateAction is absent on standalone TagResource: serving tasks cannot
        # acquire this cleanup tag through this identity.
        Effect   = "Allow"
        Action   = ["ecs:TagResource"]
        Resource = concat(local.hotel_setup_online_definitions, [local.hotel_setup_online_tasks_arn])
        Condition = {
          StringEquals = {
            "ecs:CreateAction"                         = ["RegisterTaskDefinition", "RunTask"]
            "aws:RequestTag/vayada:hotel-setup-online" = "true"
          }
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["vayada:hotel-setup-online"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:StopTask"]
        Resource = local.hotel_setup_online_tasks_arn
        Condition = {
          ArnEquals    = { "ecs:cluster" = local.hotel_setup_online_cluster_arn }
          StringEquals = { "aws:ResourceTag/vayada:hotel-setup-online" = "true" }
        }
      },
      {
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [for name in ["vayada-hotel-setup-creation-bootstrap", "vayada-hotel-setup-property-bootstrap", "vayada-hotel-setup-property-bootstrap-execution"] :
        "arn:aws:iam::${var.aws_account_id}:role/${name}"]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      }
    ]
  })
}

resource "aws_iam_role" "hotel_setup_online" {
  count              = var.enable_hotel_setup_online_runner ? 1 : 0
  name               = "vayada-github-actions-hotel-setup-online"
  assume_role_policy = local.hotel_setup_online_trust
}

resource "aws_iam_role_policy" "hotel_setup_online" {
  count  = var.enable_hotel_setup_online_runner ? 1 : 0
  name   = "bounded-online-hotel-setup-only"
  role   = aws_iam_role.hotel_setup_online[0].id
  policy = local.hotel_setup_online_policy
}
