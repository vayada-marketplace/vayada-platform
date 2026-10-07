#!/usr/bin/env bash
set -euo pipefail

for command_name in aws base64 gzip jq; do
  command -v "${command_name}" >/dev/null || { echo "Required command not found: ${command_name}" >&2; exit 1; }
done

region="eu-west-1"
mode="${1:-preflight}"
ca_bundle=""
ca_payload=""
grant_scope=""
ca_required=false
extra_secret_name=""
extra_secret_parameter=""
provision_scope=""
finance_property=""
export_property=""
export_id=""
export_ongoing="false"
channex_property=""
channex_image=""
task_image=""
creation_purpose=""
creation_org=""
creation_actor=""
creation_task_role=""
creation_execution_role=""
log_group="/ecs/vayada-next-api"
property_id=""
property_operation=""
logo_cleanup_kind=""
logo_cleanup_target=""
logo_cleanup_phase=""
logo_cleanup_hash=""
owner_email=""
helper_file=""
reader_rls_mode=""
reader_rls_frozen=""
legacy_helper_mode=""
legacy_helper_frozen=""
legacy_helper_scope="hotel_setup_legacy_helper_inspection"
financials_readiness_property=""
financials_readiness_image_digest=""
product_dml_required="false"
code_in_definition="false"
vay2017_source_sha=""
vay2017_execution_id=""
vay2017_phase=""
vay2017_source_import_phase=""
logo_recovery_phase=""
logo_recovery_frozen=""
logo_reader_phase=""
logo_reader_frozen=""
if [[ "$mode" == --repair-hotel-setup-logo-reader ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main &&
     "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REPOSITORY:-}" == vayada-marketplace/vayada-platform &&
     "$#" -eq 4 && "$2" =~ ^(inspect|apply|verify)$ &&
     "$4" == sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965 &&
     "${EXPECTED_TASK:-}" == arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1197 ]] || exit 2
  [[ ( "$2" == inspect && -z "$3" ) || ( "$2" == apply && "$3" =~ ^[a-f0-9]{64}$ ) ||
     ( "$2" == verify && "$3" =~ ^[1-9][0-9]{0,9}$ && "$3" -le 4294967295 ) ]] || exit 2
  logo_reader_phase="$2"; logo_reader_frozen="$3"
  # Exact new mode reuses the existing all-blocked, active-hold, physically-zero gates.
  mode=--stage-hotel-setup-logo-migration-scope
  set -- "$mode" "$4"
