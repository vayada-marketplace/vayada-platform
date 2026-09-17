resource "aws_ecs_cluster" "target_database_runtime_preflight" {
  name = "vayada-target-database-runtime-preflight"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Environment = "production"
    Project     = "vayada"
    Purpose     = "target-database-runtime-preflight"
  }
}
