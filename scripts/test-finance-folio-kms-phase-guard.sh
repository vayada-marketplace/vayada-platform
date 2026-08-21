#!/usr/bin/env bash
set -euo pipefail

fixtures="scripts/fixtures/finance-folio-kms"
wrapper="scripts/guard-finance-folio-kms-plan.sh"
terraform() { jq "${MOCK_FILTER:-.}" "$3"; }
export -f terraform
accept() { local output; output="$(MOCK_FILTER="$4" bash "${wrapper}" "${fixtures}/$1.json" "$2")"; [[ "${output##*$'\n'}" == "$3" ]] || { echo "Wrong phase for $5." >&2; exit 1; }; }
reject() { jq "$4" "${fixtures}/$1.json" >/dev/null || { echo "Invalid hosted regression for $3." >&2; exit 1; }; if MOCK_FILTER="$4" bash "${wrapper}" "${fixtures}/$1.json" "$2" >/dev/null 2>&1; then echo "Hosted guard accepted $3." >&2; exit 1; fi; }
task_change='(.resource_changes[]|select(.name=="services").change.actions)=["create","delete"]'

accept diagnostic plan finance-diagnostic . "pre-import PR plan"
reject diagnostic apply "pre-import production apply" .
accept post-import plan finance-post-import . "post-import PR plan"
accept post-import apply finance-post-import . "post-import production apply"
accept steady plan finance-steady . "steady PR no-op"
accept steady apply finance-steady . "steady production no-op"
accept steady plan finance-steady '.resource_changes += [{address:"aws_s3_bucket.ordinary",type:"aws_s3_bucket",name:"ordinary",change:{actions:["update"]}}]' "ordinary unrelated plan"
accept steady apply finance-steady "${task_change}" "ordinary next-api replacement"
reject steady apply "steady environment mismatch" "${task_change} | (.resource_changes[]|select(.name==\"services\").change.after.container_definitions)|=(fromjson | (.[0].environment[]|select(.name==\"FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN\").value)=\"arn:aws:kms:eu-west-1:269416271598:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\" | tojson)"
reject steady apply "disabled no-op key" '(.resource_changes[]|select(.type=="aws_kms_key").change.after.is_enabled)=false | (.resource_changes[]|select(.type=="aws_kms_key").change.before)=(.resource_changes[]|select(.type=="aws_kms_key").change.after)'
reject steady apply "weak no-op key policy" '(.resource_changes[]|select(.type=="aws_kms_key").change.after.policy)|=(fromjson|del(.Statement[]|select(.Sid=="DenyGrantCreation"))|tojson) | (.resource_changes[]|select(.type=="aws_kms_key").change.before)=(.resource_changes[]|select(.type=="aws_kms_key").change.after)'
reject steady apply "missing no-op key tags" 'del(.resource_changes[]|select(.type=="aws_kms_key").change.after.tags.Purpose) | (.resource_changes[]|select(.type=="aws_kms_key").change.before)=(.resource_changes[]|select(.type=="aws_kms_key").change.after)'
reject steady apply "wrong no-op alias name" '(.resource_changes[]|select(.type=="aws_kms_alias").change.after.name)="alias/vayada/prod/wrong" | (.resource_changes[]|select(.type=="aws_kms_alias").change.before)=(.resource_changes[]|select(.type=="aws_kms_alias").change.after)'
reject steady apply "alias retarget" '(.resource_changes[]|select(.type=="aws_kms_alias").change.actions)=["update"]'
reject steady plan "ambiguous v2 state" '.resource_changes += [(.resource_changes[]|select(.type=="aws_kms_key") | .index="v2")]'
reject steady plan "partial alias state" '(.resource_changes[]|select(.type=="aws_kms_alias").change.actions)=["create"]'
reject steady plan "unknown managed key identity" '(.resource_changes[]|select(.type=="aws_kms_key").change.after_unknown.id)=true'

grep -Fq 'guard-finance-folio-kms-plan.sh tfplan plan' .github/workflows/tf-plan.yml
grep -Fq 'guard-finance-folio-kms-plan.sh tfplan apply' .github/workflows/tf-apply.yml
echo "hosted pre-import, post-import, steady, and ordinary plan phases passed"