fi
if [[ "$mode" == --recover-hotel-setup-logo-staged-role ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main &&
     "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REPOSITORY:-}" == vayada-marketplace/vayada-platform &&
     "$#" -eq 4 && "$2" =~ ^(inspect|apply)$ && "$4" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
  [[ ( "$2" == inspect && -z "$3" ) || ( "$2" == apply && "$3" =~ ^[a-f0-9]{64}$ ) ]] || exit 2
  logo_recovery_phase="$2"; logo_recovery_frozen="$3"
  # Reuse the fixed logo parent's held-release and physically-stopped-service gates.
  mode=--stage-hotel-setup-logo-migration-scope
  set -- "$mode" "$4"
fi
profile_scope=""
if [[ "$mode" == --stage-hotel-setup-profile-migration-scope ]]; then
  [[ "$#" -eq 2 ]] || exit 2
  profile_scope=0470
  # The fixed profile parent reuses the logo parent's all-blocked, held and physically-stopped gates.
  mode=--stage-hotel-setup-logo-migration-scope
fi
case "${mode}" in
  preflight|--preflight-runtime-product-dml)
    [[ "$#" -le 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    [[ "${mode}" == "--preflight-runtime-product-dml" ]] && product_dml_required="true"
    code_file="target-database-runtime-preflight.mjs"
    code_in_definition="true"
    secret_name="TARGET_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-runtime-url"
    family="vayada-next-api-db-runtime-preflight"
    ;;
  --grant-runtime-product-dml|--revoke-runtime-product-dml)
    # VAY-2054: the one reviewed grant set for the ordinary API login, and its rollback.
    [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    ca_required=true
    code_file="grant-target-database-runtime-product-dml.mjs"
    code_in_definition="true"
    grant_scope="product_dml"
    [[ "${mode}" == "--revoke-runtime-product-dml" ]] && grant_scope="revoke_product_dml"
    secret_name="TARGET_DATABASE_MIGRATION_URL"
    secret_parameter="/vayada/prod/target-database-url"
    family="vayada-next-api-db-runtime-preflight"
    ;;
  --audit-financials-readiness)
    [[ "$#" -eq 2 && "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
      echo "Financials readiness audit requires one property UUID." >&2; exit 2;
    }
    ca_required=true
    code_file="financials-activation-readiness.mjs"
    secret_name="TARGET_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-url"
    family="vayada-next-api-db-runtime-preflight"
    financials_readiness_property="$2"
    ;;
  --grant-hotel-setup-tracks|--grant-product-audit-insert|--grant-affiliate-read|--grant-finance-affiliate-read|--grant-platform-runtime-read|--grant-property-profile-lock|--grant-domain-events-append|--grant-jobs-insert|--grant-expense-category-insert|--grant-expense-insert|--grant-recurring-expense-insert|--grant-folio-command)
    ca_required=true
    code_file="grant-target-database-product-audit-insert.mjs"
    if [[ "${mode}" == "--grant-hotel-setup-tracks" ]]; then
      code_file="grant-target-database-hotel-setup-tracks.mjs"
    elif [[ "${mode}" == "--grant-affiliate-read" ]]; then
      grant_scope="affiliate_read"
    elif [[ "${mode}" == "--grant-finance-affiliate-read" ]]; then
      grant_scope="finance_affiliate_read"
    elif [[ "${mode}" == "--grant-platform-runtime-read" ]]; then
      grant_scope="platform_runtime_read"
    elif [[ "${mode}" == "--grant-property-profile-lock" ]]; then
      grant_scope="property_profile_lock"
    elif [[ "${mode}" == "--grant-domain-events-append" ]]; then
      grant_scope="domain_events_append"
    elif [[ "${mode}" == "--grant-jobs-insert" ]]; then
      grant_scope="jobs_insert"
    elif [[ "${mode}" == "--grant-expense-category-insert" ]]; then
      grant_scope="expense_category_insert"
    elif [[ "${mode}" == "--grant-expense-insert" ]]; then
      grant_scope="expense_insert"
    elif [[ "${mode}" == "--grant-recurring-expense-insert" ]]; then
      grant_scope="recurring_expense_insert"
    elif [[ "${mode}" == "--grant-folio-command" ]]; then
      code_file="grant-target-database-folio-command.mjs"
    else
      grant_scope="audit_insert"
    fi
    [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    secret_name="TARGET_DATABASE_MIGRATION_URL"
    secret_parameter="/vayada/prod/target-database-url"
    family="vayada-next-api-db-runtime-preflight"
    ;;
  --provision-finance-expense-worker|--grant-finance-expense-worker|--preflight-finance-expense-worker)
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="finance-expense-worker-database.mjs"
    secret_name="FINANCE_EXPENSE_WORKER_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-finance-expense-worker-url"
    if [[ "${mode}" == "--provision-finance-expense-worker" ]]; then
      [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
      code_file="provision-target-database-identity-runtime.mjs"
      provision_scope="finance_expense"
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
      extra_secret_name="FINANCE_EXPENSE_WORKER_DATABASE_URL"
      extra_secret_parameter="/vayada/prod/target-database-finance-expense-worker-url"
    else
      [[ "$#" -eq 2 && "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
        echo "Finance grant/preflight requires the reviewed property UUID." >&2; exit 2;
      }
      finance_property="$2"
      if [[ "${mode}" == "--grant-finance-expense-worker" ]]; then
        grant_scope="finance_expense"
        secret_name="TARGET_DATABASE_MIGRATION_URL"
        secret_parameter="/vayada/prod/target-database-url"
      fi
    fi
    ;;
  --provision-channex-management-worker|--grant-channex-management-worker|--preflight-channex-management-worker)
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="channex-management-worker-database.mjs"
    helper_file="channex-policy-consumer-roles.mjs"
    secret_name="PMS_CHANNEX_MANAGEMENT_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-channex-management-worker-url"
    if [[ "${mode}" == "--provision-channex-management-worker" ]]; then
      [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
      code_file="provision-target-database-identity-runtime.mjs"
      provision_scope="channex_management"
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
      extra_secret_name="PMS_CHANNEX_MANAGEMENT_DATABASE_URL"
      extra_secret_parameter="/vayada/prod/target-database-channex-management-worker-url"
    else
      [[ "$#" -eq 3 && "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ && "$3" =~ ^sha256:[a-f0-9]{64}$ ]] || {
        echo "Channex grant/preflight requires the reviewed property UUID and immutable image digest." >&2; exit 2;
      }
      channex_property="$2"
      channex_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@$3"
      if [[ "${mode}" == "--grant-channex-management-worker" ]]; then
        grant_scope="channex_management"
        secret_name="TARGET_DATABASE_MIGRATION_URL"
        secret_parameter="/vayada/prod/target-database-url"
      fi
    fi
    ;;
  --preflight-vay2017-historical-bindings)
    [[ "$#" -eq 5 && "$2" =~ ^(prepare|execute|cleanup)$ && "$3" =~ ^sha256:[a-f0-9]{64}$ && "$4" =~ ^[0-9a-f]{40}$ && "$5" =~ ^[0-9]{1,20}-[0-9]{1,3}$ ]] || {
      echo "Historical binding preflight requires a phase, immutable digest, source SHA, and run-attempt ID." >&2; exit 2;
    }
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file=""
    secret_name="TARGET_DATABASE_ADMIN_URL"
    secret_parameter="/vayada/prod/db-marketplace-url"
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@$3"
    vay2017_phase="$2"
    vay2017_source_sha="$4"
    vay2017_execution_id="$5"
    if [[ "${vay2017_phase}" != "cleanup" ]]; then
      [[ "${VAY2017_PREFLIGHT_SIGNING_KEY_ID:-}" =~ ^[a-z0-9][a-z0-9._-]{2,127}$ ]] || {
        echo "Historical binding preflight requires the reviewed signing key ID." >&2; exit 2;
      }
    fi
    if [[ "${vay2017_phase}" == "execute" ]]; then
      [[ "${VAY2017_PREFLIGHT_INPUT_GZIP_BASE64:-}" =~ ^[A-Za-z0-9+/]+={0,2}$ &&
         "${VAY2017_PREFLIGHT_SIGNATURE:-}" =~ ^[A-Za-z0-9_-]{86}$ &&
         "${VAY2017_PREFLIGHT_PUBLIC_KEY_BASE64:-}" =~ ^[A-Za-z0-9+/]+={0,2}$ &&
         "${CHANNEX_ADOPTION_EXECUTION_PRINCIPAL:-}" == "github:vayada-platform:vay2017-production-preflight" ]] || {
        echo "Historical binding execute phase requires the externally signed input." >&2; exit 2;
      }
    fi
    ;;
  --import-vay2017-source-snapshot)
    [[ "$#" -eq 6 && "$2" =~ ^(prepare|extract|cleanup)$ && "$3" =~ ^sha256:[a-f0-9]{64}$ && "$4" =~ ^[0-9a-f]{40}$ && "$5" == "vay1351-61ec013e79ed2a042caadef8" && "$6" =~ ^[0-9]{1,20}-[0-9]{1,3}$ ]] || {
      echo "Source snapshot import requires a phase, immutable digest/source, pinned run ID, and run-attempt ID." >&2; exit 2;
    }
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    if [[ "$2" == "extract" ]]; then
      code_file="vay2017-source-snapshot-extract.mjs"
    else
      code_file="vay2017-source-snapshot-import.mjs"
    fi
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@$3"
    vay2017_source_import_phase="$2"
    vay2017_source_sha="$4"
    vay2017_execution_id="$6"
    extra_secret_name="VAY2017_SOURCE_READER_URL"
    extra_secret_parameter="/vayada/prod/vay2017-source-import-url"
    if [[ "$2" == "extract" ]]; then
      secret_name="TARGET_DATABASE_MIGRATION_URL"
      secret_parameter="/vayada/prod/target-database-url"
    else
      secret_name="VAY2017_SOURCE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
    fi
    ;;
  --provision-finance-export-worker|--grant-finance-export-worker|--preflight-finance-export-worker|--preflight-finance-export-ongoing)
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="finance-export-worker-database.mjs"
    secret_name="FINANCE_EXPORT_WORKER_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-finance-export-worker-url"
    if [[ "${mode}" == "--preflight-finance-export-ongoing" ]]; then
      [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
      export_ongoing="true"
    elif [[ "${mode}" == "--provision-finance-export-worker" ]]; then
      [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
      code_file="provision-target-database-identity-runtime.mjs"
      provision_scope="finance_export"
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
      extra_secret_name="FINANCE_EXPORT_WORKER_DATABASE_URL"
      extra_secret_parameter="/vayada/prod/target-database-finance-export-worker-url"
    else
      [[ "$#" -eq 3 && "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ && "$3" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
        echo "Finance export grant/preflight requires the reviewed property and export UUIDs." >&2; exit 2;
      }
      export_property="$2"
      export_id="$3"
      if [[ "${mode}" == "--grant-finance-export-worker" ]]; then
        grant_scope="finance_export"
        secret_name="TARGET_DATABASE_MIGRATION_URL"
        secret_parameter="/vayada/prod/target-database-url"
      fi
    fi
    ;;
  --inspect-hotel-setup-reader-rls|--repair-hotel-setup-reader-rls|--verify-hotel-setup-creation-reader-rls|--verify-hotel-setup-property-reader-rls|--inspect-hotel-setup-legacy-helpers|--verify-hotel-setup-legacy-helpers|--inspect-approved-hotel-setup-legacy-helpers|--repair-approved-hotel-setup-legacy-helpers|--inspect-hotel-setup-tenant-helpers|--repair-hotel-setup-tenant-helpers)
    [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main &&
       "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REPOSITORY:-}" == vayada-marketplace/vayada-platform ]] || exit 2
    reader_rls_mode=inspect
    if [[ "$mode" == --repair-hotel-setup-reader-rls || "$mode" == --repair-approved-hotel-setup-legacy-helpers || "$mode" == --repair-hotel-setup-tenant-helpers ]]; then
      [[ "$#" -eq 2 && "$2" =~ ^[a-f0-9]{64}$ ]] || exit 2
      reader_rls_mode=apply; reader_rls_frozen="$2"
    else [[ "$#" -eq 1 || "$mode" == --verify-hotel-setup-legacy-helpers ]] || exit 2; fi
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="hotel-setup-reader-rls-permissions.mjs"
    secret_name="TARGET_DATABASE_ADMIN_URL"
    secret_parameter="/vayada/prod/db-marketplace-url"
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@sha256:c2fbba1a4d3f8f7bc4c46d0816f125d3598cd1c1a4880dd3b103feb0d3aa67d2"
    creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution"
    if [[ "$mode" == --inspect-hotel-setup-reader-rls || "$mode" == --repair-hotel-setup-reader-rls ]]; then
      secret_name="TARGET_DATABASE_MIGRATION_URL"
      secret_parameter="/vayada/prod/target-database-url"
      creation_execution_role="arn:aws:iam::269416271598:role/vayada-next-api-setup-caller-execution"
    fi
    if [[ "$mode" == --inspect-hotel-setup-legacy-helpers || "$mode" == --verify-hotel-setup-legacy-helpers ]]; then
      [[ "${EXPECTED_TASK:-}" == arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186 ]] || exit 2
      reader_rls_mode=""; legacy_helper_mode=inspect
      if [[ "$mode" == --verify-hotel-setup-legacy-helpers ]]; then
        [[ "$#" -eq 2 && "$2" =~ ^[a-f0-9]{64}$ ]] || exit 2
        legacy_helper_mode=verify; legacy_helper_frozen="$2"
      fi
      code_file="hotel-setup-legacy-helper-inspection.mjs"
      creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-bootstrap"
    fi
    if [[ "$mode" == --inspect-approved-hotel-setup-legacy-helpers || "$mode" == --repair-approved-hotel-setup-legacy-helpers ]]; then
      [[ "${EXPECTED_TASK:-}" == arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186 ]] || exit 2
      legacy_helper_mode="$reader_rls_mode"; legacy_helper_frozen="$reader_rls_frozen"; reader_rls_mode=""; reader_rls_frozen=""
      legacy_helper_scope="hotel_setup_approved_legacy_helper_repair"
      code_file="hotel-setup-approved-legacy-helper-repair.mjs"
      secret_name="TARGET_DATABASE_MIGRATION_URL"; secret_parameter="/vayada/prod/target-database-url"
      creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-bootstrap"
      creation_execution_role="arn:aws:iam::269416271598:role/vayada-next-api-setup-caller-execution"
    fi
    if [[ "$mode" == --inspect-hotel-setup-tenant-helpers || "$mode" == --repair-hotel-setup-tenant-helpers ]]; then
      [[ "${EXPECTED_TASK:-}" == arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1192 ]] || exit 2
      legacy_helper_mode="$reader_rls_mode"; legacy_helper_frozen="$reader_rls_frozen"; reader_rls_mode=""; reader_rls_frozen=""
      legacy_helper_scope="hotel_setup_tenant_helpers"
      creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-bootstrap"
      code_file="hotel-setup-tenant-helper-repair.mjs"
      secret_name="TARGET_DATABASE_MIGRATION_URL"; secret_parameter="/vayada/prod/target-database-url"
      creation_execution_role="arn:aws:iam::269416271598:role/vayada-next-api-setup-caller-execution"
    fi
    if [[ "$mode" == --verify-hotel-setup-creation-reader-rls || "$mode" == --verify-hotel-setup-property-reader-rls ]]; then
      code_file="hotel-setup-reader-rls-native-preflight.mjs"
      secret_name="HOTEL_SETUP_COMMAND_READER_DATABASE_URL"
      if [[ "$mode" == --verify-hotel-setup-creation-reader-rls ]]; then
        reader_rls_mode=property_creation
        log_group="/ecs/vayada-hotel-setup"
        secret_parameter="arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-creation/prod/reader-database-url-EDME10"
        creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-execution"
      else
        reader_rls_mode=property_commands
        log_group="/ecs/vayada-hotel-setup-property"
        secret_parameter="arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/reader-database-url-WqoWDT"
        creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-execution"
      fi
    fi
    ;;
  --audit-hotel-setup-migration|--audit-hotel-setup-readiness-migrations|--inspect-hotel-setup-logo-migration|--stage-hotel-setup-migration-scope|--stage-hotel-setup-logo-migration-scope)
    [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main && "$#" -eq 2 && "$2" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
    if [[ -n "$logo_reader_phase" ]]; then
      jq -e --arg digest "$2" '.[ $digest ] == "3efb2195a823f40b7cd5a716db5bf08ac3fe90ad"' \
        "$(dirname "${BASH_SOURCE[0]}")/../deployment/hotel-setup-property-images.json" >/dev/null || exit 1
    else
    inventory="$(dirname "${BASH_SOURCE[0]}")/../deployment/hotel-setup-bootstrap-images.json"
    jq -e --arg digest "$2" '.[ $digest ] | type == "object" and
      (.primarySource | test("^[a-f0-9]{40}$")) and (.rollbackSource | test("^[a-f0-9]{40}$")) and
      (.publisherSource | test("^[a-f0-9]{40}$"))' "${inventory}" >/dev/null || exit 1
    fi
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="audit-hotel-setup-migration.mjs"
    [[ "${mode}" != "--audit-hotel-setup-readiness-migrations" ]] || code_file="audit-hotel-setup-readiness-migrations.mjs"
    [[ "${mode}" != "--inspect-hotel-setup-logo-migration" ]] || code_file="inspect-hotel-setup-logo-migration.mjs"
    [[ "${mode}" != "--stage-hotel-setup-migration-scope" ]] || code_file="stage-hotel-setup-migration-scope.mjs"
    [[ "${mode}" != "--stage-hotel-setup-logo-migration-scope" ]] || code_file="stage-hotel-setup-logo-migration-scope.mjs"
    [[ -z "$logo_recovery_phase" ]] || code_file="recover-hotel-setup-logo-staged-role.mjs"
    [[ -z "$logo_reader_phase" ]] || code_file="hotel-setup-logo-reader-cutover.mjs"
    [[ -z "$profile_scope" ]] || code_file="stage-hotel-setup-profile-migration-scope.mjs"
    secret_name="HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL"
    secret_parameter="/vayada/prod/db-marketplace-url"
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@$2"
    creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution"
    if [[ "$logo_reader_phase" == verify ]]; then
      secret_name="HOTEL_SETUP_COMMAND_READER_DATABASE_URL"
      secret_parameter="arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/reader-database-url-WqoWDT"
      creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-execution"
      log_group="/ecs/vayada-hotel-setup-property"
    fi
    ;;
  --audit-hotel-setup-owner)
    [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main && "$#" -eq 3 ]] || exit 2
    [[ "$2" =~ ^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$ && "${#2}" -le 254 && "$3" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
    owner_email="$2"
    inventory="$(dirname "${BASH_SOURCE[0]}")/../deployment/hotel-setup-bootstrap-images.json"
    jq -e --arg digest "$3" '.[ $digest ] | type == "object" and
      (.primarySource | test("^[a-f0-9]{40}$")) and (.rollbackSource | test("^[a-f0-9]{40}$")) and
      (.publisherSource | test("^[a-f0-9]{40}$"))' "${inventory}" >/dev/null || exit 1
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="audit-hotel-setup-owner.mjs"
    secret_name="HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL"
    secret_parameter="/vayada/prod/db-marketplace-url"
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@$3"
    creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution"
    ;;
  --cleanup-hotel-setup-logo)
    [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main &&
       "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REPOSITORY:-}" == vayada-marketplace/vayada-platform && "$#" -eq 9 ]] || exit 2
    uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    [[ "$2" =~ ${uuid} && "$3" =~ ${uuid} && "$4" =~ ${uuid} && "$6" =~ ${uuid} &&
       "$5" =~ ^(upload_session|publication_job)$ && "$7" =~ ^(plan|apply)$ && "$9" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
    [[ ( "$7" == plan && -z "$8" ) || ( "$7" == apply && "$8" =~ ^[a-f0-9]{64}$ ) ]] || exit 2
    property_id="$2"; creation_org="$3"; creation_actor="$4"; property_operation="property_logo"
    logo_cleanup_kind="$5"; logo_cleanup_target="$6"; logo_cleanup_phase="$7"; logo_cleanup_hash="$8"
    inventory="$(dirname "${BASH_SOURCE[0]}")/../deployment/hotel-setup-logo-images.json"
    jq -e --arg digest "$9" '.[ $digest ] | type == "string" and test("^[a-f0-9]{40}$")' "$inventory" >/dev/null || exit 1
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="run-hotel-setup-logo-cleanup.mjs"
    secret_name="HOTEL_SETUP_HELPER_OWNER_DATABASE_URL"
    secret_parameter="/vayada/prod/target-database-url"
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@$9"
    creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-logo-cleanup"
    creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution"
    ;;
  --provision-hotel-setup-property-native)
    [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REF:-}" == refs/heads/main && "$#" -eq 6 ]] || exit 2
    uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    [[ "$2" =~ ${uuid} && "$3" =~ ${uuid} && "$4" =~ ${uuid} && "$5" =~ ^(launch_settings|currency|currency_ready|feature_hub|property_logo|property_profile)$ && "$6" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
    property_id="$2"; creation_org="$3"; creation_actor="$4"; property_operation="$5"
    inventory="$(dirname "${BASH_SOURCE[0]}")/../deployment/hotel-setup-bootstrap-images.json"
    jq -e --arg digest "$6" '.[ $digest ] | type == "object" and
      (.primarySource | test("^[a-f0-9]{40}$")) and (.rollbackSource | test("^[a-f0-9]{40}$")) and
      (.publisherSource | test("^[a-f0-9]{40}$"))' "${inventory}" >/dev/null || exit 1
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="run-hotel-setup-property-bootstrap.mjs"
    secret_name="HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL"
    secret_parameter="/vayada/prod/db-marketplace-url"
    extra_secret_name="HOTEL_SETUP_HELPER_OWNER_DATABASE_URL"
    extra_secret_parameter="/vayada/prod/target-database-url"
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@$6"
    creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap"
    creation_execution_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution"
    ;;
  --provision-hotel-setup-creation-org|--provision-hotel-setup-creation-reader|--provision-hotel-setup-property-reader)
    if [[ "${mode}" == "--provision-hotel-setup-creation-org" ]]; then
      [[ "$#" -eq 4 && "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
         "$3" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || exit 2
      creation_purpose="organization"; creation_org="$2"; creation_actor="$3"; creation_digest="$4"
      creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-bootstrap"
    else
      [[ "$#" -eq 2 ]] || exit 2
      creation_digest="$2"
      if [[ "${mode}" == "--provision-hotel-setup-property-reader" ]]; then
        creation_purpose="property_reader"
        creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-property-reader-bootstrap"
      else
        creation_purpose="creation_reader"
        creation_task_role="arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-reader-bootstrap"
      fi
    fi
    [[ "${creation_digest}" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
    inventory="$(dirname "${BASH_SOURCE[0]}")/../deployment/hotel-setup-command-images.json"
    jq -e --arg digest "${creation_digest}" '.[ $digest ] | type == "string" and test("^[a-f0-9]{40}$")' "${inventory}" >/dev/null || {
      echo "Creation bootstrap requires an approved immutable application image." >&2; exit 1;
    }
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="provision-hotel-setup-creation-login.mjs"
    secret_name="TARGET_DATABASE_ADMIN_URL"
    secret_parameter="/vayada/prod/db-marketplace-url"
    task_image="269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@${creation_digest}"
    ;;
  --provision-hotel-setup-scope)
    [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    ca_required=true
    family="vayada-next-api-db-runtime-preflight"
    code_file="provision-hotel-setup-scope-role.mjs"
    secret_name="TARGET_DATABASE_ADMIN_URL"
    secret_parameter="/vayada/prod/db-marketplace-url"
    ;;
  --provision-identity-role|--grant-identity-runtime|--inspect-identity-role|--inspect-cluster-database-acl|--harden-cluster-database-acl)
    [[ "$#" -eq 1 ]] || { echo "Unexpected arguments." >&2; exit 2; }
    ca_required=true
    secret_name="TARGET_DATABASE_MIGRATION_URL"
    secret_parameter="/vayada/prod/target-database-url"
    family="vayada-next-api-db-runtime-preflight"
    if [[ "${mode}" == "--provision-identity-role" ]]; then
      code_file="provision-target-database-identity-runtime.mjs"
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
      extra_secret_name="IDENTITY_DATABASE_URL"
      extra_secret_parameter="/vayada/prod/target-database-identity-runtime-url"
    elif [[ "${mode}" == "--inspect-cluster-database-acl" || "${mode}" == "--harden-cluster-database-acl" ]]; then
      if [[ "${mode}" == "--inspect-cluster-database-acl" ]]; then
        code_file="inspect-target-database-cluster-acl.mjs"
      else
        code_file="harden-target-database-cluster-acl.mjs"
      fi
      secret_name="TARGET_DATABASE_ADMIN_URL"
      secret_parameter="/vayada/prod/db-marketplace-url"
    elif [[ "${mode}" == "--inspect-identity-role" ]]; then
      code_file="inspect-target-database-identity-role.mjs"
    else
      code_file="grant-target-database-identity-runtime.mjs"
    fi
    ;;
  *) echo "Unknown mode: ${mode}" >&2; exit 2 ;;
esac
if [[ "${ca_required}" == true ]]; then
  for command_name in curl shasum; do
    command -v "${command_name}" >/dev/null || { echo "Required command not found: ${command_name}" >&2; exit 1; }
  done
  ca_bundle="$(curl -fsSL --connect-timeout 5 --max-time 15 \
    https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem)"
  ca_hash="$(printf '%s' "${ca_bundle}" | shasum -a 256 | cut -d ' ' -f 1)"
  [[ "${ca_hash}" == 0fdc44d91c5a69ef4efc3f9ede636ccc22b11a890c5a656a134275da26afa812 ]] || {
    echo "Amazon RDS CA bundle checksum mismatch." >&2; exit 1;
  }
  if [[ "$code_in_definition" == true || -n "$reader_rls_mode" || -n "$legacy_helper_mode" || "${mode}" == "--audit-financials-readiness" || "${mode}" == "--preflight-vay2017-historical-bindings" || "${mode}" == "--import-vay2017-source-snapshot" || "${mode}" == "--grant-identity-runtime" || "${mode}" == "--grant-expense-category-insert" || "${mode}" == "--grant-expense-insert" || "${mode}" == "--grant-recurring-expense-insert" || "${mode}" == "--grant-folio-command" || "${mode}" == "--grant-affiliate-read" || "${mode}" == "--grant-finance-affiliate-read" || "${mode}" == "--grant-platform-runtime-read" || "${mode}" == "--grant-property-profile-lock" || "${mode}" == "--grant-hotel-setup-tracks" || "${mode}" == "--harden-cluster-database-acl" || "${mode}" == "--provision-hotel-setup-scope" || ( "${mode}" == --provision-hotel-setup-creation-* || "${mode}" == "--provision-hotel-setup-property-reader" || "${mode}" == "--provision-hotel-setup-property-native" || "${mode}" == "--cleanup-hotel-setup-logo" || "${mode}" == "--audit-hotel-setup-owner" || "${mode}" == "--audit-hotel-setup-migration" || ( "${mode}" == "--audit-hotel-setup-readiness-migrations" || "${mode}" == "--inspect-hotel-setup-logo-migration" ) || ( "${mode}" == "--stage-hotel-setup-migration-scope" || "${mode}" == "--stage-hotel-setup-logo-migration-scope" ) ) || "${mode}" == *finance-expense-worker || "${mode}" == *finance-export-worker || "${mode}" == "--preflight-finance-export-ongoing" || "${mode}" == *channex-management-worker ]]; then
    command -v node >/dev/null || { echo "Required command not found: node" >&2; exit 1; }
    # This one-time grant targets the RDS instance's pinned RSA2048 G1 CA.
    # Pass only that root: the complete regional bundle exceeds ECS's 8192-byte override limit.
    ca_bundle="${ca_bundle%%-----END CERTIFICATE-----*}-----END CERTIFICATE-----"
    ca_fingerprint="$(printf '%s' "${ca_bundle}" | node -e '
      const { X509Certificate } = require("node:crypto");
      let input = "";
      process.stdin.on("data", (part) => input += part);
      process.stdin.on("end", () => console.log(new X509Certificate(input).fingerprint256));
    ')"
    [[ "${ca_fingerprint}" == "6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86" ]] || {
      echo "Pinned grant CA fingerprint mismatch." >&2; exit 1;
    }
  fi
  ca_payload="$(printf '%s' "${ca_bundle}" | gzip -9 -c | base64 | tr -d '\n')"
  if [[ ( -n "$reader_rls_mode" || -n "$legacy_helper_mode" || "${mode}" == "--audit-financials-readiness" || "${mode}" == "--preflight-vay2017-historical-bindings" || "${mode}" == "--import-vay2017-source-snapshot" || "${mode}" == "--grant-identity-runtime" || "${mode}" == "--grant-expense-category-insert" || "${mode}" == "--grant-expense-insert" || "${mode}" == "--grant-recurring-expense-insert" || "${mode}" == "--grant-folio-command" || "${mode}" == "--grant-affiliate-read" || "${mode}" == "--grant-finance-affiliate-read" || "${mode}" == "--grant-platform-runtime-read" || "${mode}" == "--grant-property-profile-lock" || "${mode}" == "--grant-hotel-setup-tracks" || "${mode}" == "--harden-cluster-database-acl" || "${mode}" == "--provision-hotel-setup-scope" || ( "${mode}" == --provision-hotel-setup-creation-* || "${mode}" == "--provision-hotel-setup-property-reader" || "${mode}" == "--provision-hotel-setup-property-native" || "${mode}" == "--cleanup-hotel-setup-logo" || "${mode}" == "--audit-hotel-setup-owner" || "${mode}" == "--audit-hotel-setup-migration" || ( "${mode}" == "--audit-hotel-setup-readiness-migrations" || "${mode}" == "--inspect-hotel-setup-logo-migration" ) || ( "${mode}" == "--stage-hotel-setup-migration-scope" || "${mode}" == "--stage-hotel-setup-logo-migration-scope" ) ) ) && "${#ca_payload}" -gt 2100 ]]; then
    echo "Pinned grant CA payload exceeds the reviewed ECS override budget." >&2; exit 1
  fi
fi
cluster="vayada-target-database-runtime-preflight"
service_cluster="vayada-backend-cluster"
service="vayada-next-api-service"
container="vayada-next-api"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload=""
if [[ -n "${code_file}" ]]; then payload="$(gzip -n -9 -c "${script_dir}/${code_file}" | base64 | tr -d '\n')"; fi
helper_payload=""
if [[ -n "${helper_file}" ]]; then helper_payload="$(gzip -9 -c "${script_dir}/${helper_file}" | base64 | tr -d '\n')"; fi
if [[ -n "$legacy_helper_mode" ]]; then
  payload="$(node -e "const fs=require('node:fs'),z=require('node:zlib');process.stdout.write(z.brotliCompressSync(fs.readFileSync(process.argv[1]),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}).toString('base64'))" "${script_dir}/${code_file}")"
  bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-db-runtime-preflight.mjs';process.env.VAYADA_DB_RDS_CA_BUNDLE=z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP,'base64')).toString();fs.writeFileSync(p,z.brotliDecompressSync(Buffer.from(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_CODE,'base64')));process.argv[1]=p;import(p).catch(()=>process.exit(1))"
elif [[ "$reader_rls_mode" == inspect || "$reader_rls_mode" == apply ]]; then
  payload="$(node -e "const fs=require('node:fs'),z=require('node:zlib');process.stdout.write(z.brotliCompressSync(fs.readFileSync(process.argv[1]),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}).toString('base64'))" "${script_dir}/${code_file}")"
  bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-db-runtime-preflight.mjs';process.env.VAYADA_DB_RDS_CA_BUNDLE=z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP,'base64')).toString();fs.writeFileSync(p,z.brotliDecompressSync(Buffer.from(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_CODE,'base64')));if(process.env.HOTEL_SETUP_READER_RLS_MODE)process.argv[1]=p;import(p).catch(()=>process.exit(1))"
elif [[ -n "${vay2017_phase}" ]]; then
  bootstrap="const{spawnSync}=require('node:child_process'),z=require('node:zlib');process.env.VAYADA_DB_RDS_CA_BUNDLE=z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP,'base64')).toString();const r=spawnSync(process.execPath,['/app/packages/backend-migration/dist/cli/legacyHistoricalBindingProductionPreflight.js',process.env.VAY2017_PREFLIGHT_PHASE],{stdio:'inherit',env:process.env});process.exit(r.status??1)"
else
  bootstrap="const fs=require('node:fs'),z=require('node:zlib'),p='/app/.vayada-db-runtime-preflight.mjs';if(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP)process.env.VAYADA_DB_RDS_CA_BUNDLE=z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RDS_CA_BUNDLE_GZIP,'base64')).toString();if(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_HELPER)fs.writeFileSync('/app/channex-policy-consumer-roles.mjs',z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_HELPER,'base64')));fs.writeFileSync(p,z.gunzipSync(Buffer.from(process.env.VAYADA_DB_RUNTIME_PREFLIGHT_CODE,'base64')));if(process.env.HOTEL_SETUP_READER_RLS_MODE)process.argv[1]=p;import(p).catch(()=>{console.error(JSON.stringify({status:'FAIL',code:'runtime_preflight_bootstrap_failed'}));process.exit(1)})"
fi
[[ -z "$logo_recovery_phase" && -z "$logo_reader_phase" ]] || bootstrap="process.argv[1]='/app/.vayada-db-runtime-preflight.mjs';$bootstrap"
overrides="$(jq -cn --arg bootstrap "${bootstrap}" --arg code "${payload}" --arg name "${container}" \
  --arg helper "${helper_payload}" --arg ca "${ca_payload}" --arg scope "${grant_scope}" --arg reader_rls_mode "${reader_rls_mode}" --arg reader_rls_frozen "${reader_rls_frozen}" --arg legacy_helper_mode "${legacy_helper_mode}" --arg legacy_helper_frozen "${legacy_helper_frozen}" --arg provision_scope "${provision_scope}" --arg finance_property "${finance_property}" --arg export_property "${export_property}" --arg export_id "${export_id}" --arg export_ongoing "${export_ongoing}" --arg channex_property "${channex_property}" --arg financials_readiness_property "${financials_readiness_property}" \
  --arg product_dml_required "${product_dml_required}" --arg vay2017_phase "${vay2017_phase}" --arg vay2017_source_sha "${vay2017_source_sha}" --arg vay2017_execution_id "${vay2017_execution_id}" \
  --arg owner_email "${owner_email}" --arg property_id "${property_id}" --arg property_operation "${property_operation}" --arg creation_purpose "${creation_purpose}" --arg creation_org "${creation_org}" --arg creation_actor "${creation_actor}" \
  --arg logo_cleanup_kind "${logo_cleanup_kind}" --arg logo_cleanup_target "${logo_cleanup_target}" --arg logo_cleanup_phase "${logo_cleanup_phase}" --arg logo_cleanup_hash "${logo_cleanup_hash}" \
  --arg logo_recovery_phase "$logo_recovery_phase" --arg logo_recovery_frozen "$logo_recovery_frozen" \
  --arg logo_reader_phase "$logo_reader_phase" --arg logo_reader_frozen "$logo_reader_frozen" \
  --arg vay2017_source_import_phase "${vay2017_source_import_phase}" \
  --arg vay2017_signing_key_id "${VAY2017_PREFLIGHT_SIGNING_KEY_ID:-}" --arg vay2017_input "${VAY2017_PREFLIGHT_INPUT_GZIP_BASE64:-}" --arg vay2017_signature "${VAY2017_PREFLIGHT_SIGNATURE:-}" --arg vay2017_public_key "${VAY2017_PREFLIGHT_PUBLIC_KEY_BASE64:-}" --arg vay2017_principal "${CHANNEX_ADOPTION_EXECUTION_PRINCIPAL:-}" \
  '{containerOverrides:[{name:$name,command:["node","--eval",$bootstrap],
    environment:([{name:"VAYADA_DB_RUNTIME_PREFLIGHT_CODE",value:$code}] +
      (if $helper == "" then [] else [{name:"VAYADA_DB_RUNTIME_PREFLIGHT_HELPER",value:$helper}] end) +
      (if $legacy_helper_mode == "" then [] else [{name:"HOTEL_SETUP_LEGACY_HELPER_MODE",value:$legacy_helper_mode},
        {name:"GITHUB_ACTIONS",value:"true"},{name:"GITHUB_REF",value:"refs/heads/main"}] end) +
      (if $legacy_helper_frozen == "" then [] else [{name:"HOTEL_SETUP_LEGACY_HELPER_FROZEN",value:$legacy_helper_frozen}] end) +
      (if $logo_recovery_phase == "" then [] else [{name:"HOTEL_SETUP_LOGO_RECOVERY_PHASE",value:$logo_recovery_phase},
        {name:"HOTEL_SETUP_LOGO_RECOVERY_FROZEN",value:$logo_recovery_frozen},
        {name:"GITHUB_ACTIONS",value:"true"},{name:"GITHUB_REF",value:"refs/heads/main"}] end) +
      (if $logo_reader_phase == "" then [] else [{name:"HOTEL_SETUP_LOGO_READER_PHASE",value:$logo_reader_phase},
        {name:"HOTEL_SETUP_LOGO_READER_FROZEN",value:$logo_reader_frozen},
        {name:"GITHUB_ACTIONS",value:"true"},{name:"GITHUB_REF",value:"refs/heads/main"}] end) +
      (if $reader_rls_mode == "" then [] else [{name:"HOTEL_SETUP_READER_RLS_MODE",value:$reader_rls_mode},
        {name:"GITHUB_ACTIONS",value:"true"},{name:"GITHUB_REF",value:"refs/heads/main"}] end) +
      (if $reader_rls_mode == "property_creation" or $reader_rls_mode == "property_commands" then
        [{name:"HOTEL_SETUP_COMMAND_MODE",value:$reader_rls_mode}] else [] end) +
      (if $reader_rls_frozen == "" then [] else [{name:"HOTEL_SETUP_READER_RLS_FROZEN",value:$reader_rls_frozen}] end) +
      (if $owner_email == "" then [] else [{name:"HOTEL_SETUP_OWNER_EMAIL",value:$owner_email}] end) +
      (if $property_id == "" then [] else [{name:"HOTEL_SETUP_COMMAND_PROPERTY_ID",value:$property_id},{name:"HOTEL_SETUP_COMMAND_OPERATION",value:$property_operation}] end) +
      (if $logo_cleanup_kind == "" then [] else [{name:"HOTEL_SETUP_LOGO_CLEANUP_KIND",value:$logo_cleanup_kind},
        {name:"HOTEL_SETUP_LOGO_CLEANUP_TARGET_ID",value:$logo_cleanup_target},
        {name:"HOTEL_SETUP_LOGO_CLEANUP_EXPECTED_MANIFEST_SHA256",value:$logo_cleanup_hash},
        {name:"HOTEL_SETUP_LOGO_CLEANUP_APPLY",value:(if $logo_cleanup_phase=="apply" then "enabled" else "blocked" end)},
        {name:"PLATFORM_MEDIA_BUCKET",value:"vayada-media-production"}] end) +
      (if $creation_purpose == "" then [] else [{name:"HOTEL_SETUP_BOOTSTRAP_PURPOSE",value:$creation_purpose}] end) +
      (if $creation_org == "" then [] else [{name:"HOTEL_SETUP_COMMAND_ORGANIZATION_ID",value:$creation_org}] end) +
      (if $creation_actor == "" then [] else [{name:"HOTEL_SETUP_COMMAND_ACTOR_USER_ID",value:$creation_actor}] end) +
      (if $ca == "" then [] else [{name:"VAYADA_DB_RDS_CA_BUNDLE_GZIP",value:$ca}] end) +
      (if $scope == "" then [] else [{name:"VAYADA_DB_GRANT_SCOPE",value:$scope}] end) +
      (if $product_dml_required == "true" then [{name:"VAYADA_DB_REQUIRE_PRODUCT_DML",value:"1"}] else [] end) +
      (if $provision_scope == "" then [] else [{name:"VAYADA_DB_PROVISION_SCOPE",value:$provision_scope}] end) +
      (if $finance_property == "" then [] else [{name:"FINANCE_EXPENSE_WORKER_PROPERTY_ID",value:$finance_property}] end) +
      (if $export_property == "" then [] else [{name:"FINANCE_EXPORT_WORKER_PROPERTY_ID",value:$export_property}] end) +
      (if $export_id == "" then [] else [{name:"FINANCE_EXPORT_WORKER_EXPORT_ID",value:$export_id}] end) +
      (if $export_ongoing == "true" then [{name:"FINANCE_EXPORT_WORKER_ONGOING",value:"true"}] else [] end) +
      (if $financials_readiness_property == "" then [] else [{name:"FINANCIALS_READINESS_PROPERTY_ID",value:$financials_readiness_property}] end) +
      (if $channex_property == "" then [] else [{name:"PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID",value:$channex_property}] end) +
      (if $vay2017_phase == "" then [] else [{name:"VAY2017_PREFLIGHT_PHASE",value:$vay2017_phase}] end) +
      (if $vay2017_source_import_phase == "" then [] else [{name:"VAY2017_SOURCE_IMPORT_PHASE",value:$vay2017_source_import_phase}] end) +
      (if $vay2017_source_import_phase == "extract" then [{name:"SOURCE_ATTESTATION_OWNER",value:"vay2017_source_attestor_20260929"}] else [] end) +
      (if $vay2017_source_sha == "" then [] else [{name:"VAY2017_PREFLIGHT_SOURCE_SHA",value:$vay2017_source_sha}] end) +
      (if $vay2017_execution_id == "" then [] else [{name:"VAY2017_PREFLIGHT_EXECUTION_ID",value:$vay2017_execution_id}] end) +
      (if $vay2017_signing_key_id == "" then [] else [{name:"VAY2017_PREFLIGHT_SIGNING_KEY_ID",value:$vay2017_signing_key_id}] end) +
      (if $vay2017_input == "" then [] else [{name:"VAY2017_PREFLIGHT_INPUT_GZIP_BASE64",value:$vay2017_input}] end) +
      (if $vay2017_signature == "" then [] else [{name:"VAY2017_PREFLIGHT_SIGNATURE",value:$vay2017_signature}] end) +
      (if $vay2017_public_key == "" then [] else [{name:"VAY2017_PREFLIGHT_PUBLIC_KEY_BASE64",value:$vay2017_public_key}] end) +
      (if $vay2017_principal == "" then [] else [{name:"CHANNEX_ADOPTION_EXECUTION_PRINCIPAL",value:$vay2017_principal}] end))}]}')"
