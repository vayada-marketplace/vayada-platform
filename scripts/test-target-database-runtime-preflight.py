#!/usr/bin/env python3
from pathlib import Path
import unittest


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
        self.assertIn('code === "runtime_relation_read_missing"', CHECK)
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


if __name__ == "__main__":
    unittest.main()
