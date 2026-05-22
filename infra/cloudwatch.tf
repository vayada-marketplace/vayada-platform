locals {
  log_groups = [
    "/ecs/vayada-booking-backend",
    "/ecs/vayada-booking-frontend",
    "/ecs/vayada-booking-admin",
    "/ecs/vayada-pms-backend",
    "/ecs/vayada-pms-frontend",
    "/ecs/vayada-marketplace-backend",
    "/ecs/vayada-marketplace-admin",
    "/ecs/vayada-affiliate-dashboard",
  ]
}

resource "aws_cloudwatch_log_group" "ecs" {
  for_each = toset(local.log_groups)

  name              = each.value
  retention_in_days = 30

  tags = {
    Service = each.value
  }
}
