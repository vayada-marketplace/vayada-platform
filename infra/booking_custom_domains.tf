# VAY-2568: a hotel's own booking domain (a Cloudflare for SaaS custom hostname, CNAME to
# custom.booking.vayada.com) reaches the ALB with its own Host header. The catch-all at priority 99
# ("default-custom-domains") still sends those to the OLD booking frontend, which serves the
# old-system hotels that kept their domains. A hotel that moved to the new system is listed here
# with its property id:
#   - the ALB sends its domain to the new booking frontend (one rule each, priorities 60-89: after
#     every named host rule, 54 being the last, and before the catch-all; the VAY-2108 pause rules
#     1-9 still win while a host is listed there);
#   - next-api gets the list as BOOKING_CUSTOM_DOMAIN_ROUTES and verifies the domain in Booking Admin
#     only for that property. A verified domain becomes the page's address (booking-web redirects
#     guests to it), so it must be routed first, and naming the property here is what proves whose
#     domain it is.
# Until the hotel's domain is verified, the new frontend answers "domain not configured" for it.
variable "next_booking_custom_domains" {
  type = map(object({
    priority    = number
    property_id = string
  }))
  default     = {}
  description = "Custom booking domains of hotels on the new system: ALB rule priority (60-89; 90-98 are the old system's, VAY-2579) and the hotel's property id."

  validation {
    condition = (
      alltrue([for host, route in var.next_booking_custom_domains : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", host))]) &&
      alltrue([for host, route in var.next_booking_custom_domains : host != "vayada.com" && !endswith(host, ".vayada.com")]) &&
      alltrue([for host, route in var.next_booking_custom_domains : route.priority >= 60 && route.priority <= 89 && floor(route.priority) == route.priority]) &&
      length(distinct([for host, route in var.next_booking_custom_domains : route.priority])) == length(var.next_booking_custom_domains) &&
      alltrue([for host, route in var.next_booking_custom_domains : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", route.property_id))])
    )
    error_message = "next_booking_custom_domains: lowercase hotel domains outside vayada.com, each with a distinct whole priority from 60 to 89 and a lowercase property UUID."
  }
}

locals {
  next_booking_custom_domain_listener_rules = {
    for host, route in var.next_booking_custom_domains : "next-booking-domain-${host}" => {
      priority     = route.priority
      host         = host
      target_group = "next-booking-frontend"
    }
  }

  next_booking_custom_domain_routes = join(",", [for host, route in var.next_booking_custom_domains : "${host}=${route.property_id}"])
}

# A moved hotel's other addresses that the new booking page can't serve: its old-system pages
# (<name>.booking.vayada.com would reach the OLD booking frontend through *.booking.vayada.com at
# 50) and a second custom domain that isn't its verified one (the new frontend would answer
# "domain not configured"). Each answers a 302 to the hotel's verified domain instead. Priorities
# 41-45 sit before *.booking.vayada.com (50) and the custom-domain rules (60-98); the VAY-2108
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
