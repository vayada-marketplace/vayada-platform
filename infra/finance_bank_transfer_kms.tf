locals {
  finance_bank_transfer_kms_purpose             = "finance-bank-transfer-v1"
  finance_bank_transfer_kms_key_versions        = { v1 = {} }
  finance_bank_transfer_kms_current_key_version = "v1"
  finance_bank_transfer_kms_context_keys        = ["purpose", "propertyId", "destinationId", "revision"]
  finance_bank_transfer_kms_current_key_arn     = aws_kms_key.finance_bank_transfer[local.finance_bank_transfer_kms_current_key_version].arn
  finance_bank_transfer_kms_allowed_key_arns    = sort([for key in values(aws_kms_key.finance_bank_transfer) : key.arn])
  finance_bank_transfer_kms_context_condition = {
    StringEquals = {
      "kms:EncryptionAlgorithm"       = "SYMMETRIC_DEFAULT"
      "kms:EncryptionContext:purpose" = local.finance_bank_transfer_kms_purpose
    }
    StringLike = {
      "kms:EncryptionContext:propertyId"    = "????????-????-????-????-????????????"
      "kms:EncryptionContext:destinationId" = "????????-????-????-????-????????????"
      "kms:EncryptionContext:revision"      = "?*"
    }
    StringNotLike               = { "kms:EncryptionContext:revision" = ["0", "-*"] }
    "ForAllValues:StringEquals" = { "kms:EncryptionContextKeys" = local.finance_bank_transfer_kms_context_keys }
  }
}

resource "aws_kms_key" "finance_bank_transfer" {
  for_each = local.finance_bank_transfer_kms_key_versions

  description              = "Finance bank transfer v1; VAY-1041 bootstrap"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true
  rotation_period_in_days  = 365
  deletion_window_in_days  = 30

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
        Sid       = "DenyCryptographicUseOutsideNextApi"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncryptFrom", "kms:ReEncryptTo"]
        Resource  = "*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = aws_iam_role.next_api_media.arn } }
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

  tags = {
    Name        = "vayada-finance-bank-transfer-${each.key}"
    Project     = "vayada"
    Environment = "production"
    Purpose     = "finance-bank-transfer"
    Version     = each.key
    ManagedBy   = "terraform"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "finance_bank_transfer_current" {
  name          = "alias/vayada/prod/finance-bank-transfer-current"
  target_key_id = aws_kms_key.finance_bank_transfer[local.finance_bank_transfer_kms_current_key_version].key_id

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role_policy" "next_api_finance_bank_transfer_kms" {
  name = "finance-bank-transfer-kms-access"
  role = aws_iam_role.next_api_media.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EncryptCurrentFinanceBankTransferKey"
        Effect    = "Allow"
        Action    = ["kms:Encrypt"]
        Resource  = local.finance_bank_transfer_kms_current_key_arn
        Condition = local.finance_bank_transfer_kms_context_condition
      },
      {
        Sid       = "DecryptAllowedFinanceBankTransferKeys"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = local.finance_bank_transfer_kms_allowed_key_arns
        Condition = local.finance_bank_transfer_kms_context_condition
      },
      {
        Sid      = "DescribeAllowedFinanceBankTransferKeys"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey"]
        Resource = local.finance_bank_transfer_kms_allowed_key_arns
      },
    ]
  })
}

# Import the approved bootstrap resources; subsequent plans are idempotent.
import {
  to = aws_kms_key.finance_bank_transfer["v1"]
  id = "735fc88a-7043-47ba-96d2-4cc6fdfaa06d"
}

import {
  to = aws_kms_alias.finance_bank_transfer_current
  id = "alias/vayada/prod/finance-bank-transfer-current"
}