definition_environment='[]'
if [[ "$code_in_definition" == true || "$legacy_helper_scope" == hotel_setup_approved_legacy_helper_repair || "$legacy_helper_scope" == hotel_setup_tenant_helpers || "$mode" == --inspect-hotel-setup-logo-migration || -n "$logo_recovery_phase" || -n "$logo_reader_phase" ]]; then
  # Nonsecret reviewed code and public CA live only in the disposable definition.
  # Keep runtime arguments under ECS's override limit; credentials stay secret-injected.
  definition_environment="$(jq -c '[.containerOverrides[0].environment[] | select(.name=="VAYADA_DB_RUNTIME_PREFLIGHT_CODE" or .name=="VAYADA_DB_RDS_CA_BUNDLE_GZIP")]' <<<"$overrides")"
  overrides="$(jq -c '.containerOverrides[0].environment |= map(select(.name!="VAYADA_DB_RUNTIME_PREFLIGHT_CODE" and .name!="VAYADA_DB_RDS_CA_BUNDLE_GZIP"))' <<<"$overrides")"
fi
[[ "${#overrides}" -le 8192 ]] || { echo "ECS command override exceeds the 8192-byte limit." >&2; exit 1; }

if [[ "${mode}" == "--audit-financials-readiness" ]]; then
  service_state="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" \
    --query 'services[0].{taskDefinition:taskDefinition,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount,deployments:deployments}' --output json)"
  jq -e '.desiredCount == 1 and .runningCount == 1 and .pendingCount == 0 and
    (.deployments | length) == 1 and .deployments[0].status == "PRIMARY" and
    .deployments[0].rolloutState == "COMPLETED"' <<<"${service_state}" >/dev/null || {
    echo "Financials readiness requires one stable serving API task." >&2; exit 1;
  }
  current_task="$(jq -r '.taskDefinition' <<<"${service_state}")"
  running_tasks="$(aws ecs list-tasks --cluster "${service_cluster}" --service-name "${service}" \
    --desired-status RUNNING --region "${region}" --query 'taskArns' --output json)"
  [[ "$(jq 'length' <<<"${running_tasks}")" == "1" ]] || {
    echo "Financials readiness requires one observed running API task." >&2; exit 1;
  }
  observed_task="$(aws ecs describe-tasks --cluster "${service_cluster}" --tasks "$(jq -r '.[0]' <<<"${running_tasks}")" \
    --region "${region}" --query 'tasks[0].{taskDefinitionArn:taskDefinitionArn,lastStatus:lastStatus,containers:containers[].{name:name,image:image,imageDigest:imageDigest}}' --output json)"
  financials_readiness_image_digest="$(jq -r '.containers[] | select(.name == "vayada-next-api") | .imageDigest' <<<"${observed_task}")"
  [[ "$(jq -r '.taskDefinitionArn' <<<"${observed_task}")" == "${current_task}" &&
     "$(jq -r '.lastStatus' <<<"${observed_task}")" == "RUNNING" &&
     "${financials_readiness_image_digest}" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo "Financials readiness serving image changed during inspection." >&2; exit 1;
  }
else
  current_task="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" \
    --query 'services[0].taskDefinition' --output text)"
