#!/usr/bin/env bash
set -euo pipefail

plan_file="${1:?usage: assert-terraform-protected-resources.sh <tfplan> <finance-diagnostic|finance-post-import|apply> [version]}"
mode="${2:?usage: assert-terraform-protected-resources.sh <tfplan> <finance-diagnostic|finance-post-import|apply> [version]}"
version="${3:-v1}"
plan_json="$(terraform show -json "${plan_file}")"
fail() { echo "::error::$*" >&2; exit 1; }
changes="$(jq -c '[.resource_changes[]? | select(.change.actions != ["no-op"]) | {type,name,index:(.index//null),actions:.change.actions}] | sort_by([.type,.name,(.index|tostring)])' <<<"${plan_json}")"
finance_changes="$(jq -c '[.resource_changes[]? | select(.change.actions != ["no-op"]) | select((.type=="aws_kms_key" and .name=="finance_folio_recipient") or (.type=="aws_kms_alias" and .name=="finance_folio_recipient_current") or (.type=="aws_iam_role_policy" and .name=="next_api_finance_folio_recipient_kms") or (.type=="aws_ecs_task_definition" and .name=="finance_folio_recipient_inventory")) | {type,name,index:(.index//null),actions:.change.actions}]' <<<"${plan_json}")"
finance_task_drift="$(jq -r '
  def contract: (.container_definitions//"[]" | fromjson | map({name,finance:([.environment[]?|select(.name|startswith("FINANCE_FOLIO_RECIPIENT_KMS_"))]|sort_by(.name))}) | sort_by(.name));
  def valid: . as $c | ([$c[]|select(.name=="vayada-next-api")]|length)==1 and ([$c[]|.finance[].name]|sort)==["FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS","FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN"] and all($c[];.name=="vayada-next-api" or (.finance|length)==0);
  any(.resource_changes[]?; .type=="aws_ecs_task_definition" and .name=="services" and .index=="next-target-backend" and .change.actions != ["no-op"] and (((.change.after_unknown//{})|[.container_definitions,.task_role_arn]|[..|select(.==true)]|length)>0 or .change.after.task_role_arn!="arn:aws:iam::269416271598:role/vayada-next-api-media-task-role" or ((.change.before|contract) != (.change.after|contract)) or ((.change.after|contract|valid)|not)))
' <<<"${plan_json}")"
diagnostic="$(jq -cn --arg v "${version}" '[
  {type:"aws_ecs_task_definition",name:"finance_folio_recipient_inventory",index:null,actions:["create"]},
  {type:"aws_ecs_task_definition",name:"services",index:"next-target-backend",actions:["create","delete"]},
  {type:"aws_iam_role_policy",name:"next_api_finance_folio_recipient_kms",index:null,actions:["create"]},
  {type:"aws_kms_alias",name:"finance_folio_recipient_current",index:null,actions:["create"]},
  {type:"aws_kms_key",name:"finance_folio_recipient",index:$v,actions:["create"]}
] | sort_by([.type,.name,(.index|tostring)])')"
post_import="$(jq -cn --arg v "${version}" '[
  {type:"aws_ecs_task_definition",name:"finance_folio_recipient_inventory",index:null,actions:["create"]},
  {type:"aws_ecs_task_definition",name:"services",index:"next-target-backend",actions:["create","delete"]},
  {type:"aws_iam_role_policy",name:"next_api_finance_folio_recipient_kms",index:null,actions:["create"]},
  {type:"aws_kms_key",name:"finance_folio_recipient",index:$v,actions:["update"]}
] | sort_by([.type,.name,(.index|tostring)])')"

case "${mode}" in
  finance-diagnostic)
    [[ "${changes}" == "${diagnostic}" ]] || fail "Finance diagnostic differs from the reviewed 5-add/1-destroy set."
    ;;
  finance-post-import)
    [[ "${version}" == v1 && "${changes}" == "${post_import}" ]] || fail "Post-import apply differs from the reviewed v1 rollout."
    jq -e --arg version "${version}" '
      def key: .type=="aws_kms_key" and .name=="finance_folio_recipient";
      def alias: .type=="aws_kms_alias" and .name=="finance_folio_recipient_current";
      def selected($type;$name;$index): [.resource_changes[] | select(.type==$type and .name==$name and (($index==null) or .index==$index))];
      def as_set: (if type=="array" then . else [.] end)|sort;
      def norm_policy: .Statement |= (map(.Action|=as_set | .Resource|=as_set | if ((.Principal?|type)=="object" and .Principal.AWS?) then .Principal.AWS|=as_set else . end | if has("Condition") then .Condition|=with_entries(.value|=with_entries(.value|=as_set)) else . end)|sort_by(.Sid));
      def known($change;$fields): ($change.after_unknown//{}) as $u | ([$fields[] as $f | [$u[$f] | .. | select(.==true)] | length] | add//0)==0;
      def norm_containers: fromjson | map(.environment=((.environment//[])|sort_by(.name)) | .secrets=((.secrets//[])|sort_by(.name))) | sort_by(.name);
      def strip_finance_env: .container_definitions |= (norm_containers | map(if .name=="vayada-next-api" then .environment|=map(select(.name|startswith("FINANCE_FOLIO_RECIPIENT_KMS_")|not)) else . end));
      def stable_task: del(.arn,.arn_without_revision,.id,.revision,.tags_all) | strip_finance_env;
      [.resource_changes[] | select(key)] as $keys |
      [.resource_changes[] | select(alias)] as $aliases |
      selected("aws_ecs_task_definition";"finance_folio_recipient_inventory";null) as $inventories |
      selected("aws_ecs_task_definition";"services";"next-target-backend") as $tasks |
      selected("aws_iam_role_policy";"next_api_finance_folio_recipient_kms";null) as $policies |
      [$keys[] | select(.change.actions==["update"])] as $changed_keys |
      ($changed_keys[0]) as $key | ($aliases[0]) as $alias | ($inventories[0]) as $inventory | ($tasks[0]) as $task | ($policies[0]) as $task_policy_resource |
      ($keys | map(.change.before.arn // .change.after.arn) | sort) as $key_arns |
      ($alias.change.before.target_key_id) as $current_id |
      [$keys[] | select((.change.before.id // .change.after.id)==$current_id)] as $current_keys |
      ($current_keys[0].change.before.arn // $current_keys[0].change.after.arn) as $current_arn |
      "arn:aws:iam::269416271598:role/vayada-next-api-media-task-role" as $role |
      {Version:"2012-10-17",Statement:[
        {Sid:"EnableAccountAdministration",Effect:"Allow",Principal:{AWS:"arn:aws:iam::269416271598:root"},Action:"kms:*",Resource:"*"},
        {Sid:"DenyCryptographicUseOutsideNextApi",Effect:"Deny",Principal:"*",Action:["kms:Decrypt","kms:Encrypt","kms:GenerateDataKey","kms:GenerateDataKeyWithoutPlaintext","kms:ReEncryptFrom","kms:ReEncryptTo"],Resource:"*",Condition:{ArnNotEquals:{"aws:PrincipalArn":$role}}},
        {Sid:"DenyGrantCreation",Effect:"Deny",Principal:"*",Action:"kms:CreateGrant",Resource:"*"}
      ]} as $expected_key_policy |
      {StringEquals:{"kms:EncryptionAlgorithm":"SYMMETRIC_DEFAULT","kms:EncryptionContext:purpose":"finance-folio-recipient-v1"},StringLike:{"kms:EncryptionContext:propertyId":"????????-????-????-????-????????????","kms:EncryptionContext:folioId":"????????-????-????-????-????????????","kms:EncryptionContext:revision":"?*"},StringNotLike:{"kms:EncryptionContext:revision":["0","-*"]},"ForAllValues:StringEquals":{"kms:EncryptionContextKeys":["purpose","propertyId","folioId","revision"]}} as $context |
      {Version:"2012-10-17",Statement:[
        {Sid:"EncryptCurrentFinanceFolioRecipientKey",Effect:"Allow",Action:["kms:Encrypt"],Resource:$current_arn,Condition:$context},
        {Sid:"DecryptAllowedFinanceFolioRecipientKeys",Effect:"Allow",Action:["kms:Decrypt"],Resource:$key_arns,Condition:$context},
        {Sid:"DescribeAllowedFinanceFolioRecipientKeys",Effect:"Allow",Action:["kms:DescribeKey"],Resource:$key_arns}
      ]} as $expected_task_policy |
      ($task.change.after.container_definitions | fromjson | [.[] | select(.name=="vayada-next-api")]) as $containers |
      ($containers[0].environment) as $env |
      ($inventory.change.after.container_definitions | fromjson) as $inventory_containers |
      {container_definitions:$inventory.change.after.container_definitions,cpu:"256",enable_fault_injection:false,ephemeral_storage:[],execution_role_arn:"arn:aws:iam::269416271598:role/ecsTaskExecutionRole",family:"vayada-next-api-finance-folio-recipient-inventory",inference_accelerator:[],ipc_mode:null,memory:"512",network_mode:"awsvpc",pid_mode:null,placement_constraints:[],proxy_configuration:[],requires_compatibilities:["FARGATE"],runtime_platform:[],skip_destroy:false,tags:{Environment:"production",Project:"vayada",Purpose:"finance-folio-recipient-inventory"},tags_all:{Environment:"production",Project:"vayada",Purpose:"finance-folio-recipient-inventory"},task_role_arn:null,track_latest:false,volume:[]} as $expected_inventory |
      ($keys|length)==1 and ($keys|map(.index)|unique|length)==1 and ($changed_keys|length)==1 and $key.index==$version and ($current_id|test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")) and $current_arn==("arn:aws:kms:eu-west-1:269416271598:key/"+$current_id) and
      ($aliases|length)==1 and known($alias.change;["target_key_id"]) and $alias.change.actions==["no-op"] and $alias.change.before.target_key_id==$alias.change.after.target_key_id and ($current_keys|length)==1 and
      ($inventories|length)==1 and ($tasks|length)==1 and ($policies|length)==1 and
      known($key.change;["arn","bypass_policy_lockout_safety_check","custom_key_store_id","customer_master_key_spec","deletion_window_in_days","description","enable_key_rotation","id","is_enabled","key_id","key_usage","multi_region","policy","rotation_period_in_days","tags","tags_all","timeouts","xks_key_id"]) and (($key.change.after_unknown//{})|[..|select(.==true)]|length)==0 and
      ($key.change.after|keys)==["arn","bypass_policy_lockout_safety_check","custom_key_store_id","customer_master_key_spec","deletion_window_in_days","description","enable_key_rotation","id","is_enabled","key_id","key_usage","multi_region","policy","rotation_period_in_days","tags","tags_all","timeouts","xks_key_id"] and
      $key.change.after.arn==$current_arn and $key.change.after.id==$current_id and $key.change.after.key_id==$current_id and ($key.change.after.description|startswith("Finance folio recipient "+$version+"; bootstrap=")) and $key.change.after.bypass_policy_lockout_safety_check==false and $key.change.after.custom_key_store_id==null and $key.change.after.customer_master_key_spec=="SYMMETRIC_DEFAULT" and $key.change.after.deletion_window_in_days==30 and $key.change.after.enable_key_rotation==true and $key.change.after.rotation_period_in_days==365 and $key.change.after.is_enabled==true and $key.change.after.key_usage=="ENCRYPT_DECRYPT" and $key.change.after.multi_region==false and $key.change.after.xks_key_id==null and $key.change.after.timeouts==null and
      $key.change.after.tags=={Environment:"production",ManagedBy:"terraform",Name:("vayada-finance-folio-recipient-"+$version),Project:"vayada",Purpose:"finance-folio-recipient",Version:$version} and $key.change.after.tags_all==$key.change.after.tags and
      (($key.change.after.policy|fromjson|norm_policy)==($expected_key_policy|norm_policy)) and
      known($task_policy_resource.change;["name","policy","role"]) and $task_policy_resource.change.after.name=="finance-folio-recipient-kms-access" and $task_policy_resource.change.after.role=="vayada-next-api-media-task-role" and (($task_policy_resource.change.after.policy|fromjson|norm_policy)==($expected_task_policy|norm_policy)) and
      (($task.change.after_unknown//{})|del(.arn,.arn_without_revision,.id,.revision,.tags_all)|[..|select(.==true)]|length)==0 and ($task.change.before|stable_task)==($task.change.after|stable_task) and $task.change.after.task_role_arn==$role and ($containers|length)==1 and
      ([$task.change.before.container_definitions|fromjson|.[]|.environment[]?|select(.name|startswith("FINANCE_FOLIO_RECIPIENT_KMS_"))]|length)==0 and ([$env[]|select(.name|startswith("FINANCE_FOLIO_RECIPIENT_KMS_"))]|length)==2 and
      ([$task.change.after.container_definitions|fromjson|.[]|select(.name!="vayada-next-api")|.environment[]?|select(.name|startswith("FINANCE_FOLIO_RECIPIENT_KMS_"))]|length)==0 and
      ([$env[]|select(.name=="FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN")]==[{name:"FINANCE_FOLIO_RECIPIENT_KMS_CURRENT_KEY_ARN",value:$current_arn}]) and
      ([$env[]|select(.name=="FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS")]==[{name:"FINANCE_FOLIO_RECIPIENT_KMS_ALLOWED_KEY_ARNS",value:($key_arns|join(","))}]) and
      (($inventory.change.after_unknown//{})|del(.arn,.arn_without_revision,.id,.revision)|[..|select(.==true)]|length)==0 and ($inventory.change.after|del(.arn,.arn_without_revision,.id,.revision))==$expected_inventory and
      $inventory_containers==[{command:["node","-e","console.log(JSON.stringify({status:\u0027INERT\u0027,message:\u0027use scripts/run-finance-folio-recipient-inventory.sh\u0027}))"],essential:true,image:"269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api:next-latest",logConfiguration:{logDriver:"awslogs",options:{"awslogs-group":"/ecs/vayada-next-api","awslogs-region":"eu-west-1","awslogs-stream-prefix":"folio-recipient-inventory"}},name:"vayada-next-api-finance-folio-recipient-inventory",secrets:[{name:"TARGET_DATABASE_URL",valueFrom:"arn:aws:ssm:eu-west-1:269416271598:parameter/vayada/prod/target-database-url"}]}]
    ' <<<"${plan_json}" >/dev/null || fail "Post-import KMS, policy, task, or inventory contract mismatch."
    ;;
  apply)
    [[ "${finance_changes}" == "[]" && "${finance_task_drift}" == false ]] || fail "Finance KMS apply requires the reviewed post-import lane or a Finance no-op."
    ;;
  *) fail "Unknown plan guard mode: ${mode}" ;;
esac

protected_deletes="$(jq -r '["aws_sesv2_configuration_set.transactional","aws_cloudwatch_log_group.ses_events"] as $protected | .resource_changes[]? | select((.address as $a | $protected | index($a)) or (.type=="aws_kms_key" and .name=="finance_folio_recipient") or (.type=="aws_kms_alias" and .name=="finance_folio_recipient_current")) | select(.change.actions | index("delete")) | .address' <<<"${plan_json}" | sort -u)"
[[ -z "${protected_deletes}" ]] || fail "Terraform plan deletes protected production infrastructure: ${protected_deletes}"
