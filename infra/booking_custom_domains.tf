# VAY-2568: a hotel's own booking domain (a Cloudflare for SaaS custom hostname, CNAME to
# custom.booking.vayada.com) reaches the ALB with its own Host header. The catch-all at priority 99
# ("default-custom-domains") still sends those to the OLD booking frontend, which serves the
# old-system hotels that kept their domains. A hotel that moved to the new system is listed here
# with its property id:
#   - the ALB sends its domain to the new booking frontend (one rule each, priorities 60-98: after
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
  description = "Custom booking domains of hotels on the new system: ALB rule priority (60-98) and the hotel's property id."

  validation {
    condition = (
      alltrue([for host, route in var.next_booking_custom_domains : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", host))]) &&
      alltrue([for host, route in var.next_booking_custom_domains : host != "vayada.com" && !endswith(host, ".vayada.com")]) &&
      alltrue([for host, route in var.next_booking_custom_domains : route.priority >= 60 && route.priority <= 98 && floor(route.priority) == route.priority]) &&
      length(distinct([for host, route in var.next_booking_custom_domains : route.priority])) == length(var.next_booking_custom_domains) &&
      alltrue([for host, route in var.next_booking_custom_domains : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", route.property_id))])
    )
    error_message = "next_booking_custom_domains: lowercase hotel domains outside vayada.com, each with a distinct whole priority from 60 to 98 and a lowercase property UUID."
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