fi
source_definition="$(aws ecs describe-task-definition --task-definition "${current_task}" --region "${region}" \
  --query taskDefinition --output json)"
if [[ -n "$logo_reader_phase" ]]; then
  jq -e --arg image "$task_image" '[.containerDefinitions[]|select(.name=="vayada-next-api")|.image]==[$image]' <<<"$source_definition" >/dev/null || exit 1
fi
if [[ -n "$reader_rls_mode" || -n "$legacy_helper_mode" || "${mode}" == "--audit-hotel-setup-migration" || ( "${mode}" == "--audit-hotel-setup-readiness-migrations" || "${mode}" == "--inspect-hotel-setup-logo-migration" ) || ( "${mode}" == "--stage-hotel-setup-migration-scope" || "${mode}" == "--stage-hotel-setup-logo-migration-scope" ) ]]; then
  [[ "${EXPECTED_TASK:-}" == "${current_task}" && "${current_task}" == arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:* ]] || exit 1
  public_state="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" --query 'services[0]' --output json)"
  jq -e --arg expected "${current_task}" '.taskDefinition == $expected and
    .desiredCount == 1 and .runningCount == 1 and .pendingCount == 0 and
    (.deployments | length) == 1 and .deployments[0].status == "PRIMARY" and
    .deployments[0].rolloutState == "COMPLETED"' <<<"${public_state}" >/dev/null || exit 1
  if [[ ( "${mode}" == "--stage-hotel-setup-migration-scope" || "${mode}" == "--stage-hotel-setup-logo-migration-scope" ) ]]; then
    hold="$(aws ssm get-parameter --name /vayada/prod/coordinated-deployments/v1/services/next-target-backend/hold --region "${region}" --query 'Parameter.Value' --output text)"
    python3 - "${script_dir}" "${hold}" "${current_task}" <<'PYCODE'
