resource "cloudflare_record" "target_api" {
  zone_id = var.cloudflare_zone_id
  name    = "target-api"
  type    = "CNAME"
  content = data.aws_lb.main.dns_name
  proxied = false
}
