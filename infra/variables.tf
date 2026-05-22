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
