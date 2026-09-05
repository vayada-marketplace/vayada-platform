locals {
  migration_rehearsal_application_role_arn = "arn:aws:iam::${var.aws_account_id}:role/vayada-migration-rehearsal-application-task-role"
  migration_rehearsal_key_read_policy_arn  = "arn:aws:iam::${var.aws_account_id}:policy/vayada-migration-rehearsal-application-key-read"
  migration_rehearsal_application_keys = {
    recipient   = { usage = "ENCRYPT_DECRYPT", spec = "SYMMETRIC_DEFAULT" }
    fingerprint = { usage = "GENERATE_VERIFY_MAC", spec = "HMAC_256" }
  }
}

resource "aws_iam_role" "migration_rehearsal_application" {
  name = "vayada-migration-rehearsal-application-task-role"
  tags = local.migration_rehearsal_media_tags
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:*" }
      }
    }]
  })
}

resource "aws_kms_key" "migration_rehearsal_application" {
  for_each = local.migration_rehearsal_application_keys

  description              = "Isolated migration rehearsal Finance ${each.key}; retain until evidence accepted"
  key_usage                = each.value.usage
  customer_master_key_spec = each.value.spec
  enable_key_rotation      = each.key == "recipient"
  deletion_window_in_days  = 30
  tags                     = merge(local.migration_rehearsal_media_tags, { Name = "vayada-migration-rehearsal-${each.key}" })

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableAccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "DenyCryptographicUseOutsideRehearsalApplication"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*", "kms:GenerateMac", "kms:VerifyMac"]
        Resource  = "*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = aws_iam_role.migration_rehearsal_application.arn } }
      },
      {
        Sid       = "DenyGrantCreation"
        Effect    = "Deny"
        Principal = "*"
        Action    = "kms:CreateGrant"
        Resource  = "*"
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role_policy" "migration_rehearsal_application" {
  name = "isolated-application-media-read-and-finance-test"
  role = aws_iam_role.migration_rehearsal_application.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadMigratedMedia"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = local.migration_rehearsal_media_objects
      },
      {
        Sid       = "DenyOtherAwsServices"
        Effect    = "Deny"
        NotAction = ["s3:GetObject", "kms:Encrypt", "kms:Decrypt", "kms:GenerateMac", "kms:DescribeKey"]
        Resource  = "*"
      },
      {
        Sid         = "DenyOtherMedia"
        Effect      = "Deny"
        Action      = "s3:GetObject"
        NotResource = local.migration_rehearsal_media_objects
      },
      {
        Sid         = "DenyOtherKeys"
        Effect      = "Deny"
        Action      = "kms:*"
        NotResource = [for key in aws_kms_key.migration_rehearsal_application : key.arn]
      },
      {
        Sid       = "SyntheticFinanceRecipientEncryption"
        Effect    = "Allow"
        Action    = ["kms:Encrypt", "kms:Decrypt"]
        Resource  = aws_kms_key.migration_rehearsal_application["recipient"].arn
        Condition = local.finance_folio_recipient_kms_context_condition
      },
      {
        Sid       = "SyntheticFinanceFingerprint"
        Effect    = "Allow"
        Action    = "kms:GenerateMac"
        Resource  = aws_kms_key.migration_rehearsal_application["fingerprint"].arn
        Condition = { StringEquals = { "kms:MacAlgorithm" = "HMAC_SHA_256" } }
      },
      {
        Sid      = "DescribeTestKeys"
        Effect   = "Allow"
        Action   = "kms:DescribeKey"
        Resource = [for key in aws_kms_key.migration_rehearsal_application : key.arn]
      },
    ]
  })
}

# CI can refresh the administrator-created resources, not create/change/use keys.
# A managed policy avoids the deploy role's almost-full inline-policy quota.
resource "aws_iam_policy" "github_actions_rehearsal_kms_read" {
  name = "vayada-migration-rehearsal-application-key-read"
  tags = local.migration_rehearsal_media_tags
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"]
        Resource = [for key in aws_kms_key.migration_rehearsal_application : key.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]
        Resource = local.migration_rehearsal_key_read_policy_arn
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "github_actions_rehearsal_kms_read" {
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.github_actions_rehearsal_kms_read.arn
}

output "migration_rehearsal_application" {
  description = "Isolated read-only-media application role and synthetic Finance keys; no app is launched"
  value = {
    task_role_arn       = aws_iam_role.migration_rehearsal_application.arn
    recipient_key_arn   = aws_kms_key.migration_rehearsal_application["recipient"].arn
    fingerprint_key_arn = aws_kms_key.migration_rehearsal_application["fingerprint"].arn
  }
}
