locals {
  dns_records = {
    "wildcard-booking" = "*.booking.vayada.com"
    "admin-booking"    = "admin.booking.vayada.com"
"booking-api"      = "booking-api.vayada.com"
    "pms-api"          = "pms-api.vayada.com"
    "pms"              = "pms.vayada.com"
    "custom-booking"   = "custom.booking.vayada.com"
    "affiliate"        = "affiliate.vayada.com"
  }
}

resource "aws_route53_record" "services" {
  for_each = local.dns_records

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = data.aws_lb.main.dns_name
    zone_id                = data.aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# BIMI: lets supporting mail clients (Apple Mail, Yahoo, Fastmail, ...) render
# the Vayada V as the sender avatar for noreply@vayada.com. Gmail additionally
# requires a VMC/CMC certificate — see infra/bimi/README.md.
resource "aws_route53_record" "bimi" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "default._bimi.vayada.com"
  type    = "TXT"
  ttl     = 3600
  records = [
    "v=BIMI1; l=https://vayada-uploads-prod.s3.eu-west-1.amazonaws.com/branding/vayada-bimi.svg;",
  ]
}
