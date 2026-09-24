# Separate from the API service: the bounded runner has no direct S3 access.
# The reviewed app assumes the writer with an exact-key, deadline-bound session
# policy. Never put the resulting short-lived credentials into task definitions.
resource "aws_iam_role" "finance_export_once" {
  name = "vayada-finance-export-once"
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

resource "aws_iam_role" "finance_export_once_writer" {
  name = "vayada-finance-export-once-writer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.finance_export_once.arn }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "finance_export_once_assume_writer" {
  name = "assume-export-writer"
  role = aws_iam_role.finance_export_once.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = aws_iam_role.finance_export_once_writer.arn
    }]
  })
}

resource "aws_iam_role_policy" "finance_export_once_write" {
  name = "write-private-financials-export"
  role = aws_iam_role.finance_export_once_writer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "s3:PutObject"
      Resource = "${aws_s3_bucket.private_profile_media.arn}/private/finance/financials-exports/*"
    }]
  })
}
