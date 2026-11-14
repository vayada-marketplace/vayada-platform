# VAY-2108: pause online booking on the pages of hotels moving from the legacy system to the
# target (Tiga Lombok, Aether Hilltop Villas) between the switch's bookings stage and its prices
# stage. In that window neither system sends availability to Channex for the hotel, so a direct
# booking on either the old page or the new page would not close the room on Booking.com or
# Airbnb. Each listed host answers a fixed 503 page; nothing else changes (no PMS, Channex or
# booking data). Remove a host to restore its page. Priorities 1-9 sit ahead of every other rule,
# including *.booking.vayada.com (50), *.next-booking.vayada.com (54) and the custom-domain
# catch-all (99).
variable "booking_pause_hosts" {
  type        = list(string)
  default     = []
  description = "Booking page hosts (old or new page, or a hotel's custom domain) that answer a fixed 'online booking is paused' page."

  validation {
    condition = (
      length(var.booking_pause_hosts) <= 9 &&
      length(distinct(var.booking_pause_hosts)) == length(var.booking_pause_hosts) &&
      alltrue([for host in var.booking_pause_hosts : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", host))]) &&
      length(setintersection(toset(var.booking_pause_hosts), toset([
        "booking.vayada.com", "next-booking.vayada.com", "admin.booking.vayada.com", "custom.booking.vayada.com",
        "next-booking-admin.vayada.com", "next-api.vayada.com", "pms.vayada.com", "next-pms.vayada.com",
        "pms-api.vayada.com", "booking-api.vayada.com", "next-admin.vayada.com", "vayada.com", "www.vayada.com",
      ]))) == 0
    )
    error_message = "booking_pause_hosts must be at most 9 distinct lowercase hotel page hosts, never a shared Vayada host."
  }
}

locals {
  booking_paused_response = {
    status_code  = "503"
    content_type = "text/html"
    message_body = "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Online booking is paused</title></head><body style='font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center;color:#222'><h1>Online booking is paused</h1><p>We are moving to a new booking system. Please check back in a few hours, or contact the property directly to book.</p></body></html>"
  }

  booking_pause_listener_rules = {
    for index, host in var.booking_pause_hosts : "booking-pause-${index + 1}" => {
      priority       = index + 1
      host           = host
      fixed_response = local.booking_paused_response
    }
  }
}
