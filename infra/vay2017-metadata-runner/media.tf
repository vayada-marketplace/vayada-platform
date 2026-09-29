# Fresh destination only; no release, run, reservation, or task is bound here.
locals {
  vay2042_media_bucket = "vayada-rehearsal-vay2042-20260926-${local.vay2017_rehearsal_account_id}"
  vay2042_media_tags = {
    Project     = "vayada"
    Environment = "staging"
    Purpose     = "migration-rehearsal"
    Ticket      = "VAY-2042"
    ManagedBy   = "terraform"
  }
  vay2042_media_objects = [
    "arn:aws:s3:::${local.vay2042_media_bucket}/public/media/*",
    "arn:aws:s3:::${local.vay2042_media_bucket}/private/media/*",
  ]
}

resource "aws_s3_bucket" "vay2042_media" {
  bucket        = local.vay2042_media_bucket
  force_destroy = false
  tags          = local.vay2042_media_tags
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "vay2042_media" {
  bucket = aws_s3_bucket.vay2042_media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "vay2042_media" {
  bucket                  = aws_s3_bucket.vay2042_media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "vay2042_media" {
  bucket = aws_s3_bucket.vay2042_media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "vay2042_media" {
  bucket = aws_s3_bucket.vay2042_media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_origin_access_control" "vay2042_media" {
  name                              = "vayada-rehearsal-vay2042-20260926-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "vay2042_media" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"
  comment         = "VAY-2042 fresh rehearsal media; prior runs retained"
  tags            = local.vay2042_media_tags
  origin {
    domain_name              = aws_s3_bucket.vay2042_media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.vay2042_media.id
    origin_id                = "vay2042-rehearsal-media"
    origin_path              = "/public"
  }
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    compress               = true
    target_origin_id       = "vay2042-rehearsal-media"
    viewer_protocol_policy = "redirect-to-https"
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "vay2042_media_bucket" {
  statement {
    sid       = "ReadIsolatedPublicMediaThroughCloudFront"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.vay2042_media.arn}/public/media/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.vay2042_media.arn]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.vay2042_media.arn, "${aws_s3_bucket.vay2042_media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "vay2042_media" {
  bucket = aws_s3_bucket.vay2042_media.id
  policy = data.aws_iam_policy_document.vay2042_media_bucket.json
}

resource "aws_iam_role" "vay2042_media" {
  name = "vayada-rehearsal-vay2042-20260926-media"
  tags = local.vay2042_media_tags
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.vay2017_rehearsal_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${local.vay2017_rehearsal_region}:${local.vay2017_rehearsal_account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "vay2042_media" {
  name = "isolated-migration-media-access"
  role = aws_iam_role.vay2042_media.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ManageIsolatedMediaObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = local.vay2042_media_objects
      },
      {
        Sid    = "ReadReviewedLegacyMediaObjects"
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          "arn:aws:s3:::vayada-uploads-prod/creators/*",
          "arn:aws:s3:::vayada-uploads-prod/listings/*",
          "arn:aws:s3:::vayada-creator-marketplace-images/*",
        ]
      },
      {
        Sid         = "DenyMutationsOutsideRehearsalMedia"
        Effect      = "Deny"
        NotAction   = ["s3:Get*", "s3:List*", "s3:Describe*"]
        NotResource = local.vay2042_media_objects
      },
    ]
  })
}

output "vay2042_media" {
  description = "Fresh isolated media bindings; no run or release has been reserved"
  value = {
    bucket_name                = aws_s3_bucket.vay2042_media.id
    cdn_base_url               = "https://${aws_cloudfront_distribution.vay2042_media.domain_name}"
    cloudfront_distribution_id = aws_cloudfront_distribution.vay2042_media.id
    task_role_arn              = aws_iam_role.vay2042_media.arn
  }
}
