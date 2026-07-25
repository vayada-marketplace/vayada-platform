resource "aws_cloudfront_origin_access_control" "platform_media" {
  name                              = "vayada-platform-media"
  description                       = "CloudFront access to production platform media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "platform_media" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Vayada production platform media"
  price_class     = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.uploads.bucket_regional_domain_name
    origin_id                = "vayada-platform-media-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.platform_media.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    target_origin_id       = "vayada-platform-media-s3"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "vayada-platform-media"
  }
}
