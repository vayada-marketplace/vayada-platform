locals {
  ecr_repos = [
    "vayada-booking-backend",
    "vayada-booking-frontend",
    "vayada-booking-admin-frontend",
    "vayada-pms-backend",
    "vayada-pms-frontend",
    "vayada-creator-marketplace-backend",
    "vayada-admin-frontend",
    "vayada-affiliate-dashboard",
    "vayada-api",
    "vayada-next-api",
    "vayada-next-booking-frontend",
    "vayada-next-booking-admin-frontend",
    "vayada-next-pms-frontend",
    "vayada-next-admin-frontend",
    "vayada-next-marketplace-frontend",
    "vayada-next-affiliate-dashboard",
  ]
}

resource "aws_ecr_repository" "repos" {
  for_each = toset(local.ecr_repos)

  name                 = each.value
  image_tag_mutability = "MUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "repos" {
  for_each = aws_ecr_repository.repos

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged build artifacts after 7 days; tagged release images are retained"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
