#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:?usage: assert-terraform-protected-resources.sh <tfplan>}"
plan_json="$(terraform show -json "${plan_file}")"

protected_deletes="$(
  jq -r '
    [
      "aws_sesv2_configuration_set.transactional",
      "aws_cloudwatch_log_group.ses_events"
    ] as $protected
    | .resource_changes[]?
    | select(.address as $address | $protected | index($address))
    | select(.change.actions | index("delete"))
    | .address
  ' <<<"${plan_json}" | sort -u
)"

if [[ -n "${protected_deletes}" ]]; then
  echo "::error::Terraform plan deletes protected email infrastructure:"
  echo "${protected_deletes}"
  echo "Detach the SES default configuration set and remove these resources from Terraform state before changing their declarations."
  exit 1
fi
