locals {
  ses_email_event_types = [
    "SEND",
    "REJECT",
    "BOUNCE",
    "COMPLAINT",
    "DELIVERY",
    "RENDERING_FAILURE",
    "DELIVERY_DELAY",
  ]
}

resource "aws_sesv2_configuration_set" "transactional" {
  configuration_set_name = "vayada-transactional"

  lifecycle {
    prevent_destroy = true
  }
}

data "aws_cloudwatch_event_bus" "default" {
  name = "default"
}

resource "aws_sesv2_configuration_set_event_destination" "transactional_events" {
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name
  event_destination_name = "eventbridge"

  event_destination {
    event_bridge_destination {
      event_bus_arn = data.aws_cloudwatch_event_bus.default.arn
    }

    enabled              = true
    matching_event_types = local.ses_email_event_types
  }
}

resource "aws_cloudwatch_log_group" "ses_events" {
  name              = "/aws/events/vayada-ses-events"
  retention_in_days = 30

  tags = {
    Service = "ses"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_resource_policy" "ses_events" {
  policy_name = "vayada-ses-events"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "EventBridgeToCloudWatchLogs"
      Effect = "Allow"
      Principal = {
        Service = [
          "events.amazonaws.com",
          "delivery.logs.amazonaws.com",
        ]
      }
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = "${aws_cloudwatch_log_group.ses_events.arn}:*"
    }]
  })
}

resource "aws_cloudwatch_event_rule" "ses_events" {
  name        = "vayada-ses-events"
  description = "Persist Vayada transactional email delivery events"
  event_pattern = jsonencode({
    source = ["aws.ses"]
    detail-type = [
      "Email Sent",
      "Email Rejected",
      "Email Bounced",
      "Email Complaint Received",
      "Email Delivered",
      "Email Rendering Failed",
      "Email Delivery Delayed",
    ]
  })
}

resource "aws_cloudwatch_event_target" "ses_events" {
  rule = aws_cloudwatch_event_rule.ses_events.name
  arn  = aws_cloudwatch_log_group.ses_events.arn

  depends_on = [aws_cloudwatch_log_resource_policy.ses_events]
}
