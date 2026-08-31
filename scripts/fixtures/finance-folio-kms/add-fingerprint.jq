def replace_key_id:
  walk(if type == "string" then gsub("11111111-2222-3333-4444-555555555555"; "66666666-7777-8888-9999-000000000000") else . end);
def fingerprint_policy:
  if . == null then null
  else
    fromjson
    | (.Statement[] | select(.Sid == "DenyCryptographicUseOutsideNextApi")).Sid = "DenyMacUseOutsideNextApi"
    | (.Statement[] | select(.Sid == "DenyMacUseOutsideNextApi")).Action = ["kms:GenerateMac", "kms:VerifyMac"]
    | tojson
  end;
def fingerprint_key:
  replace_key_id
  | .address |= sub("finance_folio_recipient"; "finance_folio_recipient_fingerprint")
  | .name = "finance_folio_recipient_fingerprint"
  | (.change.before?, .change.after?) |=
      if . == null then .
      else
        .customer_master_key_spec = "HMAC_256"
        | .key_usage = "GENERATE_VERIFY_MAC"
        | .enable_key_rotation = false
        | .rotation_period_in_days = null
        | .description |= if type == "string" then sub("Finance folio recipient "; "Finance folio recipient fingerprint ") else . end
        | .policy |= fingerprint_policy
        | .tags.Name |= sub("finance-folio-recipient-"; "finance-folio-recipient-fingerprint-")
        | .tags.Purpose = "finance-folio-recipient-fingerprint"
        | .tags_all = .tags
      end;
def add_fingerprint_policy($arn):
  if . == null then null
  else
    fromjson
    | .Statement += [
        {Sid:"GenerateFinanceFolioRecipientFingerprint",Effect:"Allow",Action:["kms:GenerateMac"],Resource:$arn,Condition:{StringEquals:{"kms:MacAlgorithm":"HMAC_SHA_256"}}},
        {Sid:"DescribeFinanceFolioRecipientFingerprintKey",Effect:"Allow",Action:["kms:DescribeKey"],Resource:$arn}
      ]
    | tojson
  end;
def add_fingerprint_env($arn):
  if . == null then null
  else
    fromjson
    | map(if .name == "vayada-next-api" then .environment += [{name:"FINANCE_FOLIO_RECIPIENT_KMS_FINGERPRINT_KEY_ARN",value:$arn}] else . end)
    | tojson
  end;
"arn:aws:kms:eu-west-1:269416271598:key/66666666-7777-8888-9999-000000000000" as $fingerprint_arn
| (.resource_changes[] | select(.type == "aws_kms_key" and .name == "finance_folio_recipient")) as $recipient_key
| .resource_changes += [$recipient_key | fingerprint_key | if .change.actions == ["create"] then del(.change.after.rotation_period_in_days) | .change.after_unknown.rotation_period_in_days = true else . end]
| (.resource_changes[] | select(.type == "aws_iam_role_policy" and .name == "next_api_finance_folio_recipient_kms") | .change.after.policy) |= add_fingerprint_policy($fingerprint_arn)
| (.resource_changes[] | select(.type == "aws_iam_role_policy" and .name == "next_api_finance_folio_recipient_kms" and .change.actions == ["no-op"]) | .change.before.policy) |= add_fingerprint_policy($fingerprint_arn)
| (.resource_changes[] | select(.type == "aws_ecs_task_definition" and .name == "services" and .change.actions == ["no-op"]) | .change.before.container_definitions, .change.after.container_definitions) |= add_fingerprint_env($fingerprint_arn)
| (.resource_changes[] | select(.type == "aws_ecs_task_definition" and .name == "services" and .change.actions != ["no-op"]) | .change.after.container_definitions) |= add_fingerprint_env($fingerprint_arn)
