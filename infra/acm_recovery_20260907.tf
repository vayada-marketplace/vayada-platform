# The public zone is authoritative in Cloudflare. The original wildcard
# certificates expired after ACM could only see their Route 53 validation
# records, so request replacements whose validation records live in the
# authoritative zone. Keep the expired resources attached during recovery;
# ALB selects the valid, later-expiring certificate once these are issued.
resource "aws_acm_certificate" "wildcard_vayada_recovery" {
  domain_name       = "*.vayada.com"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "wildcard-vayada-com-recovery"
  }
}

resource "cloudflare_record" "wildcard_vayada_recovery_validation" {
  for_each = var.enable_cloudflare_dns ? {
    for dvo in aws_acm_certificate.wildcard_vayada_recovery.domain_validation_options : dvo.domain_name => {
      name   = trimsuffix(trimsuffix(dvo.resource_record_name, "."), ".vayada.com")
      record = trimsuffix(dvo.resource_record_value, ".")
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = var.cloudflare_zone_id
  name            = each.value.name
  type            = each.value.type
  content         = each.value.record
  ttl             = 60
  proxied         = false
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "wildcard_vayada_recovery" {
  certificate_arn = aws_acm_certificate.wildcard_vayada_recovery.arn
  validation_record_fqdns = [
    for option in aws_acm_certificate.wildcard_vayada_recovery.domain_validation_options : option.resource_record_name
  ]

  depends_on = [cloudflare_record.wildcard_vayada_recovery_validation]
}

resource "aws_acm_certificate" "wildcard_booking_recovery" {
  domain_name       = "*.booking.vayada.com"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "wildcard-booking-vayada-com-recovery"
  }
}

resource "cloudflare_record" "wildcard_booking_recovery_validation" {
  for_each = var.enable_cloudflare_dns ? {
    for dvo in aws_acm_certificate.wildcard_booking_recovery.domain_validation_options : dvo.domain_name => {
      name   = trimsuffix(trimsuffix(dvo.resource_record_name, "."), ".vayada.com")
      record = trimsuffix(dvo.resource_record_value, ".")
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = var.cloudflare_zone_id
  name            = each.value.name
  type            = each.value.type
  content         = each.value.record
  ttl             = 60
  proxied         = false
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "wildcard_booking_recovery" {
  certificate_arn = aws_acm_certificate.wildcard_booking_recovery.arn
  validation_record_fqdns = [
    for option in aws_acm_certificate.wildcard_booking_recovery.domain_validation_options : option.resource_record_name
  ]

  depends_on = [cloudflare_record.wildcard_booking_recovery_validation]
}

resource "aws_lb_listener_certificate" "wildcard_vayada_recovery" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.wildcard_vayada_recovery.certificate_arn
}

resource "aws_lb_listener_certificate" "wildcard_booking_recovery" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.wildcard_booking_recovery.certificate_arn
}
