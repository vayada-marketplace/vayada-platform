# Storage is staged independently of forwarding. Existing tasks remain blocked.
variable "enable_hotel_setup_logo_storage" {
  type    = bool
  default = false
}

variable "hotel_setup_logo_private_admission" {
  type    = string
  default = "blocked"
  validation {
    condition     = contains(["blocked", "enabled"], var.hotel_setup_logo_private_admission)
    error_message = "Logo admission must be explicitly blocked or enabled."
  }
}
locals {
  hotel_setup_logo_image_inventory = jsondecode(file("${path.module}/../deployment/hotel-setup-logo-images.json"))
}

resource "aws_iam_role_policy" "hotel_setup_logo_media" {
  count = var.enable_hotel_setup_logo_storage ? 1 : 0
  name  = "hotel-setup-logo-exact-media-object-access"
  role  = try(aws_iam_role.hotel_setup_property_task[0].id, "")
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = [
        "${aws_s3_bucket.private_profile_media.arn}/staging/*",
        "${aws_s3_bucket.private_profile_media.arn}/private/media/*",
        "${aws_s3_bucket.private_profile_media.arn}/public/media/*",
      ]
    }]
  })
  lifecycle {
    precondition {
      condition     = var.enable_hotel_setup_property_credentials
      error_message = "Logo storage requires the isolated private property task identity."
    }
  }
}
