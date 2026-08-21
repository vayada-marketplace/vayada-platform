#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:?usage: guard-finance-folio-kms-plan.sh <tfplan> <plan|apply>}"
lane="${2:?usage: guard-finance-folio-kms-plan.sh <tfplan> <plan|apply>}"
[[ "${lane}" == plan || "${lane}" == apply ]] || { echo "Unknown hosted lane: ${lane}" >&2; exit 2; }
plan_json="$(terraform show -json "${plan_file}")"
phase="$(jq -er '
  def key_id: test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
  [.resource_changes[]? | select(.type=="aws_kms_key" and .name=="finance_folio_recipient")] as $keys |
  [.resource_changes[]? | select(.type=="aws_kms_alias" and .name=="finance_folio_recipient_current")] as $aliases |
  ($keys[0].change.before.id//"") as $id |
  (($id|key_id) and $keys[0].change.after.id==$id and $keys[0].change.after.arn==("arn:aws:kms:eu-west-1:269416271598:key/"+$id) and $aliases[0].change.before.target_key_id==$id and $aliases[0].change.after.target_key_id==$id and (([$keys[0].change.after_unknown,$aliases[0].change.after_unknown]|[..|select(.==true)]|length)==0)) as $managed |
  if ($keys|length)!=1 or ($aliases|length)!=1 or $keys[0].index!="v1" then error("ambiguous Finance KMS state")
  elif $keys[0].change.actions==["create"] and $aliases[0].change.actions==["create"] and $keys[0].change.before==null and $aliases[0].change.before==null then "finance-diagnostic"
  elif $managed and $keys[0].change.actions==["update"] and $aliases[0].change.actions==["no-op"] then "finance-post-import"
  elif $managed and $keys[0].change.actions==["no-op"] and $aliases[0].change.actions==["no-op"] then "finance-steady"
  else error("unsupported Finance KMS phase") end
' <<<"${plan_json}")" || { echo "Cannot prove a unique Finance KMS plan phase." >&2; exit 1; }
[[ "${lane}" != apply || "${phase}" != finance-diagnostic ]] || { echo "Production apply cannot create Finance KMS resources; run the reviewed bootstrap/import lane." >&2; exit 1; }
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/assert-terraform-protected-resources.sh" "${plan_file}" "${phase}" v1
printf '%s\n' "${phase}"
