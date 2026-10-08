# VAY-1362: freeze switches for the production legacy PMS (vayada-pms-backend).
# Every switch defaults to null. A null switch adds nothing to the container, so
# the task definition stays byte-identical until go-day sets one.
# See docs/legacy-pms-freeze.md.

variable "legacy_pms_scheduler_enabled" {
  description = "PMS_SCHEDULER_ENABLED on production legacy PMS. null keeps the app default (true); false freezes every legacy scheduler job."
  type        = bool
  default     = null
}

variable "legacy_pms_webhook_mode" {
  description = "PMS_LEGACY_WEBHOOK_MODE on production legacy PMS, for every provider without its own mode. null keeps the app default (mutating). The freeze uses proxy_to_target with no target URL (answers 503). Never use ack_only_with_receipt for the freeze: it acknowledges and drops events."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_webhook_mode == null ? true : contains(["mutating", "ack_only_with_receipt", "proxy_to_target"], var.legacy_pms_webhook_mode)
    error_message = "legacy_pms_webhook_mode must be null, mutating, ack_only_with_receipt or proxy_to_target."
  }
}

variable "legacy_pms_stripe_webhook_mode" {
  description = "PMS_LEGACY_STRIPE_WEBHOOK_MODE on production legacy PMS. null falls back to legacy_pms_webhook_mode."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_stripe_webhook_mode == null ? true : contains(["mutating", "ack_only_with_receipt", "proxy_to_target"], var.legacy_pms_stripe_webhook_mode)
    error_message = "legacy_pms_stripe_webhook_mode must be null, mutating, ack_only_with_receipt or proxy_to_target."
  }
}

variable "legacy_pms_xendit_webhook_mode" {
  description = "PMS_LEGACY_XENDIT_WEBHOOK_MODE on production legacy PMS. null falls back to legacy_pms_webhook_mode."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_xendit_webhook_mode == null ? true : contains(["mutating", "ack_only_with_receipt", "proxy_to_target"], var.legacy_pms_xendit_webhook_mode)
    error_message = "legacy_pms_xendit_webhook_mode must be null, mutating, ack_only_with_receipt or proxy_to_target."
  }
}

variable "legacy_pms_channex_webhook_mode" {
  description = "PMS_LEGACY_CHANNEX_WEBHOOK_MODE on production legacy PMS. null falls back to legacy_pms_webhook_mode."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_channex_webhook_mode == null ? true : contains(["mutating", "ack_only_with_receipt", "proxy_to_target"], var.legacy_pms_channex_webhook_mode)
    error_message = "legacy_pms_channex_webhook_mode must be null, mutating, ack_only_with_receipt or proxy_to_target."
  }
}

variable "legacy_pms_channex_admin_manual_booking_sync_mode" {
  description = "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE on production legacy PMS. null keeps CHANNEX_ADMIN_DEFAULT_MODE (legacy-owned). The freeze uses disabled; any value other than legacy-owned also freezes the poll_channex_bookings job."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_channex_admin_manual_booking_sync_mode == null ? true : contains(["legacy-owned", "read-only", "disabled", "proxy-to-target", "target-owned"], var.legacy_pms_channex_admin_manual_booking_sync_mode)
    error_message = "legacy_pms_channex_admin_manual_booking_sync_mode must be null, legacy-owned, read-only, disabled, proxy-to-target or target-owned."
  }
}

locals {
  # Only switches that are set reach the container; unset ones keep the app default.
  legacy_pms_freeze_environment = [
    for entry in [
      { name = "PMS_SCHEDULER_ENABLED", value = var.legacy_pms_scheduler_enabled == null ? null : tostring(var.legacy_pms_scheduler_enabled) },
      { name = "PMS_LEGACY_WEBHOOK_MODE", value = var.legacy_pms_webhook_mode },
      { name = "PMS_LEGACY_STRIPE_WEBHOOK_MODE", value = var.legacy_pms_stripe_webhook_mode },
      { name = "PMS_LEGACY_XENDIT_WEBHOOK_MODE", value = var.legacy_pms_xendit_webhook_mode },
      { name = "PMS_LEGACY_CHANNEX_WEBHOOK_MODE", value = var.legacy_pms_channex_webhook_mode },
      { name = "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE", value = var.legacy_pms_channex_admin_manual_booking_sync_mode },
    ] : entry if entry.value != null
  ]
}
