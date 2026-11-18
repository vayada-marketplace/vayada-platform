# VAY-2442: the hotels vayada Payment is on for (apps/api VAYADA_PAYMENT_PROPERTY_IDS), once
# VAYADA_PAYMENT_ENABLED is on in ecs.tf. Guest card payments go to Vayada's own Stripe account
# and Vayada pays the hotel out to its bank account. A hotel on vayada_payment_live_property_ids
# takes real money with the live keys; every other hotel uses the test keys (no real money).
# Every hotel that takes charges must be live or one of Vayada's test hotels below (checked on the
# next-api task definition in ecs.tf). First only the TEST ONLY Agent hotel (Flamur, 2026-11-02).
#
# The UUID pattern matches next-api's (zod z.uuid(): version 1-8, variant 8/9/a/b), so a value
# Terraform accepts never stops next-api at boot.
variable "vayada_payment_property_ids" {
  type        = list(string)
  default     = []
  description = "Property UUIDs that may take new vayada Payment charges in vayada-next-api (VAYADA_PAYMENT_PROPERTY_IDS). Each must also be on vayada_payment_live_property_ids or be one of Vayada's test hotels (infra/vayada_payment.tf). Empty is no property."

  validation {
    condition = (
      length(var.vayada_payment_property_ids) <= 100 &&
      length(distinct(var.vayada_payment_property_ids)) == length(var.vayada_payment_property_ids) &&
      alltrue([for id in var.vayada_payment_property_ids : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", id))])
    )
    error_message = "vayada_payment_property_ids must be up to 100 distinct lowercase property UUIDs."
  }
}

# Hotels whose vayada Payment money is real (apps/api VAYADA_PAYMENT_LIVE_PROPERTY_IDS): all their
# charges, refunds and disputes use the live keys. A hotel stays here while it has live payments,
# even after it leaves vayada_payment_property_ids (that's how to stop its new charges), or its
# refunds would go to the test keys and fail.
variable "vayada_payment_live_property_ids" {
  type        = list(string)
  default     = []
  description = "Property UUIDs whose vayada Payment money is real (VAYADA_PAYMENT_LIVE_PROPERTY_IDS). Never \"*\". Keep a hotel here while it has live payments."

  validation {
    condition = (
      length(var.vayada_payment_live_property_ids) <= 100 &&
      length(distinct(var.vayada_payment_live_property_ids)) == length(var.vayada_payment_live_property_ids) &&
      alltrue([for id in var.vayada_payment_live_property_ids : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", id))])
    )
    error_message = "vayada_payment_live_property_ids must be up to 100 distinct lowercase property UUIDs (never \"*\")."
  }
}

locals {
  # Vayada's own internal test hotels: they take vayada Payment charges in Stripe test mode and
  # never go live (their test payments would go to the live keys and fail). Never a real hotel:
  # anyone with Stripe's public test card could book one without paying. Only ever add to this.
  vayada_payment_test_property_ids = toset([
    "103a5fe7-05a4-4bf2-8a75-67a9ceaf9f21", # TEST ONLY Agent
  ])

  # A hotel that takes charges but isn't live or a test hotel would take test-mode charges: a real
  # hotel added only to vayada_payment_property_ids would confirm bookings paid with Stripe's public
  # test card. next-api's own guard catches that only after the hotel's first live payment.
  vayada_payment_lists_consistent = (
    length(setsubtract(
      toset(var.vayada_payment_property_ids),
      setunion(toset(var.vayada_payment_live_property_ids), local.vayada_payment_test_property_ids),
    )) == 0 &&
    length(setintersection(toset(var.vayada_payment_live_property_ids), local.vayada_payment_test_property_ids)) == 0
  )
}
