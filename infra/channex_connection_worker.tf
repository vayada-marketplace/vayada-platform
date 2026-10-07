# VAY-2055: Channex connection (enable-only) processing on vayada-next-api.
# Both default to false; each step is a reviewed Terraform change. Map the
# secret after the connection-scope grant and preflight pass, then enable.
variable "channex_connection_worker_secret_mapped" {
  type        = bool
  default     = false
  description = "Map the dedicated Channex management worker secret to vayada-next-api after its connection-scope preflight passes."
}

variable "channex_connection_worker_enabled" {
  type        = bool
  default     = false
  description = "Run Channex enable (connection) jobs for hotels without a binding; every other durable Channex capability stays observe_only."
}
