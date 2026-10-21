# VAY-2108: Channex for hotels handed over to the target. "off" keeps the
# VAY-2055 connection-only scope. "booking" also pulls and ingests Channex
# bookings, every 5 minutes, for hotels that have an active binding claim and
# are listed below. Each change is a reviewed Terraform change, made only while
# next-api runs an image listed in scripts/next-api-channex-claimed-compatible-images.txt.
variable "channex_claimed_scope" {
  type        = string
  default     = "off"
  description = "Channex scope for claimed hotels on vayada-next-api: off or booking."

  validation {
    condition     = contains(["off", "booking"], var.channex_claimed_scope)
    error_message = "channex_claimed_scope must be off or booking."
  }
}

variable "channex_owned_property_ids" {
  type        = list(string)
  default     = []
  description = "Target property UUIDs next-api may run Channex booking sync for (PMS_CHANNEX_OWNED_PROPERTY_IDS). Non-empty exactly when the claimed scope is on: the app refuses the claimed scope without the variable, and an empty ECS environment value is not relied on."

  validation {
    condition = (
      alltrue([for id in var.channex_owned_property_ids : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))]) &&
      length(distinct(var.channex_owned_property_ids)) == length(var.channex_owned_property_ids) &&
      # Staging and test rows that sit in the production database (app migration 0432).
      length(setintersection(toset(var.channex_owned_property_ids), toset([
        "17621565-40b5-4ebc-8727-3a301ac947a2", "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
        "65f6b2fc-c783-4963-9d6b-a85f82319769", "8f4c1e47-3de1-4150-8bde-ad031a013842",
      ]))) == 0
    )
    error_message = "channex_owned_property_ids must be distinct lowercase UUIDs and must not name a reserved staging or test property."
  }
}
