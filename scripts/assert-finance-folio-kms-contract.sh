#!/usr/bin/env bash
set -euo pipefail
kms="infra/finance_folio_kms.tf" steady="docs/finance-folio-kms-steady-state-policy.template.json"
grep -Fq 'finance_folio_recipient_kms_context_keys        = ["purpose", "propertyId", "folioId", "revision"]' "$kms"
for condition in 'EncryptionContext:propertyId" = "????????-????-????-????-????????????' 'EncryptionContext:folioId"    = "????????-????-????-????-????????????' 'EncryptionContext:revision"   = "?*"' 'StringNotLike' '["0", "-*"]'; do grep -Fq "$condition" "$kms"; done
! grep -Eq 'EncryptionContext:(property_id|folio_id)' "$kms"
task_policy="$(sed -n '/resource "aws_iam_role_policy" "next_api_finance_folio_recipient_kms"/,$p' "$kms")"
for forbidden in GenerateDataKey ReEncrypt CreateGrant 'kms:*'; do ! grep -Fq "$forbidden" <<<"$task_policy"; done
jq --arg exact "arn:aws:kms:eu-west-1:269416271598:key/00000000-0000-0000-0000-000000000000" -e '
  all(.Statement[]; ([.Resource] | flatten | map(select(type == "string" and startswith("arn:aws:kms:eu-west-1:269416271598:key/"))) | all(. == $exact)))
  and all(.Statement[]; if .Effect == "Allow" and ([.Action] | flatten | any(. != "kms:ListAliases" and . != "kms:UpdateAlias")) then .Resource == $exact else true end)
  and all(.Statement[]; ([.Action] | flatten | index("kms:CreateKey") | not))
  and any(.Statement[]; .Sid == "ManageExactFinanceFolioRecipientKey" and .Resource == $exact)
' "$steady" >/dev/null
terraform() { printf '%s\n' "${MOCK_PLAN}"; }
export -f terraform
pairs='[["aws_ecs_task_definition.finance_folio_recipient_inventory",["create"]],["aws_ecs_task_definition.services[\"next-target-backend\"]",["create","delete"]],["aws_iam_role_policy.next_api_finance_folio_recipient_kms",["create"]],["aws_kms_alias.finance_folio_recipient_current",["create"]],["aws_kms_key.finance_folio_recipient[\"v1\"]",["create"]]]'
base="$(jq -cn --argjson pairs "$pairs" '{resource_changes:[$pairs[]|{address:.[0],change:{actions:.[1]}}]}')"
MOCK_PLAN="$base" bash scripts/assert-terraform-protected-resources.sh mock finance-diagnostic
for action in create update delete; do
  changed="$(jq -c --arg action "$action" '.resource_changes += [{address:"aws_s3_bucket.unrelated",change:{actions:[$action]}}]' <<<"$base")"
  if MOCK_PLAN="$changed" bash scripts/assert-terraform-protected-resources.sh mock finance-diagnostic >/dev/null 2>&1; then echo "diagnostic accepted unrelated $action" >&2; exit 1; fi
done
