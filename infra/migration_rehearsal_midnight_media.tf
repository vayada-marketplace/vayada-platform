# Third isolated destination: deterministic media keys must never overwrite either retained run.
locals {
  migration_rehearsal_midnight_media_bucket = "vayada-rehearsal-0118fd1f-${var.aws_account_id}"
  migration_rehearsal_midnight_media_tags = {
    Project     = "vayada"
    Environment = "staging"
    Purpose     = "migration-rehearsal"
    Release     = "0118fd1f61b01e94dad63590a4452afb3cebac32"
    ManagedBy   = "terraform"
  }
  migration_rehearsal_midnight_media_objects = [
    "arn:aws:s3:::${local.migration_rehearsal_midnight_media_bucket}/public/media/*",
    "arn:aws:s3:::${local.migration_rehearsal_midnight_media_bucket}/private/media/*",
  ]
}

resource "aws_s3_bucket" "migration_rehearsal_midnight_media" {
  bucket = local.migration_rehearsal_midnight_media_bucket
  tags   = local.migration_rehearsal_midnight_media_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "migration_rehearsal_midnight_media" {
  bucket = aws_s3_bucket.migration_rehearsal_midnight_media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "migration_rehearsal_midnight_media" {
  bucket                  = aws_s3_bucket.migration_rehearsal_midnight_media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "migration_rehearsal_midnight_media" {
  bucket = aws_s3_bucket.migration_rehearsal_midnight_media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "migration_rehearsal_midnight_media" {
  bucket = aws_s3_bucket.migration_rehearsal_midnight_media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_origin_access_control" "migration_rehearsal_midnight_media" {
  name                              = "vayada-rehearsal-0118fd1f-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "migration_rehearsal_midnight_media" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"
  comment         = "VAY-1361 midnight-fix rehearsal media; prior runs retained"
  tags            = local.migration_rehearsal_midnight_media_tags

  origin {
    domain_name              = aws_s3_bucket.migration_rehearsal_midnight_media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.migration_rehearsal_midnight_media.id
    origin_id                = "migration-rehearsal-media"
    origin_path              = "/public"
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    compress               = true
    target_origin_id       = "migration-rehearsal-media"
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

data "aws_iam_policy_document" "migration_rehearsal_midnight_media_bucket" {
  statement {
    sid       = "ReadIsolatedPublicMediaThroughCloudFront"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.migration_rehearsal_midnight_media.arn}/public/media/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.migration_rehearsal_midnight_media.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.migration_rehearsal_midnight_media.arn, "${aws_s3_bucket.migration_rehearsal_midnight_media.arn}/*"]
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

resource "aws_s3_bucket_policy" "migration_rehearsal_midnight_media" {
  bucket = aws_s3_bucket.migration_rehearsal_midnight_media.id
  policy = data.aws_iam_policy_document.migration_rehearsal_midnight_media_bucket.json
}

resource "aws_iam_role" "migration_rehearsal_midnight_media" {
  name = "vayada-rehearsal-0118fd1f-media"
  tags = local.migration_rehearsal_midnight_media_tags
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

resource "aws_iam_role_policy" "migration_rehearsal_midnight_media" {
  name = "isolated-migration-media-access"
  role = aws_iam_role.migration_rehearsal_midnight_media.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ManageIsolatedMediaObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = local.migration_rehearsal_midnight_media_objects
      },
      {
        Sid      = "ReadExactOwnerReservation"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.migration_rehearsal_midnight_media.arn}/rehearsal-control/owner.json"
      },
      {
        Sid      = "ListExactRehearsalVersions"
        Effect   = "Allow"
        Action   = "s3:ListBucketVersions"
        Resource = aws_s3_bucket.migration_rehearsal_midnight_media.arn
      },
      {
        Sid    = "ReadReviewedLegacyMediaObjects"
        Effect = "Allow"
        Action = "s3:GetObject"
        Resource = [
          "${aws_s3_bucket.uploads.arn}/creators/*",
          "${aws_s3_bucket.uploads.arn}/listings/*",
          "arn:aws:s3:::vayada-creator-marketplace-images/*",
        ]
      },
      {
        Sid    = "DenyMediaMutationsOutsideRehearsal"
        Effect = "Deny"
        Action = [
          "s3:Put*", "s3:Delete*", "s3:Create*", "s3:Update*",
          "s3:RestoreObject", "s3:Replicate*", "s3:AbortMultipartUpload",
          "s3:BypassGovernanceRetention", "s3:ObjectOwnerOverrideToBucketOwner",
        ]
        NotResource = local.migration_rehearsal_midnight_media_objects
      },
    ]
  })
}

output "migration_rehearsal_midnight_media" {
  description = "Exact isolated media bindings for the post-midnight-fix rehearsal; not production services"
  value = {
    bucket_name                = aws_s3_bucket.migration_rehearsal_midnight_media.id
    cdn_base_url               = "https://${aws_cloudfront_distribution.migration_rehearsal_midnight_media.domain_name}"
    cloudfront_distribution_id = aws_cloudfront_distribution.migration_rehearsal_midnight_media.id
    task_role_arn              = aws_iam_role.migration_rehearsal_midnight_media.arn
  }
}

# Bootstrap this read/config-only policy with administrator credentials before merge.
# No task PassRole, IAM mutation, object read/write, or inline-policy expansion.
resource "aws_iam_policy" "github_actions_rehearsal_midnight_read" {
  name = "vayada-rehearsal-0118fd1f-deploy-read"
  tags = local.migration_rehearsal_midnight_media_tags
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies"]
        Resource = "arn:aws:iam::${var.aws_account_id}:role/vayada-rehearsal-0118fd1f-media"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]
        Resource = "arn:aws:iam::${var.aws_account_id}:policy/vayada-rehearsal-0118fd1f-deploy-read"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutBucketTagging", "s3:PutBucketOwnershipControls"]
        Resource = "arn:aws:s3:::${local.migration_rehearsal_midnight_media_bucket}"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "github_actions_rehearsal_midnight_read" {
  role       = aws_iam_role.github_actions_platform_deploy.name
  policy_arn = aws_iam_policy.github_actions_rehearsal_midnight_read.arn
}
