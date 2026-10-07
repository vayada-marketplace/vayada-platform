#!/usr/bin/env python3
import base64
import gzip
from pathlib import Path
import unittest
import tempfile
import subprocess
import os


ROOT = Path(__file__).resolve().parents[1]
RUNNER = (ROOT / "scripts/run-target-database-runtime-preflight.sh").read_text()
GRANT = (ROOT / "scripts/grant-target-database-product-audit-insert.mjs").read_text()
IAM = (ROOT / "infra/target_database_preflight_iam.tf").read_text()
VAY2017_WORKFLOW = (ROOT / ".github/workflows/vay2017-historical-binding-preflight.yml").read_text()
VAY2017_IMPORT = (ROOT / "scripts/vay2017-source-snapshot-import.mjs").read_text()
VAY2017_EXTRACT = (ROOT / "scripts/vay2017-source-snapshot-extract.mjs").read_text()
VAY2017_IMPORT_WORKFLOW = (ROOT / ".github/workflows/vay2017-source-snapshot-import.yml").read_text()


class RuntimePreflightRunnerTest(unittest.TestCase):
    def test_vay2017_preflight_uses_ephemeral_external_signing_and_always_cleans_up(self) -> None:
        self.assertIn('--preflight-vay2017-historical-bindings)', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/db-marketplace-url"', RUNNER)
        self.assertIn('del(.taskRoleArn)', RUNNER)
        self.assertIn('legacyHistoricalBindingProductionPreflight.js', RUNNER)
        self.assertIn('generateKeyPairSync("ed25519")', VAY2017_WORKFLOW)
        self.assertIn('vay2017-private.pem', VAY2017_WORKFLOW)
        self.assertIn('f6beaed255ef6a83509948c297f19cab7e62c499', VAY2017_WORKFLOW)
        self.assertIn('sha256:8caa417dfa8eb4822c37a9169f982795691d6dcbb1080b06a8530aba6c52b4ed', VAY2017_WORKFLOW)
        self.assertIn('if: always() && steps.verify.outcome == \'success\'', VAY2017_WORKFLOW)
        self.assertIn('cleanup "$DIGEST" "$SOURCE"', VAY2017_WORKFLOW)
        self.assertNotIn('TARGET_DATABASE_ADMIN_URL:', VAY2017_WORKFLOW)
        self.assertNotIn('{name:"APPLICATION_RELEASE",value:$vay2017_source_sha}', RUNNER)

    def test_vay2017_snapshot_import_is_exact_bounded_and_cleanup_capable(self) -> None:
        self.assertIn('--import-vay2017-source-snapshot)', RUNNER)
        self.assertIn('vay1351-61ec013e79ed2a042caadef8', RUNNER)
        self.assertIn('/vayada/prod/vay2017-source-import-url', RUNNER)
        self.assertIn('max_polls=180', RUNNER)
        self.assertIn('del(.taskRoleArn)', RUNNER)
        self.assertIn('vay2017-source-import-20260929.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com', VAY2017_IMPORT)
        self.assertIn('arn:aws:rds:eu-west-1:269416271598:snapshot:vay2017-legacy-source-20260929', VAY2017_IMPORT)
        self.assertIn("environment: 'preprod'", VAY2017_EXTRACT)
        self.assertIn("'/app/packages/backend-migration/dist/cli/sourceExtract.js'", VAY2017_EXTRACT)
        self.assertIn("url.searchParams.set('sslmode', 'verify-full')", VAY2017_EXTRACT)
        self.assertIn("url.searchParams.set('sslrootcert', CA_FILE)", VAY2017_EXTRACT)
        self.assertIn('6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86', VAY2017_EXTRACT)
        self.assertNotIn('rejectUnauthorized: false', VAY2017_EXTRACT)
        self.assertIn('ALTER ROLE ${identifier(READER)} NOLOGIN', VAY2017_IMPORT)
        self.assertIn("const ATTESTOR = 'vay2017_source_attestor_20260929'", VAY2017_IMPORT)
        self.assertNotIn("const ATTESTOR = 'vayada_migration_attestor'", VAY2017_IMPORT)
        self.assertIn("namespace.nspname='vayada_migration_evidence'", VAY2017_IMPORT)
        self.assertIn('source_attestor_membership_cleanup_unsafe', VAY2017_IMPORT)
        self.assertIn('WHERE to_regclass(name) IS NOT NULL', VAY2017_IMPORT)
        self.assertIn("await client.query('DROP SCHEMA vayada_migration_evidence')", VAY2017_IMPORT)
        self.assertIn('75 * 60 * 1000', VAY2017_IMPORT)
        for source in (VAY2017_IMPORT, VAY2017_EXTRACT):
            encoded = base64.b64encode(gzip.compress(source.encode(), compresslevel=9, mtime=0))
            self.assertLessEqual(len(encoded) + 1460 + 1024, 8192)
        self.assertIn('environment: platform-mutations-v2', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('if: always() && steps.verify.outcome == \'success\'', VAY2017_IMPORT_WORKFLOW)
        self.assertEqual(VAY2017_IMPORT_WORKFLOW.count('--import-vay2017-source-snapshot'), 3)
        self.assertIn('RestoreDBInstanceFromDBSnapshot', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('role/vayada-github-actions-vay2042-source-reader', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('environment: vay2042-data-rehearsal', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('inline-session-policy:', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('["rds:DescribeDBInstances","rds:DescribeDBSnapshots","cloudtrail:LookupEvents"]', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('needs: authorize-import', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('needs: verify-source', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('now - VERIFIED_AT <= 180', VAY2017_IMPORT_WORKFLOW)
        self.assertNotIn('--with-decryption', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('f6beaed255ef6a83509948c297f19cab7e62c499', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('sha256:8caa417dfa8eb4822c37a9169f982795691d6dcbb1080b06a8530aba6c52b4ed', VAY2017_IMPORT_WORKFLOW)
        self.assertIn('(if $vay2017_source_import_phase == "extract" then [{name:"SOURCE_ATTESTATION_OWNER",value:"vay2017_source_attestor_20260929"}] else [] end)', RUNNER)
        self.assertNotIn('__APP_', VAY2017_IMPORT_WORKFLOW)

    def test_vay2017_snapshot_import_rejects_bad_inputs_without_echoing_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            importer = Path(directory) / 'import.mjs'
            importer.write_text(VAY2017_EXTRACT)
            secret = 'must-not-appear'
            result = subprocess.run(
                ['node', str(importer)], capture_output=True, text=True,
                env={
                    **os.environ,
                    'VAY2017_SOURCE_IMPORT_PHASE': 'extract',
                    'VAYADA_DB_RDS_CA_BUNDLE': (ROOT / 'rehearsal/rds-ca-rsa2048-g1.pem').read_text(),
                    'VAY2017_SOURCE_READER_URL': f'postgresql://wrong:{secret}@wrong.invalid:5432/postgres?sslmode=require',
                    'TARGET_DATABASE_MIGRATION_URL': 'postgresql://migration:x@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod?sslmode=require',
                },
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"code":"source_import_url_invalid"', result.stderr)
        self.assertNotIn(secret, result.stderr)
        invalid = subprocess.run(
            ['bash', str(ROOT / 'scripts/run-target-database-runtime-preflight.sh'),
             '--import-vay2017-source-snapshot', 'extract', f'sha256:{"a" * 64}', 'b' * 40,
             'vay1351-deadbeefdeadbeefdeadbeef', '1-1'], capture_output=True, text=True,
        )
        self.assertEqual(invalid.returncode, 2)
        self.assertIn('pinned run ID', invalid.stderr)

    def test_temporary_task_receives_only_the_runtime_database_secret(self) -> None:
        self.assertIn('secret_name="TARGET_DATABASE_URL"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/target-database-runtime-url"', RUNNER)
        self.assertIn('.secrets=[{name:$secret_name,valueFrom:$secret_parameter}]', RUNNER)
        for secret in ("CHANNEX_API_KEY", "STRIPE_SECRET_KEY", "WORKOS_API_KEY"):
            self.assertNotIn(secret, RUNNER)
        self.assertIn("del(.taskRoleArn)", RUNNER)

    def test_audit_grant_uses_only_the_owner_secret_in_explicit_mode(self) -> None:
        self.assertIn('--grant-product-audit-insert|--grant-affiliate-read|--grant-finance-affiliate-read|--grant-platform-runtime-read|--grant-property-profile-lock|--grant-domain-events-append|--grant-jobs-insert|--grant-expense-category-insert|--grant-expense-insert|--grant-recurring-expense-insert|--grant-folio-command)', RUNNER)
        self.assertIn('grant_scope="audit_insert"', RUNNER)
        self.assertIn('grant_scope="affiliate_read"', RUNNER)
        self.assertIn('grant_scope="finance_affiliate_read"', RUNNER)
        self.assertIn('grant_scope="platform_runtime_read"', RUNNER)
        self.assertIn('grant_scope="property_profile_lock"', RUNNER)
        self.assertIn('grant_scope="domain_events_append"', RUNNER)
        self.assertIn('grant_scope="jobs_insert"', RUNNER)
        self.assertIn('grant_scope="expense_category_insert"', RUNNER)
        self.assertIn('grant_scope="expense_insert"', RUNNER)
        self.assertIn('grant_scope="recurring_expense_insert"', RUNNER)
        self.assertIn('secret_name="TARGET_DATABASE_MIGRATION_URL"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/target-database-url"', RUNNER)
        self.assertIn('code_file="grant-target-database-product-audit-insert.mjs"', RUNNER)
        self.assertLess(RUNNER.index('code_file="grant-target-database-product-audit-insert.mjs"'),
                        RUNNER.index('if [[ "${mode}" == "--grant-affiliate-read" ]]'))
        self.assertIn('ssl = { ca, rejectUnauthorized: true, servername: connectionUrl.hostname }', GRANT)
        self.assertIn('VAYADA_AUDIT_GRANT_LOCAL_FIXTURE', GRANT)
        self.assertIn('unexpected_database_host', GRANT)
        self.assertEqual(GRANT.count('await assertAuditWriteScope(client, supportsMaintain)'), 2)
        self.assertIn('SET search_path TO pg_catalog', GRANT)
        self.assertIn('VAYADA_DB_RDS_CA_BUNDLE', RUNNER)
        self.assertIn('0fdc44d91c5a69ef4efc3f9ede636ccc22b11a890c5a656a134275da26afa812', RUNNER)

    def test_task_is_bounded_and_cleaned_up(self) -> None:
        self.assertIn("trap cleanup EXIT", RUNNER)
        self.assertIn("aws ecs stop-task", RUNNER)
        self.assertIn("aws ecs deregister-task-definition", RUNNER)
        self.assertIn("Runtime preflight task exceeded five minutes", RUNNER)

    def test_financials_readiness_is_property_scoped_and_read_only(self) -> None:
        source = (ROOT / 'scripts/financials-activation-readiness.mjs').read_text()
        self.assertIn('--audit-financials-readiness)', RUNNER)
        self.assertIn('financials_readiness_property="$2"', RUNNER)
        self.assertIn('code_file="financials-activation-readiness.mjs"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/target-database-url"', RUNNER)
        self.assertIn('FINANCIALS_READINESS_PROPERTY_ID', RUNNER)
        self.assertIn('runFinancialsActivationReadiness', source)
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', source)
        self.assertIn('expectedModuleState: "inactive"', source)
        self.assertIn('rejectUnauthorized: true', source)
        self.assertIn('if (readiness.status === "blocked") process.exitCode = 2', source)
        self.assertIn('select(.status == "BLOCKED" and .readiness.status == "blocked")', RUNNER)
        self.assertIn('exit 2', RUNNER)
        self.assertNotIn('INSERT INTO', source)
        self.assertNotIn('UPDATE ', source)
        self.assertNotIn('DELETE FROM', source)
        encoded = base64.b64encode(gzip.compress(source.encode(), compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded) + 2100 + 1400, 8192)
        invalid = subprocess.run(
            ['bash', str(ROOT / 'scripts/run-target-database-runtime-preflight.sh'),
             '--audit-financials-readiness', 'not-a-uuid'],
            capture_output=True, text=True,
        )
        self.assertEqual(invalid.returncode, 2)
        self.assertIn('requires one property UUID', invalid.stderr)

    def test_identity_modes_use_only_owner_and_dedicated_identity_secrets(self) -> None:
        self.assertIn('--provision-identity-role|--grant-identity-runtime|--inspect-identity-role|--inspect-cluster-database-acl|--harden-cluster-database-acl)', RUNNER)
        self.assertIn('code_file="provision-target-database-identity-runtime.mjs"', RUNNER)
        self.assertIn('secret_name="TARGET_DATABASE_ADMIN_URL"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/db-marketplace-url"', RUNNER)
        self.assertIn('code_file="grant-target-database-identity-runtime.mjs"', RUNNER)
        self.assertIn('code_file="inspect-target-database-identity-role.mjs"', RUNNER)
        self.assertIn('code_file="inspect-target-database-cluster-acl.mjs"', RUNNER)
        self.assertIn('code_file="harden-target-database-cluster-acl.mjs"', RUNNER)
        inspect_branch = RUNNER.split('elif [[ "${mode}" == "--inspect-identity-role" ]]', 1)[1].split('else', 1)[0]
        self.assertNotIn('extra_secret_name=', inspect_branch)
        self.assertIn('extra_secret_name="IDENTITY_DATABASE_URL"', RUNNER)
        self.assertIn('extra_secret_parameter="/vayada/prod/target-database-identity-runtime-url"', RUNNER)
        self.assertIn('.secrets += [{name:$extra_secret_name,valueFrom:$extra_secret_parameter}]', RUNNER)
        self.assertNotIn('secret_name="AUTH_DATABASE_URL"', RUNNER)

    def test_hotel_setup_role_uses_only_admin_secret_and_fits_override_budget(self) -> None:
        branch = RUNNER.split('  --provision-hotel-setup-scope)', 1)[1].split('    ;;', 1)[0]
        self.assertIn('[[ "$#" -eq 1 ]]', branch)
        self.assertIn('code_file="provision-hotel-setup-scope-role.mjs"', branch)
        self.assertIn('secret_name="TARGET_DATABASE_ADMIN_URL"', branch)
        self.assertIn('secret_parameter="/vayada/prod/db-marketplace-url"', branch)
        self.assertNotIn('extra_secret_', branch)
        source = (ROOT / 'scripts/provision-hotel-setup-scope-role.mjs').read_bytes()
        encoded = base64.b64encode(gzip.compress(source, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded) + 2100 + 1024, 8192)

    def test_identity_grant_pins_one_ca_and_fits_override_budget(self) -> None:
        self.assertIn('ca_bundle="${ca_bundle%%-----END CERTIFICATE-----*}-----END CERTIFICATE-----"', RUNNER)
        self.assertIn('6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86', RUNNER)
        self.assertIn('${#ca_payload}" -gt 2100', RUNNER)
        grant_code = (ROOT / 'scripts/grant-target-database-identity-runtime.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_cluster_acl_hardener_pins_one_ca_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--harden-cluster-database-acl"'), 3)
        hardener = (ROOT / 'scripts/harden-target-database-cluster-acl.mjs').read_bytes()
        encoded = base64.b64encode(gzip.compress(hardener, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded) + 2100 + 1024, 8192)

    def test_expense_category_grant_reuses_pinned_ca_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-expense-category-insert"'), 3)
        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_folio_command_grant_has_own_bounded_payload(self) -> None:
        self.assertIn('code_file="grant-target-database-folio-command.mjs"', RUNNER)
        self.assertNotIn('code_file="${code_file:-', RUNNER)
        grant_code = (ROOT / 'scripts/grant-target-database-folio-command.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_affiliate_read_grant_reuses_pinned_ca_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-affiliate-read"'), 3)
        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_finance_affiliate_read_grant_is_exact_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-finance-affiliate-read"'), 3)
        for table in (
            "finance.affiliate_earning_reconciliation_revisions",
            "finance.affiliate_eligible_earning_revisions",
            "finance.affiliate_earning_allocations",
            "finance.affiliate_earning_allocation_items",
        ):
            self.assertIn(f'"{table}"', GRANT)
        self.assertIn('finance_affiliate_runtime_scope_too_broad', GRANT)
        self.assertIn('VAYADA_FINANCE_AFFILIATE_GRANT_FORCE_POST_GRANT_FAILURE', GRANT)
        self.assertIn('SELECT WITH GRANT OPTION', GRANT)
        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_platform_runtime_read_grant_is_narrow_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-platform-runtime-read"'), 3)
        self.assertIn('"platform.pricing_runtime_property_scopes"', GRANT)
        self.assertIn('"platform.channex_management_worker_properties"', GRANT)
        self.assertIn('platform_runtime_scope_too_broad', GRANT)
        self.assertIn('SELECT WITH GRANT OPTION', GRANT)
        self.assertIn('VAYADA_PLATFORM_RUNTIME_GRANT_FORCE_POST_GRANT_FAILURE', GRANT)
        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_property_profile_lock_grant_is_column_scoped_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-property-profile-lock"'), 3)
        self.assertIn('GRANT UPDATE (id) ON ${table} TO vayada_next_api_runtime', GRANT)
        self.assertIn('property_profile_runtime_lock_scope_too_broad', GRANT)
        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_finance_modes_keep_scope_explicit_and_fit_task_override(self) -> None:
        self.assertIn('--provision-finance-expense-worker|--grant-finance-expense-worker|--preflight-finance-expense-worker)', RUNNER)
        self.assertIn('finance_property="$2"', RUNNER)
        self.assertIn('provision_scope="finance_expense"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/target-database-finance-expense-worker-url"', RUNNER)
        for filename in ('finance-expense-worker-database.mjs', 'provision-target-database-identity-runtime.mjs'):
            encoded = base64.b64encode(gzip.compress((ROOT / 'scripts' / filename).read_bytes(), compresslevel=9, mtime=0))
            self.assertLessEqual(len(encoded) + 2100 + 1400, 8192)
        ecs = (ROOT / 'infra/ecs.tf').read_text()
        self.assertIn('{ name = "FINANCE_EXPENSE_WORKER_ENABLED", value = "false" }', ecs)
        self.assertIn('var.finance_expense_worker_secret_mapped ? [', ecs)
        self.assertIn('{ name = "TARGET_DATABASE_URL", valueFrom = "/vayada/prod/target-database-runtime-url" }', ecs)

    def test_planned_export_activation_fails_closed(self) -> None:
        import runpy
        import json
        mode = runpy.run_path(str(ROOT / 'scripts/planned-finance-export-mode.py'))['mode']
        def plan(containers):
            return {"planned_values": {"root_module": {"resources": [{
                "address": 'aws_ecs_task_definition.services["next-target-backend"]',
                "values": {"container_definitions": json.dumps(containers)}
            }]}}}
        for enabled in ('true', 'false'):
            self.assertEqual(mode(plan([{"name": "vayada-next-api", "environment": [
                {"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": enabled}
            ]}])), enabled)
        for invalid in ({}, plan([]), plan([{"name": "vayada-next-api", "environment": []}]),
                        plan([{"name": "vayada-next-api", "environment": [
                            {"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "unknown"}]}])):
            with self.assertRaises((KeyError, ValueError)):
                mode(invalid)
        unknown = plan([])
        unknown['planned_values']['root_module']['resources'][0]['values']['container_definitions'] = None
        with self.assertRaises(TypeError):
            mode(unknown)

    def test_ongoing_preflight_rejects_an_older_image_before_connecting(self) -> None:
        source = (ROOT / 'scripts/finance-export-worker-database.mjs').read_text()
        source = source.replace('import pg from "pg";', 'const pg = {};')
        source = source.replace('import * as exportBoundary from "/app/apps/api/dist/jobs/financeExportWorkerBoundary.js";', 'const exportBoundary = {};')
        with tempfile.TemporaryDirectory() as directory:
            runner = Path(directory) / 'preflight.mjs'
            runner.write_text(source)
            result = subprocess.run(['node', str(runner)], capture_output=True, text=True,
                                    env={**os.environ, 'FINANCE_EXPORT_WORKER_ONGOING': 'true'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('finance_export_worker_ongoing_image_unsupported', result.stderr)

    def test_export_modes_use_distinct_scope_secret_and_disabled_mapping(self) -> None:
        self.assertIn('--provision-finance-export-worker|--grant-finance-export-worker|--preflight-finance-export-worker|--preflight-finance-export-ongoing)', RUNNER)
        self.assertIn('export_property="$2"', RUNNER)
        self.assertIn('export_id="$3"', RUNNER)
        self.assertIn('provision_scope="finance_export"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/target-database-finance-export-worker-url"', RUNNER)
        for filename in ('finance-export-worker-database.mjs', 'provision-target-database-identity-runtime.mjs'):
            encoded = base64.b64encode(gzip.compress((ROOT / 'scripts' / filename).read_bytes(), compresslevel=9, mtime=0))
            self.assertLessEqual(len(encoded) + 2100 + 1400, 8192)
        export_worker = (ROOT / 'scripts/finance-export-worker-database.mjs').read_text()
        self.assertIn('platform.channex_management_worker_scope(text,text,uuid)', export_worker)
        self.assertNotIn('platform.channex_management_worker_source(text,text,uuid)', export_worker)
        self.assertIn('GRANT EXECUTE ON FUNCTION', export_worker)
        self.assertIn('REVOKE EXECUTE ON FUNCTION ${functionName} FROM PUBLIC', export_worker)
        self.assertIn('REVOKE GRANT OPTION FOR EXECUTE', export_worker)
        self.assertIn('acl.grantee=0', export_worker)
        self.assertIn('NOT acl.is_grantable', export_worker)
        self.assertIn('finance_export_worker_policy_consumer_function_access_missing', export_worker)
        self.assertIn('finance_export_worker_function_scope_too_broad', export_worker)
        self.assertIn("!policyConsumerFunctions.includes(row.function)", export_worker)
        self.assertIn('test(exportId ?? "")', export_worker)
        self.assertIn('ongoing ? { ongoing: true } : { propertyId, exportId }', export_worker)
        ecs = (ROOT / 'infra/ecs.tf').read_text()
        self.assertIn('{ name = "FINANCE_EXPORT_WORKER_ENABLED", value = tostring(var.finance_export_worker_enabled) }', ecs)
        self.assertNotIn('{ name = "FINANCE_EXPORT_WORKER_EXPORT_ID",', ecs)
        self.assertIn('(var.finance_export_worker_secret_mapped || var.finance_export_worker_enabled) ? [', ecs)
        self.assertIn('/vayada/prod/target-database-finance-export-worker-url', ecs)
        export_config = (ROOT / 'infra' / 'finance_export_worker.tf').read_text()
        self.assertIn('variable "finance_export_worker_secret_mapped"', export_config)
        self.assertIn('default     = false', export_config)
        self.assertIn('default     = ""', export_config)
        self.assertIn('Ongoing exports require a fixed cutoff, no exact-property scope and the pinned RDS CA; disabled exports must be unmapped.', ecs)
        self.assertIn('The next-api Financials export activation is limited to exactly one ECS task.', ecs)

        provisioner = (ROOT / 'scripts/provision-target-database-identity-runtime.mjs').read_text()
        self.assertIn('new Map([', provisioner)
        self.assertIn(']).get(scope)', provisioner)

    def test_affiliate_read_grant_reuses_pinned_ca_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-affiliate-read"'), 3)

        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_expense_grant_reuses_pinned_ca_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-expense-insert"'), 3)
        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_recurring_expense_grant_reuses_pinned_ca_and_fits_override_budget(self) -> None:
        self.assertGreaterEqual(RUNNER.count('"${mode}" == "--grant-recurring-expense-insert"'), 3)
        self.assertIn('finance.recurring_expense_rules', GRANT)
        grant_code = (ROOT / 'scripts/grant-target-database-product-audit-insert.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_runtime_product_dml_modes_use_owner_secret_and_definition_environment(self) -> None:
        branch = RUNNER.split('  --grant-runtime-product-dml|--revoke-runtime-product-dml)', 1)[1].split('    ;;', 1)[0]
        self.assertIn('[[ "$#" -eq 1 ]]', branch)
        self.assertIn('code_file="grant-target-database-runtime-product-dml.mjs"', branch)
        self.assertIn('code_in_definition="true"', branch)
        self.assertIn('grant_scope="product_dml"', branch)
        self.assertIn('grant_scope="revoke_product_dml"', branch)
        self.assertIn('secret_name="TARGET_DATABASE_MIGRATION_URL"', branch)
        self.assertIn('secret_parameter="/vayada/prod/target-database-url"', branch)
        self.assertNotIn('extra_secret_', branch)
        self.assertIn('if [[ "$code_in_definition" == true || "$legacy_helper_scope"', RUNNER)
        self.assertIn('  if [[ "$code_in_definition" == true || -n "$reader_rls_mode"', RUNNER)
        preflight = RUNNER.split('  preflight|--preflight-folio-command|--preflight-runtime-product-dml)', 1)[1].split('    ;;', 1)[0]
        self.assertIn('product_dml_required="true"', preflight)
        self.assertIn('code_in_definition="true"', preflight)
        self.assertIn('{name:"VAYADA_DB_REQUIRE_PRODUCT_DML",value:"1"}', RUNNER)
        for mode in ('--grant-runtime-product-dml', '--revoke-runtime-product-dml', '--preflight-runtime-product-dml'):
            invalid = subprocess.run(['bash', str(ROOT / 'scripts/run-target-database-runtime-preflight.sh'), mode, 'unexpected'],
                                     capture_output=True, text=True)
            self.assertEqual(invalid.returncode, 2, mode)
        source = (ROOT / 'scripts/grant-target-database-runtime-product-dml.mjs').read_text()
        for marker in ('runtime_dml_owner_required', 'runtime_role_membership_forbidden',
                       'runtime_identity_lock_only_policy_missing', 'runtime_protected_relation_writable',
                       'runtime_protected_relation_readable', 'runtime_identity_write_scope_too_broad',
                       'runtime_product_dml_missing', 'runtime_default_privileges_missing',
                       'runtime_grant_option_forbidden', 'ALTER DEFAULT PRIVILEGES IN SCHEMA',
                       'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA',
                       'await client.query("BEGIN")', 'ROLLBACK', 'unexpected_database_host', 'rds_ca_missing',
                       'VAYADA_AUDIT_GRANT_LOCAL_FIXTURE', '"revoke_product_dml"'):
            self.assertIn(marker, source)
        for relation in ('platform.hotel_setup_property_scopes', 'platform.identity_migration_provenance',
                         'platform.schema_migrations', 'booking.pricing_authority_heads',
                         'marketplace.affiliate_click_occurrences', 'finance.expense_generation_dispatches',
                         'platform.finance_expense_worker_properties', 'pms.channex_room_availability_attempts',
                         'platform.legacy_owner_bootstrap_receipts', 'identity.organizations'):
            self.assertIn(f'"{relation}"', source)
        self.assertNotIn('vayada_next_identity_runtime', source)

    def test_cleanup_is_scoped_to_dedicated_cluster_and_log_group(self) -> None:
        self.assertIn('cluster="vayada-target-database-runtime-preflight"', RUNNER)
        self.assertIn(
            "task/vayada-target-database-runtime-preflight/*",
            IAM,
        )
        self.assertIn("log-group:/ecs/vayada-next-api:log-stream:*", IAM)


if __name__ == "__main__":
    unittest.main()
