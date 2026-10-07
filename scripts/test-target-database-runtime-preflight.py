#!/usr/bin/env python3
from pathlib import Path
import textwrap
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
CHECK = (ROOT / "scripts/target-database-runtime-preflight.mjs").read_text()


class RuntimePreflightContractTest(unittest.TestCase):
    def test_runtime_identity_and_receipt_ownership_are_proved(self) -> None:
        self.assertIn('expectedRole = "vayada_next_api_runtime"', CHECK)
        self.assertIn("runtime_owns_receipts", CHECK)
        self.assertIn("runtime_inherits_receipt_owner", CHECK)
        self.assertIn("rolbypassrls", CHECK)
        self.assertIn("runtime_has_settable_or_admin_role_membership", CHECK)
        self.assertGreaterEqual(CHECK.count("set_option"), 2)
        self.assertGreaterEqual(CHECK.count("admin_option"), 2)

    def test_receipt_writes_and_authority_columns_are_denied(self) -> None:
        for privilege in (
            "INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "MAINTAIN"
        ):
            self.assertIn(f"'{privilege}'", CHECK)
        self.assertIn("receipt_authority_columns_readable", CHECK)
        self.assertIn("receipt_columns_writable", CHECK)
        self.assertIn("SELECT owner_user_ids", CHECK)

    def test_each_required_application_privilege_is_checked(self) -> None:
        self.assertIn('"platform.product_audit_events": ["SELECT", "INSERT"]', CHECK)
        self.assertIn('"platform.domain_events": ["INSERT"]', CHECK)
        self.assertIn('"platform.jobs": ["INSERT"]', CHECK)
        self.assertIn('"finance.expense_categories": ["INSERT"]', CHECK)
        self.assertIn('"finance.expenses": ["INSERT"]', CHECK)
        self.assertIn('"finance.recurring_expense_rules": ["INSERT"]', CHECK)
        self.assertIn('code === "runtime_relation_read_missing"', CHECK)
        self.assertIn("'platform.channex_management_worker_properties'", CHECK)
        self.assertIn("'platform.pricing_runtime_property_scopes'", CHECK)
        self.assertIn('"platform.hotel_setup_property_scopes"', CHECK)
        self.assertIn("to_regclass('platform.hotel_setup_property_scopes')", CHECK)
        self.assertIn("'platform.hotel_setup_property_scopes',", CHECK)
        for code in (
            "runtime_schema_usage_missing",
            "runtime_relation_read_missing",
            "runtime_relation_access_missing",
            "runtime_type_access_missing",
            "runtime_database_create_forbidden",
            "runtime_database_temp_forbidden",
            "runtime_application_object_ownership_forbidden",
            "runtime_schema_create_forbidden",
            "runtime_destructive_relation_access_forbidden",
            "runtime_protected_relation_write_forbidden",
            "runtime_protected_relation_column_write_forbidden",
            "runtime_unapproved_relation_write_forbidden",
            "runtime_unapproved_relation_column_write_forbidden",
            "runtime_sequence_access_forbidden",
            "runtime_security_definer_execute_forbidden",
        ):
            self.assertIn(code, CHECK)

    def test_database_execution_is_bounded(self) -> None:
        self.assertIn("connectionTimeoutMillis: 10_000", CHECK)
        self.assertIn("statement_timeout: 15_000", CHECK)

    def test_repair_lane_is_fixed_main_only_and_serialized(self) -> None:
        workflow = (ROOT / '.github/workflows/runtime-affiliate-read-repair.yml').read_text()
        self.assertIn("if: github.ref == 'refs/heads/main'", workflow)
        self.assertIn('environment: platform-mutations-v2', workflow)
        self.assertIn('group: production-ecs-mutations', workflow)
        self.assertIn('queue: max', workflow)
        self.assertIn('runtime_relation_read_missing:2:', workflow)
        self.assertIn('marketplace.affiliate_discrepancy_claims', workflow)
        self.assertIn('marketplace.affiliate_discrepancy_resolutions', workflow)
        self.assertIn('.taskDefinition == $expected', workflow)
        self.assertIn('/vayada/prod/target-database-runtime-url', workflow)
        self.assertEqual(workflow.count('--grant-'), 1)
        self.assertIn('--grant-affiliate-read', workflow)
        self.assertNotIn('run: terraform', workflow.lower())
        self.assertGreater(CHECK.rindex('"runtime_relation_read_missing"'),
                           CHECK.index('check(writableColumns.rowCount'))

    def test_repair_only_accepts_the_exact_missing_read_failure(self) -> None:
        workflow = (ROOT / '.github/workflows/runtime-affiliate-read-repair.yml').read_text()
        guard = textwrap.dedent(workflow.split("python3 - <<'PY'\n", 1)[1].split('\n          PY', 1)[0])
        known = 'runtime_relation_read_missing:2:marketplace.affiliate_discrepancy_claims,marketplace.affiliate_discrepancy_resolutions'
        for output in (known, known.replace('claims,marketplace.affiliate_discrepancy_resolutions', 'resolutions,marketplace.affiliate_discrepancy_claims')):
            with patch.object(Path, 'read_text', return_value=f'Runtime preflight task failed\n{output}\n'):
                exec(guard, {})
        for output in ('', 'PASS', known.replace(':2:', ':3:'), known.replace('affiliate_discrepancy_claims', 'affiliate_links'), known + '\n' + known):
            with self.subTest(output=output), patch.object(Path, 'read_text', return_value=output):
                with self.assertRaises(SystemExit):
                    exec(guard, {})

    def test_migration_provenance_is_private_and_write_protected(self) -> None:
        self.assertIn('"platform.identity_migration_provenance"', CHECK)
        self.assertIn("'platform.identity_migration_provenance'", CHECK)
        self.assertIn("runtime_identity_migration_provenance_read_forbidden", CHECK)


if __name__ == "__main__":
    unittest.main()
