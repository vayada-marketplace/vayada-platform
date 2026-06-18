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
