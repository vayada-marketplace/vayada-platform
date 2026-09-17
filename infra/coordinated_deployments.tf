# VAY-2028: the runtime records under this prefix are deliberately not
# Terraform resources. Terraform owns only this least-privilege access policy,
# so an apply cannot replace rollback holds, checkpoint acknowledgments, or
# successful-service provenance with configuration defaults.

locals {
  coordinated_deployment_service_names = toset([
    "vayada-next-api-service",
    "vayada-next-pms-frontend-service",
    "vayada-next-booking-frontend-service",
    "vayada-next-booking-admin-service",
    "vayada-next-marketplace-frontend-service",
    "vayada-next-marketplace-admin-service",
  ])

  coordinated_deployment_ecr_repositories = toset([
    "vayada-next-api",
    "vayada-next-pms-frontend",
    "vayada-next-booking-frontend",
    "vayada-next-booking-admin-frontend",
    "vayada-next-marketplace-frontend",
    "vayada-next-admin-frontend",
  ])
}

data "aws_iam_policy_document" "github_actions_coordinated_deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:vayada-marketplace/vayada-platform:environment:next"]
    }
  }
}

resource "aws_iam_role" "github_actions_coordinated_deploy" {
  name                 = "vayada-github-actions-coordinated-deploy"
  description          = "Reconcile signed six-service release manifests and scoped SSM deployment state"
  assume_role_policy   = data.aws_iam_policy_document.github_actions_coordinated_deploy_trust.json
  max_session_duration = 7200

  lifecycle {
    prevent_destroy = true
  }
}

data "aws_iam_policy_document" "github_actions_coordinated_deploy" {
  statement {
    sid    = "ReadEcsDeploymentState"
    effect = "Allow"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTaskSets",
      "ecs:DescribeClusters",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "RegisterTaskDefinitionRevisions"
    effect    = "Allow"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid     = "UpdateOnlyManagedPhysicalServices"
    effect  = "Allow"
    actions = ["ecs:UpdateService"]
    resources = [
      for service in local.coordinated_deployment_service_names :
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:service/vayada-backend-cluster/${service}"
    ]
  }

  statement {
    sid     = "ReadOnlyApprovedImages"
    effect  = "Allow"
    actions = ["ecr:BatchGetImage", "ecr:DescribeImages"]
    resources = [
      for repository in local.coordinated_deployment_ecr_repositories :
      "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${repository}"
    ]
  }

  statement {
    sid     = "PassExistingTaskRolesOnly"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/ecsTaskExecutionRole",
      "arn:aws:iam::${var.aws_account_id}:role/ecsTaskRole",
      "arn:aws:iam::${var.aws_account_id}:role/vayada-next-api-media-task-role",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid    = "ReadAndWriteDeploymentControlRecords"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:PutParameter",
    ]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/vayada/prod/coordinated-deployments/v1/*",
    ]
  }
}

resource "aws_iam_role_policy" "github_actions_coordinated_deploy" {
  name   = "vayada-coordinated-deploy-policy"
  role   = aws_iam_role.github_actions_coordinated_deploy.id
  policy = data.aws_iam_policy_document.github_actions_coordinated_deploy.json

  lifecycle {
    prevent_destroy = true
  }
}
