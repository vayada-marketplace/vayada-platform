locals {
  private_profile_media_bucket_name  = "vayada-media-production"
  private_profile_media_domain_name  = "images.vayada.com"
  private_profile_media_cdn_base_url = "https://${local.private_profile_media_domain_name}"
  private_profile_media_origin_id    = "vayada-platform-media-s3"

  private_profile_media_upload_origins = [
    "https://app.vayada.com",
    "https://admin.vayada.com",
    "https://admin.booking.vayada.com",
    "https://pms.vayada.com",
    "https://next-marketplace.vayada.com",
    "https://next-admin.vayada.com",
    "https://next-booking-admin.vayada.com",
    "https://next-pms.vayada.com",
  ]
}

resource "aws_s3_bucket" "private_profile_media" {
  bucket = local.private_profile_media_bucket_name

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = local.private_profile_media_bucket_name
    Project     = "vayada"
    Environment = "production"
  }
}

resource "aws_s3_bucket_ownership_controls" "private_profile_media" {
  bucket = aws_s3_bucket.private_profile_media.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "private_profile_media" {
  bucket = aws_s3_bucket.private_profile_media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private_profile_media" {
  bucket = aws_s3_bucket.private_profile_media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "private_profile_media" {
  bucket = aws_s3_bucket.private_profile_media.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_cors_configuration" "private_profile_media" {
  bucket = aws_s3_bucket.private_profile_media.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT"]
    allowed_origins = local.private_profile_media_upload_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "private_profile_media" {
  bucket = aws_s3_bucket.private_profile_media.id

  rule {
    id     = "expire-abandoned-staging-uploads"
    status = "Enabled"

    filter {
      prefix = "staging/"
    }

    expiration {
      days = 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.private_profile_media]
}

resource "aws_acm_certificate" "private_profile_media" {
  provider = aws.us_east_1

  domain_name       = local.private_profile_media_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "vayada-platform-media-cloudfront"
    Project     = "vayada"
    Environment = "production"
  }
}

resource "cloudflare_record" "private_profile_media_certificate_validation" {
  for_each = var.enable_cloudflare_dns ? {
    for option in aws_acm_certificate.private_profile_media.domain_validation_options : option.domain_name => {
      name    = trimsuffix(trimsuffix(option.resource_record_name, "."), ".vayada.com")
      content = trimsuffix(option.resource_record_value, ".")
      type    = option.resource_record_type
    }
  } : {}

  zone_id         = var.cloudflare_zone_id
  name            = each.value.name
  type            = each.value.type
  content         = each.value.content
  ttl             = 60
  proxied         = false
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "private_profile_media" {
  provider = aws.us_east_1

  certificate_arn = aws_acm_certificate.private_profile_media.arn
  validation_record_fqdns = [
    for option in aws_acm_certificate.private_profile_media.domain_validation_options : option.resource_record_name
  ]

  depends_on = [cloudflare_record.private_profile_media_certificate_validation]
}

resource "aws_cloudfront_origin_access_control" "private_profile_media" {
  name                              = "vayada-private-profile-media"
  description                       = "Private S3 access for public Vayada media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "private_profile_media" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = [local.private_profile_media_domain_name]
  comment         = "Vayada public platform media"

  origin {
    domain_name              = aws_s3_bucket.private_profile_media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.private_profile_media.id
    origin_id                = local.private_profile_media_origin_id
    origin_path              = "/public"
  }

  default_cache_behavior {
    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]
    # AWS-managed CachingOptimized policy.
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    compress               = true
    target_origin_id       = local.private_profile_media_origin_id
    viewer_protocol_policy = "redirect-to-https"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.private_profile_media.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  tags = {
    Name        = "vayada-private-profile-media"
    Project     = "vayada"
    Environment = "production"
  }
}

data "aws_iam_policy_document" "private_profile_media_bucket" {
  statement {
    sid    = "AllowCloudFrontPublicMediaRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.private_profile_media.arn}/public/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.private_profile_media.arn]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.private_profile_media.arn,
      "${aws_s3_bucket.private_profile_media.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "private_profile_media" {
  bucket = aws_s3_bucket.private_profile_media.id
  policy = data.aws_iam_policy_document.private_profile_media_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.private_profile_media]
}

resource "cloudflare_record" "private_profile_media" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "images"
  type    = "CNAME"
  content = aws_cloudfront_distribution.private_profile_media.domain_name
  proxied = false
}

resource "aws_iam_role" "next_api_media" {
  name = "vayada-next-api-media-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = var.aws_account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:*"
          }
        }
      }
    ]
  })

  tags = {
    Name        = "vayada-next-api-media-task-role"
    Project     = "vayada"
    Environment = "production"
  }
}

resource "aws_iam_role_policy" "next_api_media" {
  name = "platform-media-object-access"
  role = aws_iam_role.next_api_media.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ManagePlatformMediaObjects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = [
          "${aws_s3_bucket.private_profile_media.arn}/staging/*",
          "${aws_s3_bucket.private_profile_media.arn}/public/*",
          "${aws_s3_bucket.private_profile_media.arn}/private/*",
        ]
      }
    ]
  })
}
