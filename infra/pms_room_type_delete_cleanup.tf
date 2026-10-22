# VAY-2132: properties whose PMS room type Delete also retires the room units, closes the
# future nights and takes the room type out of the operating calendar in one step, when no
# booking, hold, channel mapping or limit stops it (apps/api PMS_ROOM_TYPE_DELETE_CLEANUP_PROPERTY_IDS,
# vayada #3346-#3351, live since rel-69ac5202). Empty keeps today's Delete; ["*"] turns it on for
# every property. Rolled out at Sri Journeys first (#553), then widened to "*".
variable "pms_room_type_delete_cleanup_property_ids" {
  type        = list(string)
  default     = []
  description = "Property UUIDs whose room type Delete does the cleanup on vayada-next-api (PMS_ROOM_TYPE_DELETE_CLEANUP_PROPERTY_IDS), or [\"*\"] for every property. Empty is off."

  validation {
    condition = (
      (length(var.pms_room_type_delete_cleanup_property_ids) == 1 && contains(var.pms_room_type_delete_cleanup_property_ids, "*")) ||
      (
        length(var.pms_room_type_delete_cleanup_property_ids) <= 100 &&
        length(distinct(var.pms_room_type_delete_cleanup_property_ids)) == length(var.pms_room_type_delete_cleanup_property_ids) &&
        alltrue([for id in var.pms_room_type_delete_cleanup_property_ids : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))])
      )
    )
    error_message = "pms_room_type_delete_cleanup_property_ids must be up to 100 distinct lowercase property UUIDs, or exactly [\"*\"]."
  }
}
