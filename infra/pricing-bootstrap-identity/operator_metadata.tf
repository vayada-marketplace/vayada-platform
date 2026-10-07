# Inactive proposal for the distinct two-policy phase; never creation authority.
variable "operator_metadata_window" {
  description = "Separately reviewed metadata-phase window; null provisions nothing. Maximum one hour."
  type        = object({ start = string, end = string })
  default     = null
  validation {
    condition = var.operator_metadata_window == null ? true : try(
      can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.operator_metadata_window.start)) &&
      can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.operator_metadata_window.end)) &&
      timecmp(var.operator_metadata_window.end, var.operator_metadata_window.start) > 0 &&
    timecmp(var.operator_metadata_window.end, timeadd(var.operator_metadata_window.start, "1h")) <= 0, false)
    error_message = "Use valid explicit UTC start/end timestamps spanning more than zero and at most one hour."
  }
}

variable "metadata_secret_arns" {
  description = "Five observed final pricing secret ARNs keyed by the reviewed names; no wildcard or value lookup."
  type        = map(string)
  default     = {}
}

variable "enable_metadata_ssm_refresh_decryption" {
  description = "Separate fixed-36 plaintext refresh proposal for the metadata operator; default denies decryption."
  type        = bool
  default     = false
}

locals {
  metadata_window = var.operator_metadata_window == null ? {
    start = "1970-01-01T00:00:00Z", end = "1970-01-01T00:00:01Z"
  } : var.operator_metadata_window
  metadata_plan_role_arn = "arn:aws:iam::269416271598:role/vayada-github-actions-platform-plan"
  metadata_boundary_arn  = "arn:aws:iam::269416271598:policy/vayada-platform-writer-boundary"
  metadata_policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    {
      Sid    = "UpdateExistingPlanRolePolicy", Effect = "Allow"
      Action = ["iam:PutRolePolicy"], Resource = local.metadata_plan_role_arn
    },
    {
      Sid    = "CreateReviewedBoundaryVersion", Effect = "Allow"
      Action = ["iam:CreatePolicyVersion"], Resource = local.metadata_boundary_arn
    },
    {
      Sid    = "NeverWriteOtherRolePolicies", Effect = "Deny"
      Action = ["iam:PutRolePolicy"], NotResource = local.metadata_plan_role_arn
    },
    {
      Sid    = "NeverVersionOtherPolicies", Effect = "Deny"
      Action = ["iam:CreatePolicyVersion"], NotResource = local.metadata_boundary_arn
    },
    {
      Sid = "NeverChangeOtherIAMOrRetireVersions", Effect = "Deny", Resource = "*"
      Action = concat([for action in local.fences[0].Action : action if action != "iam:PutRolePolicy"],
        ["iam:CreatePolicy", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy", "iam:UntagPolicy", "iam:AttachUserPolicy", "iam:AttachGroupPolicy"])
    },
    {
      Sid    = "NeverCreatePricingContainers", Effect = "Deny", Resource = "*"
      Action = ["secretsmanager:CreateSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource"]
    },
    [for statement in local.creation_statements : statement if statement.Sid == "ExactProductionStateWrite"][0],
    [for statement in local.fences : statement if statement.Sid == "NeverReadOrPopulateValuesOrPassRoles"][0]
    ], jsondecode(templatefile("${path.module}/../../deployment/pricing-operator-session-fence.json.tftpl", {
      window_start = local.metadata_window.start, window_end = local.metadata_window.end
    })).Statement,
  jsondecode(var.enable_metadata_ssm_refresh_decryption ? "[]" : jsonencode(local.deny_all_decrypt_statements))) })
  metadata_refresh_policy = jsonencode({ Version = "2012-10-17", Statement = concat(
    [for statement in jsondecode(local.refresh_policy).Statement : statement if statement.Sid != "VerifyOnlyFixedSecretMetadata"],
    [{
      Sid      = "VerifyFinalPricingSecretMetadata", Effect = "Allow"
      Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds"]
      Resource = values(var.metadata_secret_arns)
  }]) })
}

