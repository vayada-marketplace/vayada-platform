variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

variable "aws_account_id" {
  description = "AWS account ID"
  type        = string
  default     = "269416271598"
}

variable "vpc_id" {
  description = "Existing VPC ID"
  type        = string
  default     = "vpc-055e8074dc3b2422a"
}

variable "subnet_ids" {
  description = "Existing public subnet IDs"
  type        = list(string)
  default     = ["subnet-0cebe0311f380e8e6", "subnet-0f5978ad929071531"]
}

variable "ecs_cluster_name" {
  description = "Existing ECS cluster name"
  type        = string
  default     = "vayada-backend-cluster"
}

variable "rds_endpoint" {
  description = "Existing RDS endpoint"
  type        = string
  default     = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com"
}

variable "db_master_password" {
  description = "RDS master password for creating databases and users"
  type        = string
  sensitive   = true
}

variable "db_booking_password" {
  description = "Password for vayada_booking_user"
  type        = string
  sensitive   = true
}

variable "db_pms_password" {
  description = "Password for vayada_pms_user"
  type        = string
  sensitive   = true
}

variable "db_auth_password" {
  description = "Password for vayada_auth_user"
  type        = string
  sensitive   = true
}

variable "jwt_secret_key" {
  description = "JWT secret key for backend services"
  type        = string
  sensitive   = true
}

variable "route53_zone_id" {
  description = "Existing Route 53 hosted zone ID for vayada.com"
  type        = string
  default     = "Z0697992S4X2JJCWPIDX"
}

variable "smtp_username" {
  description = "SES SMTP username for sending emails"
  type        = string
  sensitive   = true
  default     = ""
}

