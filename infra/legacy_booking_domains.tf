# VAY-2579 (step 3 of 5): name the old booking system's hotel domains, and freeze domain changes in the
# old Booking Admin, so the catch-all (99) can later point at the NEW booking frontend (step 4) without
# any old-system hotel losing its page.
#
# Today every hotel domain that no rule names reaches the old booking frontend through the catch-all.
# The domains listed here get rules of their own to that same frontend, so nothing changes for guests
# now; once the catch-all moves, these keep their old pages and every other domain reaches the new
# frontend, which shows a hotel's page only for a domain verified in the new Booking Admin.
#
# The list is the old system's domains that serve its pages today: Cloudflare for SaaS hostnames that
# are active (cross-checked read-only against booking_hotels.custom_domain), minus the hotels that
# moved (Tiga Lombok, Aether Hilltop Villas; see booking_custom_domains.tf). Keys are rule priorities
# 55-59 (after *.next-booking.vayada.com at 54, before the new-system domains at 60-98), each with at
# most 5 hosts (the ALB's limit of condition values per rule). When an old-system hotel moves, remove
# its domain from its rule only; the other rules stay as they are. The list only ever shrinks: the
# old Booking Admin can't add domains any more (below).
variable "legacy_booking_custom_domains" {
  type        = map(list(string))
  default     = {}
  description = "Old booking system hotel domains that keep reaching the old booking frontend: ALB rule priority (55-59) to at most 5 hosts."

  validation {
    condition = (
      alltrue([for priority, hosts in var.legacy_booking_custom_domains : can(tonumber(priority)) && tonumber(priority) >= 55 && tonumber(priority) <= 59 && floor(tonumber(priority)) == tonumber(priority)]) &&
      alltrue([for priority, hosts in var.legacy_booking_custom_domains : length(hosts) >= 1 && length(hosts) <= 5]) &&
      length(distinct(flatten(values(var.legacy_booking_custom_domains)))) == length(flatten(values(var.legacy_booking_custom_domains))) &&
      alltrue([for host in flatten(values(var.legacy_booking_custom_domains)) : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", host)) && host != "vayada.com" && !endswith(host, ".vayada.com")])
    )
    error_message = "legacy_booking_custom_domains: priorities 55-59, each with 1-5 distinct lowercase hotel domains outside vayada.com."
  }
}

locals {
  legacy_booking_custom_domain_hosts = flatten(values(var.legacy_booking_custom_domains))

  # A host here and in another hotel-host list would leave one of the two rules dead.
  legacy_booking_custom_domain_overlaps = setintersection(
    toset(local.legacy_booking_custom_domain_hosts),
    setunion(
      toset(keys(var.next_booking_custom_domains)),
      toset(keys(var.next_booking_host_redirects)),
      toset(var.booking_pause_hosts),
    ),
  )

  legacy_booking_custom_domain_listener_rules = {
    for priority, hosts in var.legacy_booking_custom_domains : "legacy-booking-domains-${priority}" => {
      priority     = tonumber(priority)
      hosts        = hosts
      target_group = "booking-frontend"
    }
  }

  # The old Booking Admin (admin.booking.vayada.com) connects and removes domains with POST and DELETE
  # /admin/settings/custom-domain on booking-api, which registers or deletes the Cloudflare hostname.
  # Those answer this instead, before booking-api's own rule (20); its message is what the old admin
  # shows. Reading a domain's status (GET) still works. No old code is deployed for it.
  legacy_booking_admin_custom_domain_freeze_rules = {
    legacy-booking-admin-custom-domain-freeze = {
      priority = 19
      host     = "booking-api.vayada.com"
      paths    = ["/admin/settings/custom-domain", "/admin/settings/custom-domain/"]
      methods  = ["POST", "DELETE"]
      fixed_response = {
        status_code  = "409"
        content_type = "application/json"
        message_body = jsonencode({ detail = "Custom domains are now managed in the new Booking Admin: https://next-booking-admin.vayada.com (Design Studio > Domain)." })
      }
    }
  }
}
