# VAY-2568, VAY-2579: a hotel's own booking domain (a Cloudflare for SaaS custom hostname, CNAME to
# custom.booking.vayada.com) reaches the ALB with its own Host header. No rule names it: the catch-all
# at priority 99 ("default-custom-domains", alb.tf) sends it to the NEW booking frontend, which shows
# the hotel whose verified domain it is and "domain not configured" for any other. A hotel verifies
# its domain itself in Booking Admin (the CNAME plus its TXT ownership record), so no domain needs a
# platform change. The old system's hotel domains keep the OLD frontend through their own rules
# (legacy_booking_domains.tf, 90-98); next-api never verifies those. To move an old-system hotel,
# remove its domain there.

# A moved hotel's other addresses that the new booking page can't serve: its old-system pages
# (<name>.booking.vayada.com would reach the OLD booking frontend through *.booking.vayada.com at
# 50) and a second custom domain that isn't its verified one (the new frontend would answer
# "domain not configured"). Each answers a 302 to the hotel's verified domain instead. Priorities
# 41-45 sit before *.booking.vayada.com (50) and the old-system domain rules (90-98); the VAY-2108
# pause rules (1-9) still win while a host is listed there. List a host only once its target
# domain shows "Connected" in Booking Admin.
variable "next_booking_host_redirects" {
  type = map(object({
    priority = number
    to       = string
  }))
  default     = {}
  description = "Old or extra booking hosts of moved hotels: ALB rule priority (41-45) and the verified domain they redirect to."

  validation {
    condition = (
      alltrue([for host, rule in var.next_booking_host_redirects : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", host)) && can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", rule.to)) && host != rule.to]) &&
      alltrue([for host, rule in var.next_booking_host_redirects : rule.priority >= 41 && rule.priority <= 45 && floor(rule.priority) == rule.priority]) &&
      length(distinct([for host, rule in var.next_booking_host_redirects : rule.priority])) == length(var.next_booking_host_redirects)
    )
    error_message = "next_booking_host_redirects: lowercase hosts, each with a distinct whole priority from 41 to 45 and a different lowercase target domain."
  }
}

locals {
  next_booking_host_redirect_listener_rules = {
    for host, rule in var.next_booking_host_redirects : "next-booking-redirect-${host}" => {
      priority = rule.priority
      host     = host
      redirect = { host = rule.to, path = "/" }
    }
  }
}