resource "aws_iam_role" "operator_metadata" {
  count = var.operator_metadata_window == null ? 0 : 1
  name  = "vayada-pricing-operator-metadata"
  assume_role_policy = templatefile("${path.module}/../../deployment/pricing-operator-trust-no-mfa.json.tftpl", {
    window_start = local.metadata_window.start, window_end = local.metadata_window.end
  })
  max_session_duration = 3600
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = length(var.metadata_secret_arns) == 5 && alltrue([for key, name in local.names :
        can(regex("^arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/${name}-[A-Za-z0-9]{6}$", lookup(var.metadata_secret_arns, key, "")))
      ])
      error_message = "Metadata admission requires the five exact final secret ARNs under their reviewed keys."
    }
    precondition {
      condition = (var.creation_window == null ? true : timecmp(local.metadata_window.start, var.creation_window.end) >= 0) && (
      var.operator_creation_window == null ? true : timecmp(local.metadata_window.start, var.operator_creation_window.end) >= 0)
      error_message = "Metadata admission must start after both retained creation windows expire."
    }
  }
}

resource "aws_iam_role_policy" "operator_metadata" {
  count  = var.operator_metadata_window == null ? 0 : 1
  name   = "pricing-operator-metadata-only"
  role   = aws_iam_role.operator_metadata[0].id
  policy = local.metadata_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.metadata_policy) <= 10240
      error_message = "Metadata inline policy exceeds the quota; do not truncate its fences."
    }
  }
}

resource "aws_iam_policy" "metadata_refresh" {
  count  = var.operator_metadata_window == null ? 0 : 1
  name   = "vayada-pricing-operator-metadata-refresh"
  policy = local.metadata_refresh_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.metadata_refresh_policy) <= 6144
      error_message = "Metadata refresh inventory exceeds the managed policy quota."
    }
  }
}

resource "aws_iam_role_policy_attachment" "metadata_refresh" {
  count      = var.operator_metadata_window == null ? 0 : 1
  role       = aws_iam_role.operator_metadata[0].id
  policy_arn = aws_iam_policy.metadata_refresh[0].arn
  depends_on = [aws_iam_role_policy.operator_metadata]
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_policy" "metadata_ssm_refresh" {
  count  = var.operator_metadata_window != null && var.enable_metadata_ssm_refresh_decryption ? 1 : 0
  name   = "vayada-pricing-operator-metadata-ssm-refresh"
  policy = local.ssm_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.ssm_policy) <= 6144
      error_message = "Exact metadata SSM refresh inventory exceeds the managed policy quota."
    }
  }
}

resource "aws_iam_policy" "metadata_decrypt" {
  count  = var.operator_metadata_window != null && var.enable_metadata_ssm_refresh_decryption ? 1 : 0
  name   = "vayada-pricing-operator-metadata-ssm-decrypt"
  policy = local.operator_decrypt_policy
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = length(local.operator_decrypt_policy) <= 6144
      error_message = "Metadata decrypt fences exceed the managed policy quota; do not truncate them."
    }
  }
}

resource "aws_iam_role_policy_attachment" "metadata_decrypt" {
  count      = var.operator_metadata_window != null && var.enable_metadata_ssm_refresh_decryption ? 1 : 0
  role       = aws_iam_role.operator_metadata[0].id
  policy_arn = aws_iam_policy.metadata_decrypt[0].arn
  depends_on = [aws_iam_role_policy.operator_metadata]
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy_attachment" "metadata_ssm_refresh" {
  count      = var.operator_metadata_window != null && var.enable_metadata_ssm_refresh_decryption ? 1 : 0
  role       = aws_iam_role.operator_metadata[0].id
  policy_arn = aws_iam_policy.metadata_ssm_refresh[0].arn
  depends_on = [aws_iam_role_policy.operator_metadata, aws_iam_role_policy_attachment.metadata_decrypt]
  lifecycle { prevent_destroy = true }
}