variable "smtp_password" {
  description = "SES SMTP password for sending emails"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_secret_key" {
  description = "Stripe secret key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_publishable_key" {
  description = "Stripe publishable key"
  type        = string
  default     = ""
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook signing secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "channex_webhook_secret" {
  description = "Channex webhook header token"
  type        = string
  sensitive   = true
  default     = ""
}

variable "staging_target_database_url" {
  description = "Target database URL used by C1 staging rehearsal tooling"
  type        = string
  sensitive   = true
  default     = ""
}

variable "target_database_url" {
  description = "Production-owned target database URL used by next-api.vayada.com"
  type        = string
  sensitive   = true
  default     = ""
}

variable "manage_staging_rehearsal_secrets" {
  description = "Whether Terraform should create the /vayada/staging C1 rehearsal SSM parameters"
  type        = bool
  default     = false
}

variable "staging_rehearsal_secret_owner" {
  description = "Owner tag for /vayada/staging C1 rehearsal SSM parameters"
  type        = string
  default     = "platform-runtime"
}

variable "staging_rehearsal_secret_expires_at" {
  description = "ISO-8601 expiry tag for /vayada/staging C1 rehearsal SSM parameters; override per rehearsal"
  type        = string
  default     = "2026-06-30T18:00:00Z"
}

variable "staging_stripe_webhook_secret" {
  description = "Stripe webhook signing secret used for C1 staging replay"
  type        = string
  sensitive   = true
  default     = ""
}

variable "staging_xendit_webhook_secret" {
  description = "Xendit callback token used for C1 staging replay"
  type        = string
  sensitive   = true
  default     = ""
}

variable "staging_channex_webhook_secret" {
  description = "Channex webhook header token used for C1 staging replay"
  type        = string
  sensitive   = true
  default     = ""
}

variable "enable_staging_pms_runtime" {
  description = "Whether Terraform should create the frozen staging PMS backend runtime for C1 rehearsal"
  type        = bool
  default     = false
}

variable "legacy_booking_api_desired_count" {
  description = "Desired ECS task count for the legacy Python Booking API service. Keep 1 through canonical API cutover smoke; set 0 only after acceptance."
  type        = number
  default     = 1

  validation {
    condition     = contains([0, 1], var.legacy_booking_api_desired_count)
    error_message = "legacy_booking_api_desired_count must be 0 or 1."
  }
}

variable "legacy_marketplace_api_desired_count" {
  description = "Desired ECS task count for the legacy Python Marketplace API service. Keep 1 through canonical API cutover smoke; set 0 only after acceptance."
  type        = number
  default     = 1

  validation {
    condition     = contains([0, 1], var.legacy_marketplace_api_desired_count)
    error_message = "legacy_marketplace_api_desired_count must be 0 or 1."
  }
}

variable "legacy_pms_api_desired_count" {
  description = "Desired ECS task count for the legacy Python PMS API service. Keep 1 while provider webhook paths remain routed there; set 0 only after provider callback cutover removes that dependency."
  type        = number
  default     = 1

  validation {
    condition     = contains([0, 1], var.legacy_pms_api_desired_count)
    error_message = "legacy_pms_api_desired_count must be 0 or 1."
  }
}

variable "target_backend_desired_count" {
  description = "Desired ECS task count for the TypeScript target backend runtime. Keep 0 until a vayada-api image has been published and the runtime is intentionally enabled."
  type        = number
  default     = 0
}

variable "target_backend_staging_secrets_preprovisioned" {
  description = "Set true only when the /vayada/staging parameters required by the TypeScript target backend already exist outside this Terraform apply."
  type        = bool
  default     = false
}

variable "target_backend_production_cutover_enabled" {
  description = "Enable production source flags and AuthKit runtime config for the TypeScript target backend. Provider webhooks remain observe-only."
  type        = bool
  default     = false
}

variable "next_api_stripe_webhook_intake_mode" {
  description = "Stripe callback intake mode for the canonical TypeScript API."
  type        = string
  default     = "mutating"

  validation {
    condition     = contains(["observe_only", "mutating", "ack_only_with_receipt"], var.next_api_stripe_webhook_intake_mode)
    error_message = "next_api_stripe_webhook_intake_mode must be observe_only, mutating, or ack_only_with_receipt."
  }
}

variable "next_api_channex_webhook_intake_mode" {
  description = "Channex callback intake mode for the canonical TypeScript API."
  type        = string
  default     = "mutating"

  validation {
    condition     = contains(["observe_only", "mutating", "ack_only_with_receipt"], var.next_api_channex_webhook_intake_mode)
    error_message = "next_api_channex_webhook_intake_mode must be observe_only, mutating, or ack_only_with_receipt."
  }
}

variable "workos_api_key" {
  description = "WorkOS API key used by the TypeScript target backend AuthKit runtime"
  type        = string
  sensitive   = true
  default     = ""
}

variable "workos_webhook_secret" {
  description = "WorkOS webhook signing secret used by the TypeScript target backend AuthKit runtime"
  type        = string
  sensitive   = true
  default     = ""
}

variable "workos_client_id" {
  description = "WorkOS client ID used by the TypeScript target backend AuthKit runtime"
  type        = string
  default     = ""
}

variable "workos_audience" {
  description = "WorkOS JWT audience used by the TypeScript target backend"
  type        = string
  default     = ""
}

variable "workos_issuer" {
  description = "WorkOS JWT issuer used by the TypeScript target backend"
  type        = string
  default     = ""
}

variable "workos_jwks_url" {
  description = "WorkOS JWKS URL used by the TypeScript target backend"
  type        = string
  default     = ""
}

variable "auth_cookie_secret" {
  description = "Cookie encryption secret used by the TypeScript target backend AuthKit runtime"
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_api_key" {
  description = "OpenAI API key used by Ask Intelligence when ASK_INTELLIGENCE_PROVIDER=openai"
  type        = string
  sensitive   = true
  default     = ""
}

variable "ask_intelligence_provider" {
  description = "Ask Intelligence provider for next-api.vayada.com"
  type        = string
  default     = "fixture"

  validation {
    condition     = contains(["fixture", "openai"], var.ask_intelligence_provider)
    error_message = "ask_intelligence_provider must be fixture or openai."
  }
}

variable "ask_intelligence_model" {
  description = "Ask Intelligence model when ask_intelligence_provider is openai"
  type        = string
  default     = ""
}

variable "openai_base_url" {
  description = "Optional OpenAI-compatible base URL for Ask Intelligence"
  type        = string
  default     = ""
}

variable "openai_organization" {
  description = "Optional OpenAI organization for Ask Intelligence"
  type        = string
  default     = ""
}

variable "openai_project" {
  description = "Optional OpenAI project for Ask Intelligence"
  type        = string
  default     = ""
}

variable "staging_pms_database_url" {
  description = "PMS database URL used by the frozen staging PMS backend runtime"
  type        = string
  sensitive   = true
  default     = ""
}

variable "staging_pms_auth_database_url" {
  description = "Staging or approved read-only auth database URL used by the frozen staging PMS backend runtime"
  type        = string
  sensitive   = true
  default     = ""
}

variable "staging_pms_booking_engine_database_url" {
  description = "Staging or approved read-only booking database URL used by the frozen staging PMS backend runtime"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_platform_account_id" {
  description = "Stripe platform account ID"
  type        = string
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token for custom hostname management"
  type        = string
  sensitive   = true
  default     = ""
}

variable "channex_api_key" {
  description = "Channex channel manager production API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude AI listing import"
  type        = string
  sensitive   = true
  default     = ""
}

variable "firecrawl_api_key" {
  description = "Firecrawl API key for web scraping"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for vayada.com"
  type        = string
  default     = "77009db898599f8a81d571050e7c5f15"
}

variable "enable_cloudflare_dns" {
  description = "Whether Terraform should manage public Cloudflare DNS records. Keep false until TF_VAR_CLOUDFLARE_API_TOKEN is a valid DNS edit token for vayada.com."
  type        = bool
  default     = false
}

variable "alb_sg_id" {
  description = "Existing ALB security group ID"
  type        = string
  default     = "sg-0fcf3d67a61a7d1fd"
}

variable "rds_sg_id" {
  description = "Existing RDS security group ID"
  type        = string
  default     = "sg-0089fc5e42fa33566"
}
