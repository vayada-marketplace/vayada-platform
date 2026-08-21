#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:?usage: assert-terraform-protected-resources.sh <tfplan> <finance-diagnostic|apply>}"
mode="${2:?usage: assert-terraform-protected-resources.sh <tfplan> <finance-diagnostic|apply>}"
plan_json="$(terraform show -json "${plan_file}")"
plan_changes="$(jq -c '[.resource_changes[]? | select(.change.actions != ["no-op"]) | {address, actions: .change.actions}] | sort_by(.address)' <<<"${plan_json}")"
finance_changes="$(jq -c '[.resource_changes[]? | select(.change.actions != ["no-op"]) | select(.address == "aws_ecs_task_definition.finance_folio_recipient_inventory" or .address == "aws_ecs_task_definition.services[\"next-target-backend\"]" or .address == "aws_iam_role_policy.next_api_finance_folio_recipient_kms" or .address == "aws_kms_alias.finance_folio_recipient_current" or (.type == "aws_kms_key" and .name == "finance_folio_recipient")) | {address, actions: .change.actions}] | sort_by(.address)' <<<"${plan_json}")"

case "${mode}" in
  finance-diagnostic)
    expected='[{"address":"aws_ecs_task_definition.finance_folio_recipient_inventory","actions":["create"]},{"address":"aws_ecs_task_definition.services[\"next-target-backend\"]","actions":["create","delete"]},{"address":"aws_iam_role_policy.next_api_finance_folio_recipient_kms","actions":["create"]},{"address":"aws_kms_alias.finance_folio_recipient_current","actions":["create"]},{"address":"aws_kms_key.finance_folio_recipient[\"v1\"]","actions":["create"]}]'
    [[ "${plan_changes}" == "${expected}" ]] || { echo "::error::Finance diagnostic must contain only the reviewed 5-add/1-destroy set." >&2; exit 1; }
    ;;
  apply)
    [[ "${finance_changes}" == '[]' ]] || { echo "::error::Finance KMS apply remains paused until its exact key and alias are imported." >&2; exit 1; }
    ;;
  *) echo "Unknown plan guard mode: ${mode}" >&2; exit 2 ;;
esac

protected_deletes="$(
  jq -r '
    [
      "aws_sesv2_configuration_set.transactional",
      "aws_cloudwatch_log_group.ses_events"
    ] as $protected
    | .resource_changes[]?
    | select(
        (.address as $address | $protected | index($address))
        or (.type == "aws_kms_key" and .name == "finance_folio_recipient")
        or (.type == "aws_kms_alias" and .name == "finance_folio_recipient_current")
      )
    | select(.change.actions | index("delete"))
    | .address
  ' <<<"${plan_json}" | sort -u
)"

if [[ -n "${protected_deletes}" ]]; then
  echo "::error::Terraform plan deletes protected production infrastructure:"
  echo "${protected_deletes}"
  echo "Follow the resource-specific decommission runbook before removing protected resources from Terraform state."
  exit 1
fi