import json,sys
sys.path.insert(0,sys.argv[1])
from coordinated_release import load_config,validate_hold
hold=json.loads(sys.argv[2])
validate_hold(hold,load_config(),'next-target-backend')
assert hold['status']=='active' and hold['capturedTaskDefinitionArn']==sys.argv[3]
assert hold['dependentFrontendsCompatible'] is False
PYCODE
    if [[ -n "$logo_reader_phase" ]]; then
      jq -e --arg image "$task_image" '.capturedImage==$image' <<<"$hold" >/dev/null || exit 1
    fi
    private_state="$(aws ecs describe-services --cluster "${service_cluster}" --services vayada-hotel-setup-property-service --region "${region}" --query '{services:services,failures:failures}' --output json)"
    jq -e '(.services|length)==1 and (.failures|length)==0 and .services[0].desiredCount==0 and
      .services[0].runningCount==0 and .services[0].pendingCount==0' <<<"${private_state}" >/dev/null || exit 1
  fi
fi
if [[ "${mode}" == "--audit-financials-readiness" ]]; then
  source_image="$(jq -r '.containerDefinitions[] | select(.name == "vayada-next-api") | .image' <<<"${source_definition}")"
  [[ "${source_image}" == *@"${financials_readiness_image_digest}" ]] || {
    echo "Financials readiness task definition is not pinned to the observed image." >&2; exit 1;
  }
