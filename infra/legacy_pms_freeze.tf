# VAY-1362: freeze switches for the production legacy PMS (vayada-pms-backend).
# Every switch defaults to null. A null switch adds nothing to the container, so
# the task definition stays byte-identical until a switch is set: go-day sets the
# freeze ones, legacy_pms_scheduler_blocklist.auto.tfvars.json stops the affiliate
# payout job. See docs/legacy-pms-freeze.md.

variable "legacy_pms_scheduler_enabled" {
  description = "PMS_SCHEDULER_ENABLED on production legacy PMS. null keeps the app default (true); false freezes every legacy scheduler job."
  type        = bool
  default     = null
}

# The ids mirror LEGACY_SCHEDULER_JOBS in apps/pms-api/app/services/scheduler.py. The app
# freezes ALL jobs when the list holds an id it does not know, so a typo must fail here.
variable "legacy_pms_scheduler_job_blocklist" {
  description = "PMS_SCHEDULER_JOB_BLOCKLIST on production legacy PMS: legacy scheduler jobs to stop while the others keep running. null keeps the app default (none)."
  type        = list(string)
  default     = null

  validation {
    condition = var.legacy_pms_scheduler_job_blocklist == null ? true : (length(var.legacy_pms_scheduler_job_blocklist) > 0 && alltrue([
      for job in var.legacy_pms_scheduler_job_blocklist : contains([
        "expire_pending_bookings",
        "cancel_stale_unpaid_bookings",
        "cleanup_expired_drafts",
        "process_property_payouts",
        "process_affiliate_payouts",
        "poll_xendit_processing_payouts",
        "poll_channex_bookings",
        "full_channex_ari_sync",
        "advance_calendar_auto_open_windows",
      ], job)
    ]))
    error_message = "legacy_pms_scheduler_job_blocklist must be null or a non-empty list of known legacy PMS scheduler job ids. An unknown id would freeze every legacy job."
  }
}

variable "legacy_pms_webhook_mode" {
  description = "PMS_LEGACY_WEBHOOK_MODE on production legacy PMS, for every provider without its own mode. null keeps the app default (mutating). The freeze uses proxy_to_target with no target URL (answers 503). ack_only_with_receipt is rejected: it acknowledges and drops events."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_webhook_mode == null ? true : contains(["mutating", "proxy_to_target"], var.legacy_pms_webhook_mode)
    error_message = "legacy_pms_webhook_mode must be null, mutating or proxy_to_target. ack_only_with_receipt drops provider events and is not allowed in production."
  }
}

variable "legacy_pms_stripe_webhook_mode" {
  description = "PMS_LEGACY_STRIPE_WEBHOOK_MODE on production legacy PMS. null falls back to legacy_pms_webhook_mode."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_stripe_webhook_mode == null ? true : contains(["mutating", "proxy_to_target"], var.legacy_pms_stripe_webhook_mode)
    error_message = "legacy_pms_stripe_webhook_mode must be null, mutating or proxy_to_target. ack_only_with_receipt drops provider events and is not allowed in production."
  }
}

variable "legacy_pms_xendit_webhook_mode" {
  description = "PMS_LEGACY_XENDIT_WEBHOOK_MODE on production legacy PMS. null falls back to legacy_pms_webhook_mode."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_xendit_webhook_mode == null ? true : contains(["mutating", "proxy_to_target"], var.legacy_pms_xendit_webhook_mode)
    error_message = "legacy_pms_xendit_webhook_mode must be null, mutating or proxy_to_target. ack_only_with_receipt drops provider events and is not allowed in production."
  }
}

variable "legacy_pms_channex_webhook_mode" {
  description = "PMS_LEGACY_CHANNEX_WEBHOOK_MODE on production legacy PMS. null falls back to legacy_pms_webhook_mode."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_channex_webhook_mode == null ? true : contains(["mutating", "proxy_to_target"], var.legacy_pms_channex_webhook_mode)
    error_message = "legacy_pms_channex_webhook_mode must be null, mutating or proxy_to_target. ack_only_with_receipt drops provider events and is not allowed in production."
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

variable "legacy_pms_channex_admin_manual_ari_sync_mode" {
  description = "CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE on production legacy PMS. null keeps CHANNEX_ADMIN_DEFAULT_MODE (legacy-owned). The freeze uses disabled."
  type        = string
  default     = null

  validation {
    condition     = var.legacy_pms_channex_admin_manual_ari_sync_mode == null ? true : contains(["legacy-owned", "read-only", "disabled", "proxy-to-target", "target-owned"], var.legacy_pms_channex_admin_manual_ari_sync_mode)
    error_message = "legacy_pms_channex_admin_manual_ari_sync_mode must be null, legacy-owned, read-only, disabled, proxy-to-target or target-owned."
  }
}

locals {
  # Only switches that are set reach the container; unset ones keep the app default.
  legacy_pms_freeze_environment = [
    for entry in [
      { name = "PMS_SCHEDULER_ENABLED", value = var.legacy_pms_scheduler_enabled == null ? null : tostring(var.legacy_pms_scheduler_enabled) },
      { name = "PMS_SCHEDULER_JOB_BLOCKLIST", value = var.legacy_pms_scheduler_job_blocklist == null ? null : join(",", var.legacy_pms_scheduler_job_blocklist) },
      { name = "PMS_LEGACY_WEBHOOK_MODE", value = var.legacy_pms_webhook_mode },
      { name = "PMS_LEGACY_STRIPE_WEBHOOK_MODE", value = var.legacy_pms_stripe_webhook_mode },
      { name = "PMS_LEGACY_XENDIT_WEBHOOK_MODE", value = var.legacy_pms_xendit_webhook_mode },
      { name = "PMS_LEGACY_CHANNEX_WEBHOOK_MODE", value = var.legacy_pms_channex_webhook_mode },
      { name = "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE", value = var.legacy_pms_channex_admin_manual_booking_sync_mode },
      { name = "CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE", value = var.legacy_pms_channex_admin_manual_ari_sync_mode },
    ] : entry if entry.value != null
  ]
}
