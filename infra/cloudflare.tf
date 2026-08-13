resource "cloudflare_record" "booking" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "booking"
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

resource "cloudflare_record" "resend_dkim" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "resend._domainkey"
  type    = "TXT"
  content = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDuEYFDTOSW7z3C7zZL01/rbx5UoZbiISOBZmC4ZrgWEtc0PepMYiPHdGU/DqhMFofH6SWHGljgcav/BTBObjHDRMhixd2YIcJ+0w9sjVnHGZPU8RUrBAvNqLGIQa5YM7IWuPRt6Ib3HvfSVhKqs/SzZaR+wVdCtcA+5U7xMuC8GQIDAQAB"
  proxied = false
}

resource "cloudflare_record" "resend_return_path" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id  = var.cloudflare_zone_id
  name     = "send"
  type     = "MX"
  content  = "feedback-smtp.eu-west-1.amazonses.com"
  priority = 10
  proxied  = false
}

resource "cloudflare_record" "resend_spf" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "send"
  type    = "TXT"
  content = "v=spf1 include:amazonses.com ~all"
  proxied = false
}

resource "cloudflare_record" "resend_dmarc" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "_dmarc"
  type    = "TXT"
  content = "v=DMARC1; p=none;"
  proxied = false
}
