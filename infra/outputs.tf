output "ecr_repository_urls" {
  description = "ECR repository URLs for CI/CD"
  value = {
    for name, repo in aws_ecr_repository.repos : name => repo.repository_url
  }
}

output "service_urls" {
  description = "Service URLs for verification"
  value = {
    booking_api           = "https://booking-api.vayada.com"
    booking_frontend      = "https://<slug>.booking.vayada.com"
    booking_admin         = "https://admin.booking.vayada.com"
    pms_api               = "https://pms-api.vayada.com"
    pms_frontend          = "https://pms.vayada.com"
    next_api              = var.enable_cloudflare_dns ? "https://${cloudflare_record.next_api[0].hostname}" : "https://next-api.vayada.com"
    next_pms              = var.enable_cloudflare_dns ? "https://${cloudflare_record.next_pms[0].hostname}" : "https://next-pms.vayada.com"
    private_profile_media = var.enable_cloudflare_dns ? "https://${cloudflare_record.private_profile_media[0].hostname}" : local.private_profile_media_cdn_base_url
    staging_pms_api       = var.enable_staging_pms_runtime ? "https://staging-pms-api.vayada.com" : null
  }
}

output "rds_endpoint" {
  description = "RDS endpoint"
  value       = var.rds_endpoint
}

output "s3_bucket_name" {
  description = "S3 uploads bucket name"
  value       = aws_s3_bucket.uploads.id
}

output "private_profile_media_bucket_name" {
  description = "Private platform media bucket name"
  value       = aws_s3_bucket.private_profile_media.id
}

output "private_profile_media_cloudfront_distribution_id" {
  description = "CloudFront distribution serving public platform media"
  value       = aws_cloudfront_distribution.private_profile_media.id
}

output "private_profile_media_cdn_url" {
  description = "Custom CloudFront base URL for immutable public platform media"
  value       = local.private_profile_media_cdn_base_url
}

output "finance_folio_recipient_kms" {
  description = "Non-secret Finance folio recipient KMS runtime contract"
  value = {
    current_key_arn  = local.finance_folio_recipient_kms_current_key_arn
    allowed_key_arns = local.finance_folio_recipient_kms_allowed_key_arns
  }
}

output "platform_media_cdn_url" {
  description = "CloudFront base URL for immutable public platform media"
  value       = "https://${aws_cloudfront_distribution.platform_media.domain_name}"
}

output "ecs_security_group_id" {
  description = "ECS tasks security group ID"
  value       = aws_security_group.ecs_tasks.id
}

output "staging_pms_task_definition" {
  description = "Terraform-owned staging PMS task definition ARN, when enabled"
  value       = try(aws_ecs_task_definition.services["staging-pms-backend"].arn, null)
}
