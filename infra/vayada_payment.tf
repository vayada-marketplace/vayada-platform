# VAY-2442: the hotels vayada Payment is on for (apps/api VAYADA_PAYMENT_PROPERTY_IDS), once
# VAYADA_PAYMENT_ENABLED is on in ecs.tf. Guest card payments go to Vayada's own Stripe account
# (test mode only: next-api refuses live keys) and Vayada pays the hotel out to its bank account.
# Empty is no hotel; ["*"] is every hotel. First only the TEST ONLY Agent hotel (Flamur, 2026-11-02).
variable "vayada_payment_property_ids" {
  type        = list(string)
  default     = []
  description = "Property UUIDs vayada Payment is on for in vayada-next-api (VAYADA_PAYMENT_PROPERTY_IDS), or [\"*\"] for every property. Empty is no property."

  validation {
    condition = (
      (length(var.vayada_payment_property_ids) == 1 && contains(var.vayada_payment_property_ids, "*")) ||
      (
        length(var.vayada_payment_property_ids) <= 100 &&
        length(distinct(var.vayada_payment_property_ids)) == length(var.vayada_payment_property_ids) &&
        alltrue([for id in var.vayada_payment_property_ids : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))])
      )
    )
    error_message = "vayada_payment_property_ids must be up to 100 distinct lowercase property UUIDs, or exactly [\"*\"]."
  }
}
