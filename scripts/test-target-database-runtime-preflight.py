#!/usr/bin/env python3
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECK = (ROOT / "scripts/target-database-runtime-preflight.mjs").read_text()
GRANT = (ROOT / "scripts/grant-target-database-runtime-product-dml.mjs").read_text()


def js_list(source: str, name: str) -> list[str]:
    body = re.search(rf"const {name} = \[(.*?)\];", source, re.S).group(1)
    return re.findall(r'"([^"]+)"', body)


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
        for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER", "MAINTAIN"):
            self.assertIn(f"'{privilege}'", CHECK)
        self.assertIn("receipt_authority_columns_readable", CHECK)
        self.assertIn("receipt_columns_writable", CHECK)
        self.assertIn("SELECT owner_user_ids", CHECK)

    def test_both_postures_are_detected_from_default_privileges_and_fail_closed(self) -> None:
        self.assertIn("pg_default_acl", CHECK)
        self.assertIn("acl.defaclrole = $2", CHECK)
        self.assertIn('posture = coveredSchemas === 0 ? "legacy" : "product_dml"', CHECK)
        self.assertIn('VAYADA_DB_REQUIRE_PRODUCT_DML', CHECK)
        self.assertNotIn('VAYADA_DB_REQUIRE_FOLIO_COMMAND', CHECK)
        for code in (
            "runtime_product_dml_posture_partial",
            "runtime_product_dml_required",
            "runtime_product_dml_missing",
            "runtime_narrowed_relation_writable",
            "runtime_identity_lock_only_policy_missing",
            "runtime_identity_write_scope_too_broad",
            "runtime_role_membership_forbidden",
            "runtime_default_privileges_missing",
            "runtime_protected_relation_read_forbidden",
            "runtime_protected_relation_write_forbidden",
            "runtime_protected_relation_column_write_forbidden",
            "runtime_column_grant_option_forbidden",
            "runtime_unapproved_relation_write_forbidden",
            "runtime_unapproved_relation_column_write_forbidden",
            "runtime_relation_access_missing",
            "runtime_column_access_missing",
            "runtime_schema_usage_missing",
            "runtime_relation_read_missing",
            "runtime_type_access_missing",
            "runtime_database_create_forbidden",
            "runtime_database_temp_forbidden",
            "runtime_application_object_ownership_forbidden",
            "runtime_schema_create_forbidden",
            "runtime_destructive_relation_access_forbidden",
            "runtime_sequence_access_forbidden",
            "runtime_security_definer_execute_forbidden",
        ):
            self.assertIn(code, CHECK)
        # The legacy allowlist is still asserted exactly until the follow-up removes it.
        self.assertIn('"booking.guest_bookings": ["SELECT", "INSERT", "UPDATE", "DELETE"]', CHECK)
        self.assertIn('"platform.product_audit_events": ["SELECT", "INSERT"]', CHECK)
        self.assertIn('"platform.jobs": ["INSERT"]', CHECK)
        self.assertIn('"hotel_catalog.properties": { UPDATE: ["id"] }', CHECK)

    def test_protected_list_matches_the_grant_script(self) -> None:
        for name in ("noRead", "noReadPatterns", "noWrite", "noWritePatterns", "appendOnly", "noDelete", "identityLockOnly"):
            self.assertEqual(js_list(CHECK, name), js_list(GRANT, name), name)
        for relation in (
            "platform.hotel_setup_property_scopes",
            "hotel_catalog.hotel_setup_effective_creation_scopes",
            "platform.identity_migration_provenance",
            "platform.legacy_historical_binding_transitions",
            "platform.finance_expense_worker_properties",
            "marketplace.affiliate_click_quota_windows",
            "pms.inventory_coverage_validation_queue",
        ):
            self.assertIn(relation, js_list(CHECK, "noRead"))
        for relation in (
            "platform.schema_migrations",
            "booking.pricing_authority_heads",
            "booking.pricing_quotes",
            "marketplace.affiliate_click_occurrences",
            "booking.affiliate_original_booking_bindings",
            "finance.expense_generation_dispatches",
            "pms.channex_ari_schedule_sources",
            "platform.channex_management_worker_properties",
        ):
            self.assertIn(relation, js_list(CHECK, "noWrite"))
        self.assertEqual(js_list(CHECK, "appendOnly"), ["platform.product_audit_events", "platform.domain_events"])
        self.assertEqual(js_list(CHECK, "noDelete"), ["hotel_catalog.properties"])
        self.assertEqual(len(js_list(CHECK, "identityLockOnly")), 6)
        self.assertIn("'vayada_migration_evidence'", CHECK)
        self.assertIn("polname = 'api_runtime_lock_only'", CHECK)

    def test_database_execution_is_bounded(self) -> None:
        self.assertIn("connectionTimeoutMillis: 10_000", CHECK)
        self.assertIn("statement_timeout: 15_000", CHECK)

    def test_missing_reads_are_reported_after_the_boundary_checks(self) -> None:
        self.assertGreater(CHECK.rindex('"runtime_relation_read_missing"'),
                           CHECK.index('check(writableColumns.rowCount'))
        self.assertLess(CHECK.index('"runtime_protected_relation_read_forbidden"'),
                        CHECK.index('posture === "legacy") {'))


if __name__ == "__main__":
    unittest.main()
