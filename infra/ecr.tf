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

locals {
  ecr_untagged_expiry_rule = {
    rulePriority = 3
    description  = "Expire untagged build artifacts after 7 days"
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

  # Next-stack repositories push one release image per main commit. Keep the newest
  # 300 tagged images (several weeks of releases) and expire older ones. An image
  # tagged keep-<first 12 hex of its digest> (pinned, serving or rollback images)
  # and the mutable next-latest image are matched by the higher-priority rules and
  # so are never expired by the count rule.
  ecr_next_release_retention = 300

  ecr_next_lifecycle_rules = [
    {
      rulePriority = 1
      description  = "Never expire images explicitly tagged keep-"
      selection = {
        tagStatus     = "tagged"
        tagPrefixList = ["keep-"]
        countType     = "sinceImagePushed"
        countUnit     = "days"
        countNumber   = 36500
      }
      action = {
        type = "expire"
      }
    },
    {
      rulePriority = 2
      description  = "Never expire the image behind the mutable next-latest tag"
      selection = {
        tagStatus      = "tagged"
        tagPatternList = ["next-latest"]
        countType      = "sinceImagePushed"
        countUnit      = "days"
        countNumber    = 36500
      }
      action = {
        type = "expire"
      }
    },
    local.ecr_untagged_expiry_rule,
    {
      rulePriority = 4
      description  = "Keep the newest ${local.ecr_next_release_retention} tagged release images"
      selection = {
        tagStatus      = "tagged"
        tagPatternList = ["*"]
        countType      = "imageCountMoreThan"
        countNumber    = local.ecr_next_release_retention
      }
      action = {
        type = "expire"
      }
    },
  ]

  # Legacy repositories keep every tagged image until VAY-1363 retires them.
  ecr_legacy_lifecycle_rules = [
    merge(local.ecr_untagged_expiry_rule, {
      rulePriority = 1
      description  = "Expire untagged build artifacts after 7 days; tagged release images are retained"
    }),
  ]
}

resource "aws_ecr_lifecycle_policy" "repos" {
  for_each = aws_ecr_repository.repos

  repository = each.value.name

  policy = jsonencode({
    rules = startswith(each.key, "vayada-next-") ? local.ecr_next_lifecycle_rules : local.ecr_legacy_lifecycle_rules
  })
}
