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
