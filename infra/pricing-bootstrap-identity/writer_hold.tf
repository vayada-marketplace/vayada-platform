# Preparation only. These candidates are not complete writer/admission evidence.
variable "pricing_writer_hold_targets" {
  description = "Separately reviewed explicit hold targets; empty provisions nothing. Not activation approval."
  type        = set(string)
  default     = []
  validation {
    condition = alltrue([for name in var.pricing_writer_hold_targets : contains([
      "vayada-github-actions-platform-deploy", "vayada-github-actions-coordinated-deploy",
      "vayada-github-actions-deploy", "vayada-github-actions-finance-export"
    ], name)])
    error_message = "Only explicitly reviewed deployment-role candidates may be selected; extend the reviewed inventory before adding other targets."
  }
}

locals {
  # Read-only observation on 2026-10-03; reverify full composition before admission.
  pricing_writer_role_ids = {
    vayada-github-actions-platform-deploy    = "AROAT5OTWB3XLPYHBY43Y"
    vayada-github-actions-coordinated-deploy = "AROAT5OTWB3XD5SXH5GJW"
    vayada-github-actions-deploy             = "AROAT5OTWB3XPZT47OHGB"
    vayada-github-actions-finance-export     = "AROAT5OTWB3XMKMLBCNMM"
  }
}

data "aws_iam_role" "pricing_writer_hold" {
  for_each = var.pricing_writer_hold_targets
  name     = each.value
}

resource "aws_iam_policy" "pricing_writer_hold" {
  count  = length(var.pricing_writer_hold_targets) == 0 ? 0 : 1
  name   = "vayada-pricing-writer-hold"
  policy = file("${path.module}/../../deployment/pricing-writer-hold.json")
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = alltrue([for name, role in data.aws_iam_role.pricing_writer_hold :
        role.unique_id == lookup(local.pricing_writer_role_ids, name, "") &&
        role.arn == "arn:aws:iam::269416271598:role/${name}"
      ])
      error_message = "Actual writer role identity must match the reviewed account, ARN and stable RoleId."
    }
  }
}

resource "aws_iam_role_policy_attachment" "pricing_writer_hold" {
  for_each   = var.pricing_writer_hold_targets
  role       = data.aws_iam_role.pricing_writer_hold[each.value].name
  policy_arn = aws_iam_policy.pricing_writer_hold[0].arn
  lifecycle { prevent_destroy = true }
}
