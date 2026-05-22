output "ecr_repository_urls" {
  description = "ECR repository URLs for CI/CD"
  value = {
    for name, repo in aws_ecr_repository.repos : name => repo.repository_url
  }
}

output "service_urls" {
  description = "Service URLs for verification"
  value = {
    booking_api      = "https://booking-api.vayada.com"
    booking_frontend = "https://<slug>.booking.vayada.com"
    booking_admin    = "https://admin.booking.vayada.com"
    pms_api          = "https://pms-api.vayada.com"
    pms_frontend     = "https://pms.vayada.com"
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

output "ecs_security_group_id" {
  description = "ECS tasks security group ID"
  value       = aws_security_group.ecs_tasks.id
}
