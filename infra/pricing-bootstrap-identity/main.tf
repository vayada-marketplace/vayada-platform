# Separate operator-owned state; never imported by the ordinary platform root.
terraform {
  required_version = "~> 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.100.0"
    }
  }
  backend "s3" {
    bucket         = "vayada-terraform-state"
    key            = "vay1543/bootstrap-identity/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "vayada-terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region              = "eu-west-1"
  allowed_account_ids = ["269416271598"]
}

variable "creation_window" {
  description = "Separately reviewed UTC admission window; null provisions nothing. Maximum one hour."
  type        = object({ start = string, end = string })
  default     = null
  validation {
    condition = var.creation_window == null ? true : try(
      can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.creation_window.start)) &&
      can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.creation_window.end)) &&
      timecmp(var.creation_window.end, var.creation_window.start) > 0 &&
    timecmp(var.creation_window.end, timeadd(var.creation_window.start, "1h")) <= 0, false)
    error_message = "Use valid explicit UTC start/end timestamps spanning more than zero and at most one hour."
  }
}

variable "refresh_kms_key_arns" {
  description = "Reviewed existing KMS key metadata only; never decrypt. Inventory before activation."
  type        = list(string)
  default     = []
  validation {
    condition = length(var.refresh_kms_key_arns) <= 32 && alltrue([
      for arn in var.refresh_kms_key_arns : can(regex("^arn:aws:kms:(eu-west-1|us-east-1):269416271598:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", arn))
    ])
    error_message = "At most 32 exact account-owned key ARNs, without aliases or wildcards, are allowed."
  }
}

locals {
  window_start   = try(var.creation_window.start, "1970-01-01T00:00:00Z")
  window_end     = try(var.creation_window.end, "1970-01-01T00:00:01Z")
  execution_role = "arn:aws:iam::269416271598:role/vayada-pricing-command-execution"
  names = {
    identity_read  = "identity-read-database-url"
    owner_read     = "owner-read-database-url"
    owner_manage   = "owner-manage-database-url"
    public         = "public-database-url"
    internal_token = "internal-token"
  }
  secret_arns = [for name in values(local.names) : "arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/${name}-??????"]
  refresh = jsondecode(templatefile("${path.module}/../platform_plan_policy.json.tftpl", {
    account_id = "269416271598", region = "eu-west-1", kms_resources = jsonencode(var.refresh_kms_key_arns)
  })).Statement
  creation_statements = concat([
    {
      Sid      = "ExactProductionStateWrite", Effect = "Allow", Action = ["s3:PutObject"]
      Resource = "arn:aws:s3:::vayada-terraform-state/platform/terraform.tfstate"
    },
    {
      Sid      = "CreateDedicatedExecutionRole", Effect = "Allow", Action = ["iam:CreateRole", "iam:PutRolePolicy"]
      Resource = local.execution_role
    },
    {
      Sid      = "VerifyOnlyFixedSecretMetadata", Effect = "Allow"
      Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds"]
      Resource = local.secret_arns
    }
    ], flatten([for key, name in local.names : [for action in ["CreateSecret", "TagResource"] : {
      Sid      = "${action}${replace(key, "_", "")}Only", Effect = "Allow"
      Action   = ["secretsmanager:${action}"]
      Resource = "arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/${name}-??????"
      Condition = {
        StringEquals = merge(action == "CreateSecret" ? { "secretsmanager:Name" = "pricing-command/prod/${name}" } : {}, {
          "aws:RequestTag/Project" = "vayada", "aws:RequestTag/Environment" = "production"
          "aws:RequestTag/Purpose" = "pricing-command-${key}"
        })
        "ForAllValues:StringEquals" = { "aws:TagKeys" = ["Project", "Environment", "Purpose"] }
      }
  }]]))
  fences = [
    {
      Sid       = "BeforeWindow", Effect = "Deny", Action = "*", Resource = "*"
      Condition = { DateLessThan = { "aws:CurrentTime" = local.window_start } }
    },
    {
      Sid       = "ExpireIssuedSessions", Effect = "Deny", Action = "*", Resource = "*"
      Condition = { DateGreaterThanEquals = { "aws:CurrentTime" = local.window_end } }
    },
    {
      Sid       = "RejectEarlierSessions", Effect = "Deny", Action = "*", Resource = "*"
      Condition = { DateLessThan = { "aws:TokenIssueTime" = local.window_start } }
    },
    {
      Sid = "NeverReadOrPopulateValuesOrPassRoles", Effect = "Deny", Resource = "*"
      Action = ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue", "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret", "secretsmanager:PutResourcePolicy", "secretsmanager:DeleteResourcePolicy",
        "secretsmanager:DeleteSecret", "secretsmanager:RestoreSecret", "secretsmanager:RotateSecret",
        "secretsmanager:ReplicateSecretToRegions", "secretsmanager:RemoveRegionsFromReplication",
      "kms:Decrypt", "iam:PassRole", "sts:AssumeRole", "sts:AssumeRoleWithWebIdentity", "sts:AssumeRoleWithSAML"]
    }
  ]
  refresh_policy = jsonencode({ Version = "2012-10-17", Statement = [
    for statement in local.refresh : statement if statement.Sid != "ExactKeyMetadata" || length(var.refresh_kms_key_arns) > 0
  ] })
  policy = jsonencode({ Version = "2012-10-17", Statement = concat(local.creation_statements, local.fences) })
  trust = var.creation_window == null ? null : jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::269416271598:oidc-provider/token.actions.githubusercontent.com" }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:vayada-marketplace/vayada-platform:environment:pricing-bootstrap-create-v1"
        }
        DateGreaterThanEquals = { "aws:CurrentTime" = var.creation_window.start }
        DateLessThan          = { "aws:CurrentTime" = var.creation_window.end }
      }
    }]
  })
}

resource "aws_iam_role" "creation" {
  count                = var.creation_window == null ? 0 : 1
  name                 = "vayada-pricing-bootstrap-create"
  assume_role_policy   = local.trust
  max_session_duration = 3600
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy" "creation" {
  count  = var.creation_window == null ? 0 : 1
  name   = "pricing-bootstrap-create-only"
  role   = aws_iam_role.creation[0].id
  policy = local.policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.policy) <= 10240
      error_message = "Creation role exceeds the inline policy quota; do not broaden or silently truncate it."
    }
  }
}

# Reuse the plan inventory without exceeding the role's aggregate inline quota.
resource "aws_iam_policy" "refresh" {
  count  = var.creation_window == null ? 0 : 1
  name   = "vayada-pricing-bootstrap-create-refresh"
  policy = local.refresh_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.refresh_policy) <= 6144
      error_message = "Refresh inventory exceeds the managed policy quota; review a narrower inventory."
    }
  }
}

resource "aws_iam_role_policy_attachment" "refresh" {
  count      = var.creation_window == null ? 0 : 1
  role       = aws_iam_role.creation[0].id
  policy_arn = aws_iam_policy.refresh[0].arn
  depends_on = [aws_iam_role_policy.creation]
  lifecycle { prevent_destroy = true }
}
