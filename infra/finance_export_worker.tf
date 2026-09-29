# VAY-2045: terminal verification complete; keep the dedicated mapping absent.
variable "finance_export_worker_secret_mapped" {
  type        = bool
  default     = false
  description = "Map the dedicated Financials export worker secret only after its restricted-role preflight passes."
}

variable "finance_export_worker_property_id" {
  type        = string
  default     = ""
  description = "The single reviewed property in the owner-managed Financials export worker allowlist."
  validation {
    condition     = var.finance_export_worker_property_id == "" || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", var.finance_export_worker_property_id))
    error_message = "Expected an empty value or canonical property UUID."
  }
}

variable "finance_export_worker_enabled" {
  type        = bool
  default     = false
  description = "Enable ongoing Financials export processing for enrolled hotels."
}

variable "finance_export_worker_accepted_after" {
  type        = string
  default     = ""
  description = "Fixed activation cutoff; preserve across deployments so historical jobs cannot be replayed."
  validation {
    condition     = var.finance_export_worker_accepted_after == "" || can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", var.finance_export_worker_accepted_after))
    error_message = "Expected an empty value or canonical millisecond UTC timestamp."
  }
}
