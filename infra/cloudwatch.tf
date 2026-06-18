locals {
  base_log_groups = [
    "/ecs/vayada-booking-backend",
    "/ecs/vayada-booking-frontend",
    "/ecs/vayada-booking-admin",
    "/ecs/vayada-pms-backend",
    "/ecs/vayada-pms-frontend",
    "/ecs/vayada-marketplace-backend",
    "/ecs/vayada-marketplace-admin",
    "/ecs/vayada-affiliate-dashboard",
    "/ecs/vayada-api",
    "/ecs/vayada-next-api",
    "/ecs/vayada-next-pms-frontend",
  ]

  staging_pms_log_groups = var.enable_staging_pms_runtime ? [
    "/ecs/vayada-staging-pms-backend",
  ] : []

  log_groups = concat(local.base_log_groups, local.staging_pms_log_groups)
}

resource "aws_cloudwatch_log_group" "ecs" {
  for_each = toset(local.log_groups)

  name              = each.value
  retention_in_days = 30

  tags = {
    Service = each.value
  }
}
