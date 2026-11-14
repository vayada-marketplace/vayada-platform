# VAY-1362 waves: take migrated hotels off the legacy booking engine, one wave at a time.
# Both inputs are empty by default, so this adds no listener rule and the plan shows no
# change. Go-day sets them in infra/legacy_wave_cutover.auto.tfvars.json (with Flamur's go);
# deleting that file removes the rules again. See docs/legacy-wave-cutover.md.

variable "legacy_booking_blocked_slugs" {
  description = "Legacy booking slugs whose pms-api booking routes (/api/hotels/<slug>/bookings*) answer a fixed 410. Empty adds no rule."
  type        = list(string)
  default     = []

  validation {
    condition = (
      length(var.legacy_booking_blocked_slugs) <= 24 &&
      length(distinct(var.legacy_booking_blocked_slugs)) == length(var.legacy_booking_blocked_slugs) &&
      alltrue([for slug in var.legacy_booking_blocked_slugs : length(slug) <= 100 && can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", slug))])
    )
    error_message = "Use at most 24 distinct legacy booking slugs: lowercase letters, digits and single hyphens."
  }
}

variable "legacy_booking_redirects" {
  description = "Legacy booking-engine host (<slug>.booking.vayada.com or a custom domain) => the hotel's v2 booking host (<slug>.next-booking.vayada.com). Requests keep their path and query and get a temporary (302) redirect. Empty adds no rule."
  type        = map(string)
  default     = {}

  validation {
    condition = (
      length(var.legacy_booking_redirects) <= 13 &&
      alltrue([for from, to in var.legacy_booking_redirects : (
        (
          (can(regex("^[a-z0-9]+(-[a-z0-9]+)*\\.booking\\.vayada\\.com$", from)) && !contains(["admin", "www", "custom", "api"], split(".", from)[0])) ||
          (can(regex("^([a-z0-9]+(-[a-z0-9]+)*\\.)+[a-z]{2,}$", from)) && !endswith(from, "vayada.com"))
        ) &&
        can(regex("^[a-z0-9]+(-[a-z0-9]+)*\\.next-booking\\.vayada\\.com$", to))
      )])
    )
    error_message = "Redirect at most 13 hosts: <slug>.booking.vayada.com (not admin, www, custom or api) or a custom domain outside vayada.com, each to <slug>.next-booking.vayada.com."
  }
}

locals {
  # Free priorities on the HTTPS listener: the blocks must come before pms-api.vayada.com (30),
  # the redirects before *.booking.vayada.com (50) and the custom-domain catch-all (99). 35 is
  # kept for the staging PMS API.
  legacy_booking_block_priorities    = [21, 22, 23, 24, 26, 27, 28, 29]
  legacy_booking_redirect_priorities = [31, 32, 33, 34, 36, 37, 38, 39, 41, 42, 43, 44, 47]

  # A listener rule condition holds at most three values, so one rule blocks three slugs.
  legacy_booking_block_rules = {
    for index, slugs in chunklist(var.legacy_booking_blocked_slugs, 3) : tostring(index) => {
      priority = local.legacy_booking_block_priorities[index]
      paths    = [for slug in slugs : "/api/hotels/${slug}/bookings*"]
    }
  }

  legacy_booking_redirect_rules = {
    for index, from in sort(keys(var.legacy_booking_redirects)) : from => {
      priority = local.legacy_booking_redirect_priorities[index]
      to       = var.legacy_booking_redirects[from]
    }
  }
}
