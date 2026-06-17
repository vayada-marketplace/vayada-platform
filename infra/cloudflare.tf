resource "cloudflare_record" "target_api" {
  count = var.enable_cloudflare_dns ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "target-api"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}
