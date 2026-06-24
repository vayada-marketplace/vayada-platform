resource "cloudflare_record" "booking" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "booking"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "target_api" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "target-api"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_api" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "next-api"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_pms" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "next-pms"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_admin" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "next-admin"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_booking_admin" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "next-booking-admin"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_booking" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "next-booking"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_booking_wildcard" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "*.next-booking"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_marketplace" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "next-marketplace"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}

resource "cloudflare_record" "next_affiliate" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "next-affiliate"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}
