# VAY-2029 staged admission. The checked-in auto.tfvars file is the durable
# stage selector; no operator-only environment variable is needed by later CI.
variable "platform_writer_boundary" {
  type = object({
    bootstrap_plan_role = bool
    enforce_trust       = bool
    revoke_before       = optional(string)
  })
  default = { bootstrap_plan_role = false, enforce_trust = false }

  validation {
    condition     = !var.platform_writer_boundary.enforce_trust || var.platform_writer_boundary.bootstrap_plan_role
    error_message = "Bootstrap and verify the plan role before enforcing mutation-role trust."
  }
  validation {
    condition     = var.platform_writer_boundary.revoke_before == null ? true : (var.platform_writer_boundary.enforce_trust && can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.platform_writer_boundary.revoke_before)))
    error_message = "Session revocation requires enforced trust and an explicit UTC cutoff (YYYY-MM-DDTHH:MM:SSZ)."
  }
}

locals {
  platform_mutation_subject    = "repo:vayada-marketplace/vayada-platform:environment:platform-mutations-v2"
  platform_plan_role_arn       = "arn:aws:iam::${var.aws_account_id}:role/vayada-github-actions-platform-plan"
  platform_boundary_policy_arn = "arn:aws:iam::${var.aws_account_id}:policy/vayada-platform-writer-boundary"
  platform_plan_policy_document = jsondecode(templatefile("${path.module}/platform_plan_policy.json.tftpl", {
    account_id = var.aws_account_id
    region     = var.aws_region
    kms_resources = jsonencode(concat(
      [for key in aws_kms_key.finance_folio_recipient : key.arn],
      [for key in aws_kms_key.finance_folio_recipient_fingerprint : key.arn],
      [for key in aws_kms_key.finance_bank_transfer : key.arn],
      [for key in aws_kms_key.migration_rehearsal_application : key.arn],
      [for key in aws_kms_key.migration_rehearsal_inbox_application : key.arn],
    ))
  }))
  platform_plan_policy = jsonencode(merge(local.platform_plan_policy_document, {
    Statement = [for statement in local.platform_plan_policy_document.Statement : statement
      if statement.Sid != "ExactKeyMetadata" || length(statement.Resource) > 0
    ]
  }))
}

resource "aws_iam_role" "platform_plan" {
  count       = var.platform_writer_boundary.bootstrap_plan_role ? 1 : 0
  name        = "vayada-github-actions-platform-plan"
  description = "Terraform PR resource refresh and exact backend lock; no resource mutation"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com" }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:vayada-marketplace/vayada-platform:pull_request"
      } }
    }]
  })
  max_session_duration = 3600
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy" "platform_plan" {
  count  = var.platform_writer_boundary.bootstrap_plan_role ? 1 : 0
  name   = "vayada-platform-plan"
  role   = aws_iam_role.platform_plan[0].name
  policy = local.platform_plan_policy
  lifecycle { prevent_destroy = true }
}

# One managed attachment covers bootstrap refresh and later session revocation.
# It does not consume the mutation role's aggregate inline-policy quota.
resource "aws_iam_policy" "platform_writer_boundary" {
  count = var.platform_writer_boundary.bootstrap_plan_role ? 1 : 0
  name  = "vayada-platform-writer-boundary"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "RefreshPlanRoleOnly"
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRoleTags"]
        Resource = local.platform_plan_role_arn
      },
      {
        Sid      = "RefreshBoundaryPolicyOnly"
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]
        Resource = local.platform_boundary_policy_arn
      }
      ], var.platform_writer_boundary.revoke_before == null ? [] : [{
        Sid       = "RevokeSessionsBeforeReviewedCutover"
        Effect    = "Deny"
        Action    = "*"
        Resource  = "*"
        Condition = { DateLessThan = { "aws:TokenIssueTime" = var.platform_writer_boundary.revoke_before } }
    }])
  })
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy_attachment" "platform_writer_boundary" {
  count      = var.platform_writer_boundary.bootstrap_plan_role ? 1 : 0
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.platform_writer_boundary[0].arn
  lifecycle { prevent_destroy = true }
}
