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
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
