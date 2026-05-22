# Wildcard cert for *.vayada.com
# Covers: booking-api.vayada.com, pms-api.vayada.com, pms.vayada.com, admin.booking.vayada.com
resource "aws_acm_certificate" "wildcard_vayada" {
  domain_name       = "*.vayada.com"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "wildcard-vayada-com"
  }
}

resource "aws_route53_record" "wildcard_vayada_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard_vayada.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "wildcard_vayada" {
  certificate_arn         = aws_acm_certificate.wildcard_vayada.arn
  validation_record_fqdns = [for record in aws_route53_record.wildcard_vayada_validation : record.fqdn]
}

# Wildcard cert for *.booking.vayada.com
# Covers: <hotel-slug>.booking.vayada.com multi-tenant subdomains
resource "aws_acm_certificate" "wildcard_booking" {
  domain_name       = "*.booking.vayada.com"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "wildcard-booking-vayada-com"
  }
}

resource "aws_route53_record" "wildcard_booking_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard_booking.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "wildcard_booking" {
  certificate_arn         = aws_acm_certificate.wildcard_booking.arn
  validation_record_fqdns = [for record in aws_route53_record.wildcard_booking_validation : record.fqdn]
}

# Attach both certs to the existing ALB HTTPS listener
resource "aws_lb_listener_certificate" "wildcard_vayada" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.wildcard_vayada.certificate_arn
}

resource "aws_lb_listener_certificate" "wildcard_booking" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.wildcard_booking.certificate_arn
}
