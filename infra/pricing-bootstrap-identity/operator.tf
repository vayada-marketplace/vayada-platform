# Selected one-time operator; separate from the hosted identity above.
variable "operator_creation_window" {
  description = "Review-only selected-owner pilot window; null provisions nothing. Maximum one hour."
  type        = object({ start = string, end = string })
  default     = null
  validation {
    condition = var.operator_creation_window == null ? true : try(
      can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.operator_creation_window.start)) &&
      can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.operator_creation_window.end)) &&
      timecmp(var.operator_creation_window.end, var.operator_creation_window.start) > 0 &&
    timecmp(var.operator_creation_window.end, timeadd(var.operator_creation_window.start, "1h")) <= 0, false)
    error_message = "Use valid explicit UTC start/end timestamps spanning more than zero and at most one hour."
  }
}

locals {
  operator_window = var.operator_creation_window == null ? {
    start = "1970-01-01T00:00:00Z", end = "1970-01-01T00:00:01Z"
  } : var.operator_creation_window
  execution_role_arn = "arn:aws:iam::269416271598:role/vayada-pricing-command-execution"
  operator_trust = templatefile("${path.module}/../../deployment/pricing-operator-trust-no-mfa.json.tftpl", {
    window_start = local.operator_window.start, window_end = local.operator_window.end
  })
  operator_fences = jsondecode(templatefile("${path.module}/../../deployment/pricing-operator-session-fence.json.tftpl", {
    window_start = local.operator_window.start, window_end = local.operator_window.end
  })).Statement
  operator_policy = jsonencode({ Version = "2012-10-17", Statement = concat(
    [for statement in local.creation_statements : statement if statement.Sid != "VerifyOnlyFixedSecretMetadata"],
    [
      {
        Sid    = "CreateDedicatedExecutionRole", Effect = "Allow"
        Action = ["iam:CreateRole", "iam:PutRolePolicy"], Resource = local.execution_role_arn
      },
      {
        Sid    = "NeverCreateOrWriteOtherRoles", Effect = "Deny"
        Action = ["iam:CreateRole", "iam:PutRolePolicy"], NotResource = local.execution_role_arn
      },
      {
        Sid    = "NeverChangeRoleTrustOrAttachments", Effect = "Deny", Resource = "*"
        Action = [for action in local.fences[0].Action : action if !contains(["iam:CreateRole", "iam:PutRolePolicy"], action)]
      },
      {
        Sid = "DenyAllDecrypt", Effect = "Deny", Action = ["kms:Decrypt"], Resource = "*"
      }
    ],
    [for statement in local.fences : statement if statement.Sid == "NeverReadOrPopulateValuesOrPassRoles"],
  local.operator_fences) })
}

resource "aws_iam_role" "operator_creation" {
  count                = var.operator_creation_window == null ? 0 : 1
  name                 = "vayada-pricing-operator-create"
  assume_role_policy   = local.operator_trust
  max_session_duration = 3600
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.creation_window == null && !var.enable_ssm_refresh_decryption
      error_message = "Operator creation cannot overlap hosted creation or inherit the unaccepted SSM plaintext exception."
    }
  }
}

resource "aws_iam_role_policy" "operator_creation" {
  count  = var.operator_creation_window == null ? 0 : 1
  name   = "pricing-operator-create-only"
  role   = aws_iam_role.operator_creation[0].id
  policy = local.operator_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.operator_policy) <= 10240
      error_message = "Operator creation/fence policy exceeds the inline quota; do not truncate it."
    }
  }
}

resource "aws_iam_policy" "operator_refresh" {
  count  = var.operator_creation_window == null ? 0 : 1
  name   = "vayada-pricing-operator-create-refresh"
  policy = local.refresh_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.refresh_policy) <= 6144
      error_message = "Operator refresh inventory exceeds the managed policy quota."
    }
  }
}

resource "aws_iam_role_policy_attachment" "operator_refresh" {
  count      = var.operator_creation_window == null ? 0 : 1
  role       = aws_iam_role.operator_creation[0].id
  policy_arn = aws_iam_policy.operator_refresh[0].arn
  depends_on = [aws_iam_role_policy.operator_creation]
  lifecycle { prevent_destroy = true }
}
