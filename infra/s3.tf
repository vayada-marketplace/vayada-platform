resource "aws_s3_bucket" "uploads" {
  bucket = "vayada-uploads-prod"

  tags = {
    Name = "vayada-uploads-prod"
  }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "uploads_public_read" {
  bucket = aws_s3_bucket.uploads.id

  depends_on = [aws_s3_bucket_public_access_block.uploads]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.uploads.arn}/*"
      }
    ]
  })
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = [
      "https://pms.vayada.com",
      "https://admin.booking.vayada.com",
      "https://*.booking.vayada.com",
    ]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_object" "bimi_logo" {
  bucket        = aws_s3_bucket.uploads.id
  key           = "branding/vayada-bimi.svg"
  source        = "${path.module}/bimi/vayada-bimi.svg"
  etag          = filemd5("${path.module}/bimi/vayada-bimi.svg")
  content_type  = "image/svg+xml"
  cache_control = "public, max-age=86400"

  depends_on = [aws_s3_bucket_policy.uploads_public_read]
}
