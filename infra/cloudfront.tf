resource "aws_cloudfront_origin_access_control" "platform_media" {
  name                              = "vayada-platform-media"
  description                       = "CloudFront access to production platform media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "platform_media_path_guard" {
  name    = "vayada-platform-media-path-guard"
  runtime = "cloudfront-js-2.0"
  comment = "Expose public media and BIMI only; deny private and staging paths"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;

      if (request.uri.indexOf('/media/') === 0) {
        request.uri = '/public' + request.uri;
        return request;
      }

      if (request.uri === '/branding/vayada-bimi.svg') {
        return request;
      }

      return {
        statusCode: 403,
        statusDescription: 'Forbidden'
      };
    }
  EOT
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

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.platform_media_path_guard.arn
    }

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