fi
# A missing private service or ordinary local writer is not an admission hold.
if [[ "${mode}" == "--provision-hotel-setup-property-reader" || "${mode}" == "--provision-hotel-setup-property-native" || "${mode}" == "--cleanup-hotel-setup-logo" || "${mode}" == "--audit-hotel-setup-owner" ]]; then
  [[ "${EXPECTED_TASK:-}" == "${current_task}" && "${current_task}" == arn:aws:ecs:eu-west-1:269416271598:task-definition/* ]] || {
    echo "Property reader bootstrap requires the reviewed public task definition." >&2; exit 1;
  }
  public_state="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" --query 'services[0]' --output json)"
  jq -e --arg expected "${current_task}" '.taskDefinition == $expected and
    .desiredCount == 1 and .runningCount == 1 and .pendingCount == 0 and
    (.deployments | length) == 1 and .deployments[0].status == "PRIMARY" and
    .deployments[0].rolloutState == "COMPLETED"' <<<"${public_state}" >/dev/null || exit 1
  jq -e '[.containerDefinitions[] | select(.name == "vayada-next-api") |
    .environment[] | select(.name == "HOTEL_SETUP_COMMAND_ADMISSION")] |
    length == 1 and .[0].value == "blocked"' <<<"${source_definition}" >/dev/null || {
    echo "Property reader bootstrap requires explicit blocked caller admission." >&2; exit 1;
  }
  if [[ "${mode}" == "--provision-hotel-setup-property-native" ]]; then
    # Actor-bound purposes forward through the same private service: exactly blocked, or never
    # released (no admission, origin or token). Admission is never accepted from secrets.
    jq -e '[.containerDefinitions[] | select(.name == "vayada-next-api")][0] as $api |
      all("HOTEL_SETUP_LOGO_COMMAND", "HOTEL_SETUP_PROFILE_COMMAND"; . as $prefix |
        [$api.environment[] | select(.name == $prefix + "_ADMISSION")] as $admission |
        ($admission | length == 1 and .[0].value == "blocked") or ($admission | length == 0) and
        all(($api.environment + ($api.secrets // []))[]; .name != $prefix + "_ORIGIN" and .name != $prefix + "_INTERNAL_TOKEN")) and
      all(($api.secrets // [])[]; .name != "HOTEL_SETUP_LOGO_COMMAND_ADMISSION" and .name != "HOTEL_SETUP_PROFILE_COMMAND_ADMISSION")' <<<"${source_definition}" >/dev/null || {
      echo "Property native bootstrap requires blocked actor-bound caller admission." >&2; exit 1;
    }
  fi
  if [[ "${mode}" == "--provision-hotel-setup-property-native" || "${mode}" == "--cleanup-hotel-setup-logo" || "${mode}" == "--audit-hotel-setup-owner" ]]; then
    python3 - "${script_dir}/../deployment/hotel-setup-caller-images.json" "${source_definition}" <<'PYCODE'
import json,re,sys
images=json.load(open(sys.argv[1]))
task=json.loads(sys.argv[2])
item,=[c for c in task['containerDefinitions'] if c['name']=='vayada-next-api']
prefix='269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@'
image=item['image']
assert image.startswith(prefix) and re.fullmatch('[a-f0-9]{40}',images.get(image[len(prefix):],''))
assert not any(e['name']=='HOTEL_SETUP_COMMAND_ADMISSION' for e in item.get('secrets',[]))
PYCODE
  fi
  private_state="$(aws ecs describe-services --cluster "${service_cluster}" --services vayada-hotel-setup-property-service --region "${region}" --query '{services:services,failures:failures}' --output json)"
  jq -e '(.services | length) == 1 and (.failures | length) == 0 and
    .services[0].desiredCount == 0 and .services[0].runningCount == 0 and
    .services[0].pendingCount == 0' <<<"${private_state}" >/dev/null || {
    echo "Property reader bootstrap requires the staged property service at zero tasks." >&2; exit 1;
  }
fi
logo_cleanup_release_gate() {
  [[ "${mode}" == "--cleanup-hotel-setup-logo" || "${mode}" == "--stage-hotel-setup-logo-migration-scope" ]] || return 0
  local public_now private_now running stopped physical
  public_now="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" --query 'services[0]' --output json)"
  jq -e --arg expected "${EXPECTED_TASK}" '.taskDefinition==$expected and .desiredCount==1 and .runningCount==1 and .pendingCount==0 and
    (.deployments|length)==1 and .deployments[0].status=="PRIMARY" and .deployments[0].rolloutState=="COMPLETED"' <<<"$public_now" >/dev/null || return 1
  jq -e '[.containerDefinitions[] | select(.name=="vayada-next-api") | .environment[] | select(.name=="HOTEL_SETUP_LOGO_COMMAND_ADMISSION")] |
    length==1 and .[0].value=="blocked"' <<<"$source_definition" >/dev/null || return 1
  jq -e 'all(.containerDefinitions[] | select(.name=="vayada-next-api") | .secrets[]; .name!="HOTEL_SETUP_LOGO_COMMAND_ADMISSION")' <<<"$source_definition" >/dev/null || return 1
  if [[ "${mode}" == "--stage-hotel-setup-logo-migration-scope" ]]; then
    jq -e '[.containerDefinitions[] | select(.name=="vayada-next-api") | .environment[] |
      select(.name=="HOTEL_SETUP_CREATION_COMMAND_ADMISSION" or .name=="HOTEL_SETUP_COMMAND_ADMISSION")] |
      length==2 and ([.[]|select(.name=="HOTEL_SETUP_CREATION_COMMAND_ADMISSION")]|length)==1 and ([.[]|select(.name=="HOTEL_SETUP_COMMAND_ADMISSION")]|length)==1 and all(.[];.value=="blocked")' <<<"$source_definition" >/dev/null || return 1
    jq -e 'all(.containerDefinitions[] | select(.name=="vayada-next-api") | .secrets[];
      .name!="HOTEL_SETUP_CREATION_COMMAND_ADMISSION" and .name!="HOTEL_SETUP_COMMAND_ADMISSION" and .name!="HOTEL_SETUP_PROFILE_COMMAND_ADMISSION")' <<<"$source_definition" >/dev/null || return 1
    # The profile caller is absent until its own release (no admission, origin or token); once installed it must be blocked.
    jq -e '[.containerDefinitions[] | select(.name=="vayada-next-api")][0] as $api |
      [$api.environment[] | select(.name=="HOTEL_SETUP_PROFILE_COMMAND_ADMISSION")] as $admission |
      ($admission | length==1 and .[0].value=="blocked") or ($admission | length==0) and
      all(($api.environment + ($api.secrets // []))[]; .name!="HOTEL_SETUP_PROFILE_COMMAND_ORIGIN" and .name!="HOTEL_SETUP_PROFILE_COMMAND_INTERNAL_TOKEN")' <<<"$source_definition" >/dev/null || return 1
    local current_hold
    current_hold="$(aws ssm get-parameter --name /vayada/prod/coordinated-deployments/v1/services/next-target-backend/hold --region "${region}" --query 'Parameter.Value' --output text)"
    [[ "$current_hold" == "$hold" ]] || return 1
    local creation_now creation_running creation_stopped creation_physical
    creation_now="$(aws ecs describe-services --cluster "${service_cluster}" --services vayada-hotel-setup-service --region "${region}" --query '{services:services,failures:failures}' --output json)"
    jq -e '(.services|length)==1 and (.failures|length)==0 and .services[0].desiredCount==0 and .services[0].runningCount==0 and .services[0].pendingCount==0' <<<"$creation_now" >/dev/null || return 1
    creation_running="$(aws ecs list-tasks --cluster "${service_cluster}" --service-name vayada-hotel-setup-service --desired-status RUNNING --region "${region}" --query taskArns --output json)"
    jq -e 'length==0' <<<"$creation_running" >/dev/null || return 1
    creation_stopped="$(aws ecs list-tasks --cluster "${service_cluster}" --service-name vayada-hotel-setup-service --desired-status STOPPED --region "${region}" --query taskArns --output json)"
    jq -e 'length<=100' <<<"$creation_stopped" >/dev/null || return 1
    if [[ "$(jq length <<<"$creation_stopped")" != 0 ]]; then
      creation_physical="$(aws ecs describe-tasks --cluster "${service_cluster}" --tasks $(jq -r '.[]' <<<"$creation_stopped") --region "${region}" --output json)"
      jq -e --argjson count "$(jq length <<<"$creation_stopped")" '(.failures|length)==0 and (.tasks|length)==$count and all(.tasks[];.group=="service:vayada-hotel-setup-service" and .desiredStatus=="STOPPED" and .lastStatus=="STOPPED")' <<<"$creation_physical" >/dev/null || return 1
    fi
  fi
  private_now="$(aws ecs describe-services --cluster "${service_cluster}" --services vayada-hotel-setup-property-service --region "${region}" --query '{services:services,failures:failures}' --output json)"
  jq -e '(.services|length)==1 and (.failures|length)==0 and .services[0].desiredCount==0 and .services[0].runningCount==0 and .services[0].pendingCount==0' <<<"$private_now" >/dev/null || return 1
  running="$(aws ecs list-tasks --cluster "${service_cluster}" --service-name vayada-hotel-setup-property-service --desired-status RUNNING --region "${region}" --query taskArns --output json)"
  jq -e 'length==0' <<<"$running" >/dev/null || return 1
  stopped="$(aws ecs list-tasks --cluster "${service_cluster}" --service-name vayada-hotel-setup-property-service --desired-status STOPPED --region "${region}" --query taskArns --output json)"
  jq -e 'length<=100' <<<"$stopped" >/dev/null || return 1
  if [[ "$(jq length <<<"$stopped")" != 0 ]]; then
    physical="$(aws ecs describe-tasks --cluster "${service_cluster}" --tasks $(jq -r '.[]' <<<"$stopped") --region "${region}" --output json)"
    jq -e --argjson count "$(jq length <<<"$stopped")" '(.failures|length)==0 and (.tasks|length)==$count and
      all(.tasks[]; .group=="service:vayada-hotel-setup-property-service" and .desiredStatus=="STOPPED" and .lastStatus=="STOPPED")' <<<"$physical" >/dev/null || return 1
  fi
}
logo_cleanup_release_gate || { echo "Logo cleanup requires blocked admission and physically stopped private tasks." >&2; exit 1; }
temporary_definition="$(jq -c --arg family "${family}" --arg container "${container}" --argjson definition_environment "$definition_environment" \
  --arg secret_name "${secret_name}" --arg secret_parameter "${secret_parameter}" --arg log_group "${log_group}" \
  --arg extra_secret_name "${extra_secret_name}" --arg extra_secret_parameter "${extra_secret_parameter}" --arg channex_image "${channex_image}" --arg task_image "${task_image}" --arg creation_task_role "${creation_task_role}" --arg creation_execution_role "${creation_execution_role}" '
  del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)
  | del(.taskRoleArn)
  | if $creation_task_role == "" then . else .taskRoleArn=$creation_task_role end
  | if $creation_execution_role == "" then . else .executionRoleArn=$creation_execution_role end
  | .family=$family
  | .containerDefinitions=[.containerDefinitions[]|select(.name==$container)
      | .logConfiguration.options["awslogs-group"]=$log_group
      | .secrets=[{name:$secret_name,valueFrom:$secret_parameter}]
      | if $extra_secret_name == "" then . else .secrets += [{name:$extra_secret_name,valueFrom:$extra_secret_parameter}] end
      | if $task_image != "" then .image=$task_image elif $channex_image != "" then .image=$channex_image else . end
      | .environment=$definition_environment
      | .portMappings=[]]
' <<<"${source_definition}")"
if [[ -n "$reader_rls_mode" || -n "$legacy_helper_mode" || ( "${mode}" == "--audit-hotel-setup-readiness-migrations" || "${mode}" == "--inspect-hotel-setup-logo-migration" ) || ( "${mode}" == "--cleanup-hotel-setup-logo" || "${mode}" == "--stage-hotel-setup-logo-migration-scope" ) ]]; then
  temporary_definition="$(jq -c 'del(.volumes) | .containerDefinitions |= map(
    del(.entryPoint,.mountPoints,.volumesFrom,.environmentFiles) | .workingDirectory="/app" | .privileged=false)' <<<"${temporary_definition}")"
fi

registered_task=""
task_arn=""
cleanup() {
  if [[ -n "${task_arn}" ]]; then
    aws ecs stop-task --cluster "${cluster}" --task "${task_arn}" --region "${region}" \
      --reason "VAY-2017 runtime preflight cleanup" >/dev/null 2>&1 || true
  fi
  if [[ -n "${registered_task}" ]]; then
    aws ecs deregister-task-definition --task-definition "${registered_task}" --region "${region}" >/dev/null || true
  fi
}
trap cleanup EXIT
registered_task="$(aws ecs register-task-definition --cli-input-json "${temporary_definition}" --region "${region}" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"

network="$(aws ecs describe-services --cluster "${service_cluster}" --services "${service}" --region "${region}" \
  --query 'services[0].networkConfiguration' --output json)"
logo_cleanup_release_gate || { echo "Protected logo release gate changed before task launch; inspection required." >&2; exit 1; }
task_arn="$(aws ecs run-task --cluster "${cluster}" --task-definition "${registered_task}" --launch-type FARGATE \
  --network-configuration "${network}" --overrides "${overrides}" \
  --tags key=VayadaPurpose,value=target-db-runtime-preflight --region "${region}" \
  --query 'tasks[0].taskArn' --output text)"
[[ "${task_arn}" == arn:aws:ecs:*:task/* ]] || { echo "ECS did not return a runtime preflight task ARN." >&2; exit 1; }

stopped=false
max_polls=60
[[ "${mode}" == "--import-vay2017-source-snapshot" ]] && max_polls=180
for ((poll = 0; poll < max_polls; poll += 1)); do
  logo_cleanup_release_gate || { echo "Logo cleanup release gate changed; inspection required." >&2; exit 1; }
  status="$(aws ecs describe-tasks --cluster "${cluster}" --tasks "${task_arn}" --region "${region}" \
    --query 'tasks[0].lastStatus' --output text)"
  if [[ "${status}" == "STOPPED" ]]; then
    stopped=true
    break
  fi
  sleep 5
done
if [[ "${stopped}" != true ]]; then
  [[ "${mode}" == "--import-vay2017-source-snapshot" ]] && message="Source snapshot import exceeded fifteen minutes." || message="Runtime preflight task exceeded five minutes."
  echo "${message}" >&2
  exit 1
fi
logo_cleanup_release_gate || { echo "Logo cleanup release gate changed; inspection required." >&2; exit 1; }
task_id="${task_arn##*/}"
log_stream="ecs/${container}/${task_id}"
messages="[]"
vay2017_expected_status=""
if [[ -n "$logo_cleanup_phase" ]]; then
  [[ "$logo_cleanup_phase" == plan ]] && vay2017_expected_status="PLAN" || vay2017_expected_status="PASS"
fi
if [[ -n "$logo_recovery_phase" ]]; then
  [[ "$logo_recovery_phase" == inspect ]] && vay2017_expected_status="PLAN" || vay2017_expected_status="PASS"
fi
if [[ -n "$logo_reader_phase" ]]; then
  [[ "$logo_reader_phase" == inspect ]] && vay2017_expected_status="PLAN" || vay2017_expected_status="PASS"
fi
if [[ "${vay2017_phase}" == "prepare" ]]; then vay2017_expected_status="prepared";
elif [[ "${vay2017_phase}" == "execute" ]]; then vay2017_expected_status="complete";
elif [[ "${vay2017_phase}" == "cleanup" ]]; then vay2017_expected_status="clean";
elif [[ "${vay2017_source_import_phase}" == "prepare" ]]; then vay2017_expected_status="prepared";
elif [[ "${vay2017_source_import_phase}" == "extract" ]]; then vay2017_expected_status="complete";
elif [[ "${vay2017_source_import_phase}" == "cleanup" ]]; then vay2017_expected_status="clean";
fi
task="$(aws ecs describe-tasks --cluster "${cluster}" --tasks "${task_arn}" --region "${region}" \
  --query 'tasks[0].{exitCode:containers[0].exitCode,reason:stoppedReason}' --output json)"
for _ in {1..10}; do
  messages="$(aws logs get-log-events --log-group-name "${log_group}" --log-stream-name "${log_stream}" \
    --start-from-head --region "${region}" --query 'events[].message' --output json 2>/dev/null || echo '[]')"
  jq -e --arg logo_reader "$logo_reader_phase" --arg expected "${vay2017_expected_status}" --arg reader "$reader_rls_mode" --arg exit "$(jq -r '.exitCode' <<<"${task}")" \
    'if type != "array" then false elif $reader == "inspect" and $exit == "1" then length > 0
      else any(.[]; fromjson? | select(type == "object") | .status == "PASS" or .status == "BLOCKED" or
        ((.scope=="hotel_setup_approved_legacy_helper_repair" or .scope=="hotel_setup_tenant_helpers") and (.status=="UNCERTAIN" or .status=="COMMITTED_UNVERIFIED")) or
        ($logo_reader != "" and .scope=="hotel_setup_logo_reader_cutover" and (.status=="FAIL" or .status=="UNCERTAIN" or .status=="COMMITTED_UNVERIFIED")) or
        ($expected != "" and .status == $expected)) end' <<<"${messages}" >/dev/null 2>&1 && break
  sleep 2
done

if [[ -n "$logo_reader_phase" ]]; then
  if [[ "$(jq -r '.exitCode' <<<"$task")" != 0 ]]; then
    jq -c '.[]|fromjson?|select(.scope=="hotel_setup_logo_reader_cutover" and
      (.status=="FAIL" or .status=="UNCERTAIN" or .status=="COMMITTED_UNVERIFIED"))|
      {status,scope,stage:(if (.stage|type)=="string" and (.stage|test("^[a-z_]{1,40}$")) then .stage else null end),
       sqlState:(if (.sqlState|type)=="string" and (.sqlState|test("^[A-Z0-9]{5}$")) then .sqlState else null end)}' <<<"$messages"
    echo "Property reader cutover requires inspection." >&2; exit 1
  fi
  jq -ce --arg phase "$logo_reader_phase" --arg expected "$vay2017_expected_status" --arg frozen "$logo_reader_frozen" '
    [.[]|fromjson?|select(type=="object" and .status==$expected and .scope=="hotel_setup_logo_reader_cutover" and
      .phase==$phase and .login=="vayada_next_hotel_setup_reader" and .businessWrites==false and
      (.roleOid|type=="number" and floor==. and .>0 and .<=4294967295) and
      (if $phase=="verify" then keys==["businessWrites","login","phase","roleOid","scope","status"] and .roleOid==($frozen|tonumber)
       else keys==["businessWrites","fingerprint","login","missingColumns","phase","roleOid","scope","status"] and
        (.fingerprint|test("^[a-f0-9]{64}$")) and ($phase=="inspect" or .fingerprint==$frozen) and
        (.missingColumns|type=="array" and length<=9 and length==(unique|length) and all(.[]; . as $column |
          (["platform.hotel_setup_property_scopes:actor_user_id:SELECT"]+
           (["id","actor_user_id","owner_organization_id","requested_purpose","property_id","resource_product","resource_type","resource_id"]|
             map("platform.media_upload_sessions:"+.+":SELECT")))|index($column)!=null)) end))]|select(length==1)|.[0]' <<<"$messages" || {
    echo "Property reader cutover returned invalid evidence; inspection required." >&2; exit 1;
  }
  exit 0
