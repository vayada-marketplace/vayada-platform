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

variable "enable_operator_ssm_refresh_decryption" {
  description = "Explicit approved fixed-36 plaintext refresh for the selected-owner operator only; default denies all decryption."
  type        = bool
  default     = false
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
      }
    ],
    [for statement in local.fences : statement if statement.Sid == "NeverReadOrPopulateValuesOrPassRoles"],
    local.operator_fences,
  jsondecode(var.enable_operator_ssm_refresh_decryption ? "[]" : jsonencode(local.deny_all_decrypt_statements))) })
  operator_decrypt_policy = jsonencode({ Version = "2012-10-17", Statement = local.ssm_decrypt_statements })
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
      error_message = "Operator creation cannot overlap hosted creation or inherit the hosted SSM plaintext exception."
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

resource "aws_iam_policy" "operator_ssm_refresh" {
  count  = var.operator_creation_window != null && var.enable_operator_ssm_refresh_decryption ? 1 : 0
  name   = "vayada-pricing-operator-create-ssm-refresh"
  policy = local.ssm_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.ssm_policy) <= 6144
      error_message = "Exact operator SSM refresh inventory exceeds the managed policy quota."
    }
  }
}

resource "aws_iam_role_policy_attachment" "operator_ssm_refresh" {
  count      = var.operator_creation_window != null && var.enable_operator_ssm_refresh_decryption ? 1 : 0
  role       = aws_iam_role.operator_creation[0].id
  policy_arn = aws_iam_policy.operator_ssm_refresh[0].arn
  # Install key/service/context denies before granting parameter reads.
  depends_on = [aws_iam_role_policy.operator_creation, aws_iam_role_policy_attachment.operator_decrypt]
  lifecycle { prevent_destroy = true }
}

# Keep the fixed inventory and decrypt fences separate to satisfy IAM quotas.
resource "aws_iam_policy" "operator_decrypt" {
  count  = var.operator_creation_window != null && var.enable_operator_ssm_refresh_decryption ? 1 : 0
  name   = "vayada-pricing-operator-create-ssm-decrypt"
  policy = local.operator_decrypt_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.operator_decrypt_policy) <= 6144
      error_message = "Operator decrypt fences exceed the managed policy quota; do not truncate them."
    }
  }
}

resource "aws_iam_role_policy_attachment" "operator_decrypt" {
  count      = var.operator_creation_window != null && var.enable_operator_ssm_refresh_decryption ? 1 : 0
  role       = aws_iam_role.operator_creation[0].id
  policy_arn = aws_iam_policy.operator_decrypt[0].arn
  depends_on = [aws_iam_role_policy.operator_creation]
  lifecycle { prevent_destroy = true }
}
