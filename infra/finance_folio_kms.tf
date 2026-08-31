locals {
  finance_folio_recipient_kms_purpose                     = "finance-folio-recipient-v1"
  finance_folio_recipient_kms_key_versions                = { v1 = {} }
  finance_folio_recipient_kms_current_key_version         = "v1"
  finance_folio_recipient_kms_context_keys                = ["purpose", "propertyId", "folioId", "revision"]
  finance_folio_recipient_kms_current_key_arn             = aws_kms_key.finance_folio_recipient[local.finance_folio_recipient_kms_current_key_version].arn
  finance_folio_recipient_kms_allowed_key_arns            = sort([for key in values(aws_kms_key.finance_folio_recipient) : key.arn])
  finance_folio_recipient_fingerprint_key_versions        = { v1 = {} }
  finance_folio_recipient_fingerprint_current_key_version = "v1"
  finance_folio_recipient_fingerprint_current_key_arn     = aws_kms_key.finance_folio_recipient_fingerprint[local.finance_folio_recipient_fingerprint_current_key_version].arn
  finance_folio_recipient_kms_context_condition = {
    StringEquals = {
      "kms:EncryptionAlgorithm"       = "SYMMETRIC_DEFAULT"
      "kms:EncryptionContext:purpose" = local.finance_folio_recipient_kms_purpose
    }
    StringLike = {
      "kms:EncryptionContext:propertyId" = "????????-????-????-????-????????????"
      "kms:EncryptionContext:folioId"    = "????????-????-????-????-????????????"
      "kms:EncryptionContext:revision"   = "?*"
    }
    StringNotLike               = { "kms:EncryptionContext:revision" = ["0", "-*"] }
    "ForAllValues:StringEquals" = { "kms:EncryptionContextKeys" = local.finance_folio_recipient_kms_context_keys }
  }
}

resource "aws_kms_key" "finance_folio_recipient" {
  for_each = local.finance_folio_recipient_kms_key_versions

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
    Name        = "vayada-finance-folio-recipient-${each.key}"
    Project     = "vayada"
    Environment = "production"
    Purpose     = "finance-folio-recipient"
    Version     = each.key
    ManagedBy   = "terraform"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "finance_folio_recipient_current" {
  name          = "alias/vayada/prod/finance-folio-recipient-current"
  target_key_id = aws_kms_key.finance_folio_recipient[local.finance_folio_recipient_kms_current_key_version].key_id

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "finance_folio_recipient_fingerprint" {
  for_each = local.finance_folio_recipient_fingerprint_key_versions

  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
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
        Sid       = "DenyMacUseOutsideNextApi"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["kms:GenerateMac", "kms:VerifyMac"]
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
    Name        = "vayada-finance-folio-recipient-fingerprint-${each.key}"
    Project     = "vayada"
    Environment = "production"
    Purpose     = "finance-folio-recipient-fingerprint"
    Version     = each.key
    ManagedBy   = "terraform"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role_policy" "next_api_finance_folio_recipient_kms" {
  name = "finance-folio-recipient-kms-access"
  role = aws_iam_role.next_api_media.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EncryptCurrentFinanceFolioRecipientKey"
        Effect    = "Allow"
        Action    = ["kms:Encrypt"]
        Resource  = local.finance_folio_recipient_kms_current_key_arn
        Condition = local.finance_folio_recipient_kms_context_condition
      },
      {
        Sid       = "DecryptAllowedFinanceFolioRecipientKeys"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = local.finance_folio_recipient_kms_allowed_key_arns
        Condition = local.finance_folio_recipient_kms_context_condition
      },
      {
        Sid      = "DescribeAllowedFinanceFolioRecipientKeys"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey"]
        Resource = local.finance_folio_recipient_kms_allowed_key_arns
      },
      {
        Sid       = "GenerateFinanceFolioRecipientFingerprint"
        Effect    = "Allow"
        Action    = ["kms:GenerateMac"]
        Resource  = local.finance_folio_recipient_fingerprint_current_key_arn
        Condition = { StringEquals = { "kms:MacAlgorithm" = "HMAC_SHA_256" } }
      },
      {
        Sid      = "DescribeFinanceFolioRecipientFingerprintKey"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey"]
        Resource = local.finance_folio_recipient_fingerprint_current_key_arn
      },
    ]
  })
}