fi

if [[ -n "$logo_recovery_phase" ]]; then
  if [[ "$(jq -r '.exitCode' <<<"$task")" != 0 ]]; then
    jq -c '.[] | fromjson? | select(.scope=="hotel_setup_logo_staged_recovery" and
      (.status=="FAIL" or .status=="UNCERTAIN" or .status=="COMMITTED_UNVERIFIED")) |
      {status,scope,stage:(if (.stage|type)=="string" and (.stage|test("^[a-z_]{1,40}$")) then .stage else null end),
       sqlState:(if (.sqlState|type)=="string" and (.sqlState|test("^[A-Z0-9]{5}$")) then .sqlState else null end)}' <<<"$messages"
    echo "Staged logo role recovery requires inspection." >&2; exit 1
  fi
  jq -ce --arg phase "$logo_recovery_phase" --arg expected "$vay2017_expected_status" --arg frozen "$logo_recovery_frozen" '
    [.[] | fromjson? | select(type=="object" and keys==["businessWrites","fingerprint","login","phase","roleOid","roleRemoved","scope","status"] and
      .status==$expected and .scope=="hotel_setup_logo_staged_recovery" and .phase==$phase and
      .login=="vayada_next_hotel_setup_logo_37f915790bff5732_072438f4e0a8" and .roleOid==247978 and
      .roleRemoved==($phase=="apply") and .businessWrites==false and (.fingerprint|test("^[a-f0-9]{64}$")) and
      ($frozen=="" or .fingerprint==$frozen))] | select(length==1) | .[0]' <<<"$messages" || {
      echo "Staged logo recovery returned invalid evidence; inspection required." >&2; exit 1;
  }
  exit 0
