#!/usr/bin/env bash
set -euo pipefail
kms="infra/finance_folio_kms.tf" steady="docs/finance-folio-kms-steady-state-policy.template.json"
test -x scripts/run-finance-folio-recipient-inventory.sh
grep -Fq 'finance_folio_recipient_kms_context_keys        = ["purpose", "propertyId", "folioId", "revision"]' "$kms"
grep -Fq 'rotation_period_in_days  = 365' "$kms"
for condition in 'EncryptionContext:propertyId" = "????????-????-????-????-????????????' 'EncryptionContext:folioId"    = "????????-????-????-????-????????????' 'EncryptionContext:revision"   = "?*"' 'StringNotLike' '["0", "-*"]'; do grep -Fq "$condition" "$kms"; done
if grep -Eq 'EncryptionContext:(property_id|folio_id)' "$kms"; then
  echo "snake-case Finance folio KMS context key accepted" >&2
  exit 1
fi
task_policy="$(sed -n '/resource "aws_iam_role_policy" "next_api_finance_folio_recipient_kms"/,$p' "$kms")"
for forbidden in GenerateDataKey ReEncrypt CreateGrant 'kms:*'; do
  if grep -Fq "$forbidden" <<<"$task_policy"; then
    echo "task policy accepted forbidden $forbidden permission" >&2
    exit 1
  fi
done
jq --arg exact "arn:aws:kms:eu-west-1:269416271598:key/00000000-0000-0000-0000-000000000000" -e '
  all(.Statement[]; ([.Resource] | flatten | map(select(type == "string" and startswith("arn:aws:kms:eu-west-1:269416271598:key/"))) | all(. == $exact)))
  and all(.Statement[]; if .Effect == "Allow" and ([.Action] | flatten | any(. != "kms:ListAliases" and . != "kms:UpdateAlias")) then .Resource == $exact else true end)
  and all(.Statement[]; ([.Action] | flatten | index("kms:CreateKey") | not))
  and any(.Statement[]; .Sid == "ManageExactFinanceFolioRecipientKey" and .Resource == $exact)
' "$steady" >/dev/null