fi
if [[ "${mode}" == "--stage-hotel-setup-logo-migration-scope" ]]; then
  stage_label="Logo"; stage_migration="0466"; stage_role="vayada_next_hotel_setup_logo_scope"
  if [[ -n "$profile_scope" ]]; then
    stage_label="Profile"; stage_migration="0470"; stage_role="vayada_next_hotel_setup_profile_scope"
  fi
  [[ "$(jq -r '.exitCode' <<<"$task")" == 0 ]] || { echo "${stage_label} parent staging requires inspection." >&2; exit 1; }
  jq -ce --arg migration "$stage_migration" --arg role "$stage_role" '[.[] | fromjson? | select((.scopeIncomingMemberships==0 or .scopeIncomingMemberships==1) and .=={status:"PASS",migration:$migration,scopeRole:$role,
    login:false,businessGrantsAdded:false,migrationOwner:"vayada_target_prod_user",
    migrationOwnerCanCreateRole:false,creatorAdminOnlyMembership:true,scopeIncomingMemberships:.scopeIncomingMemberships})] | select(length==1) | .[0]' <<<"$messages" || {
    echo "${stage_label} parent staging returned invalid evidence; inspection required." >&2; exit 1;
  }
  exit 0
fi
if [[ -n "$logo_cleanup_phase" ]]; then
  [[ "$(jq -r '.exitCode' <<<"$task")" == 0 ]] || { echo "Logo cleanup requires recovery inspection." >&2; exit 1; }
  jq -ce --arg expected "$vay2017_expected_status" --arg kind "$logo_cleanup_kind" --arg target "$logo_cleanup_target" --arg hash "$logo_cleanup_hash" '
    [.[] | fromjson? | select(type=="object" and keys==["keyCount","kind","manifestSha256","status","targetId"] and
      .status==$expected and .kind==$kind and .targetId==$target and (.manifestSha256|test("^[a-f0-9]{64}$")) and
      ($hash=="" or .manifestSha256==$hash) and (.keyCount|type=="number" and floor==. and .>=0))] |
    select(length==1) | .[0]' <<<"$messages" || { echo "Logo cleanup returned invalid evidence; inspection required." >&2; exit 1; }
  exit 0
fi
if [[ "$legacy_helper_scope" == hotel_setup_legacy_helper_inspection && -n "$legacy_helper_mode" && "$(jq -r '.exitCode' <<<"${task}")" == "2" ]]; then
  blocked="$(jq -c --arg mode "$legacy_helper_mode" '.[] | fromjson? | select(.status == "BLOCKED" and .scope == "hotel_setup_legacy_helper_inspection" and .mode == $mode)' <<<"${messages}")"
  [[ -n "$blocked" ]] || exit 1
  printf '%s\n' "$blocked"
  exit 2
fi
if [[ "${mode}" == "--audit-financials-readiness" && "$(jq -r '.exitCode' <<<"${task}")" == "2" ]]; then
  blocked="$(jq -c '.[] | fromjson? | select(.status == "BLOCKED" and .readiness.status == "blocked")' <<<"${messages}")"
  [[ -n "${blocked}" ]] || { echo "Financials readiness task exited without a blocked report." >&2; exit 1; }
  jq -c --arg task_definition "${current_task}" --arg image_digest "${financials_readiness_image_digest}" \
    '. + {sourceTaskDefinition:$task_definition,sourceImageDigest:$image_digest}' <<<"${blocked}"
  exit 2
fi
if [[ ( "$legacy_helper_scope" == hotel_setup_approved_legacy_helper_repair || "$legacy_helper_scope" == hotel_setup_tenant_helpers ) && "$(jq -r '.exitCode' <<<"${task}")" != "0" ]]; then
  # Project only fixed outcome fields; never relay secrets or arbitrary task errors.
  outcome="$(jq -c --arg scope "$legacy_helper_scope" '.[] | fromjson? | select(.scope==$scope and
    (.status=="UNCERTAIN" or .status=="COMMITTED_UNVERIFIED")) | .catalog as $catalog |
    {status,scope,catalog:(if (["unavailable","unexpected","unchanged","exact_granted","changed","unchanged_since_commit"]|index($catalog)) then .catalog else "unavailable" end),
     nativeProof:"unverified"} | if .status=="COMMITTED_UNVERIFIED" then .+{committed:true} else . end' <<<"${messages}")"
  [[ -z "$outcome" ]] || printf '%s\n' "$outcome" >&2
  exit 2
fi
[[ "$(jq -r '.exitCode' <<<"${task}")" == "0" ]] || {
  if [[ "$reader_rls_mode" == inspect ]]; then
    # Admit only the fixed inspect diagnostic schema; never relay arbitrary error text.
    diagnostic="$(jq -c '
      def hash: if . == null then true elif type == "string" then test("^[a-f0-9]{64}$") else false end;
      def checks: ["identityCount","principalMatches","sessionMatches","primary","readerCount",
        "login","noInherit","noSuperuser","noCreateRole","noCreateDatabase","noReplication","noBypassRls",
        "noReaderParentMembership","helperCount","signatureMatches","bodyMatches","invoker","stable",
        "ownerNotReader","parallelUnsafe","functionKind","notLeakproof","notStrict","argumentCount",
        "defaultCount","booleanResult","notSetReturning","notVariadic","noAllArgTypes","noArgModes",
        "noSupportFunction","argumentTypes","argumentNames","searchPath","defaultExpression","language",
        "grantAuthority","noPublicExecute","noReaderGrantOption","lockAcquired","urlParsed","githubActions",
        "main","protocol","host","port","username","database","passwordPresent","noFragment","sslQuery",
        "caPresent","connectionValid"];
      .[] | fromjson? | select(type == "object") | select(keys == ["code","diagnostic","mode","scope","status"] and
        .status == "FAIL" and .scope == "hotel_setup_reader_rls_permissions" and .mode == "inspect" and
        .code == "hotel_setup_reader_rls_permission_unavailable") |
      select(.diagnostic | type == "object") |
      select(.diagnostic.checks | type == "object") |
      select(.diagnostic | keys == ["bodyHash","checks","definitionHash","lockAcquired","oid","predicate","sqlState","stage","subject"]) |
      select(.diagnostic | .stage as $stage | ["environment","connect","mode","lock","transaction","identity",
        "readers","memberships","functions","helper","acl","rollback","completion"] | index($stage)) |
      select(.diagnostic | .predicate as $predicate | checks + ["sql_error","unexpected"] | index($predicate)) |
      select(.diagnostic | (.lockAcquired == null or (.lockAcquired | type == "boolean")) and
        (.oid | if . == null then true elif type == "number" then floor == . and . > 0 and . <= 4294967295 else false end) and
        (.sqlState | if . == null then true elif type == "string" then test("^[A-Z0-9]{5}$") else false end) and
        (.bodyHash | hash) and (.definitionHash | hash) and
        (.subject == null or (.subject as $subject | ["vayada_next_hotel_setup_creation_reader","vayada_next_hotel_setup_reader",
          "platform.channex_management_worker_scope(text,text,uuid)","platform.channex_management_worker_source(text,text,uuid)"] | index($subject))) and
        (.checks | type == "object" and ([keys[]] - checks | length == 0) and all(.[]; type == "boolean")))
      ' <<<"${messages}" 2>/dev/null)" || diagnostic=""
    if [[ -n "$diagnostic" && "$(wc -l <<<"$diagnostic" | tr -d ' ')" == 1 ]]; then
      printf '%s\n' "$diagnostic" >&2
    else echo hotel_setup_reader_rls_permission_unavailable >&2; fi
  else
    echo "Runtime preflight task failed: $(jq -r '.reason' <<<"${task}")" >&2
    jq -r '.[] | fromjson? | select(.status == "FAIL" or .status == "failed") | .code' <<<"${messages}" >&2
  fi
  exit 1
}
if [[ -n "$legacy_helper_mode" ]]; then
  result="$(jq -c --arg mode "$legacy_helper_mode" --arg scope "$legacy_helper_scope" '.[] | fromjson? | select(.status == "PASS" and .scope == $scope and .mode == $mode)' <<<"${messages}")"
elif [[ -n "${vay2017_expected_status}" ]]; then
  result="$(jq -c --arg expected "${vay2017_expected_status}" '.[] | fromjson? | select(.status == $expected)' <<<"${messages}")"
else
  result="$(jq -c '.[] | fromjson? | select(.status == "PASS")' <<<"${messages}")"
fi
[[ -n "${result}" ]] || { echo "Runtime preflight exited without its completion report." >&2; exit 1; }
if [[ "${mode}" == "--audit-financials-readiness" ]]; then
  result="$(jq -c --arg task_definition "${current_task}" --arg image_digest "${financials_readiness_image_digest}" \
    '. + {sourceTaskDefinition:$task_definition,sourceImageDigest:$image_digest}' <<<"${result}")"
fi
printf '%s\n' "${result}"
