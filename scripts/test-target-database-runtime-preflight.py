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


def js_object(source: str, name: str) -> str:
    return re.search(rf"const {name} = \{{(.*?)\n\}};", source, re.S).group(1)


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
            "runtime_identity_lock_column_missing",
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
            "runtime_function_execute_missing",
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
        # VAY-2056: the native hotel-setup scope relations were dropped by app migration 0474.
        for name in ("noRead", "noReadPatterns", "noWrite", "noWritePatterns"):
            self.assertFalse([entry for entry in js_list(CHECK, name) if "hotel_setup" in entry], name)
        for relation in (
            "platform.identity_migration_provenance",
            "platform.legacy_historical_binding_transitions",
            "platform.finance_expense_worker_properties",
            "marketplace.affiliate_click_quota_windows",
            "pms.inventory_coverage_validation_queue",
        ):
            self.assertIn(relation, js_list(CHECK, "noRead"))
        for relation in (
            "platform.schema_migrations",
            "platform.pricing_runtime_property_scopes",
            "booking.pricing_runtime_effective_property_scopes",
            "marketplace.affiliate_click_occurrences",
            "booking.affiliate_original_booking_bindings",
            "finance.expense_generation_dispatches",
            "pms.channex_ari_schedule_sources",
            "platform.channex_management_worker_properties",
        ):
            self.assertIn(relation, js_list(CHECK, "noWrite"))
        # VAY-2108: every owner-managed Channex worker scope table, including later ones, is protected.
        patterns = [pattern.replace("\\\\", "\\") for pattern in js_list(CHECK, "noWritePatterns")]
        for relation in ("platform.channex_management_worker_operations", "platform.channex_management_worker_properties"):
            self.assertTrue(any(re.search(pattern, relation) for pattern in patterns), relation)
        self.assertFalse(any(re.search(pattern, "platform.channex_webhook_events") for pattern in patterns))
        # VAY-2108 app migration 0481: worker-only offer ARI delivery evidence; the API's own receipts stay append-only.
        for relation in ("pms.channex_offer_ari_deliveries", "pms.channex_offer_ari_delivery_dates", "pms.channex_offer_ari_delivery_receipts"):
            self.assertTrue(any(re.search(pattern, relation) for pattern in patterns), relation)
        self.assertFalse(any(re.search(pattern, "pms.channex_offer_ari_receipts") for pattern in patterns))
        self.assertIn("platform.product_audit_events", js_list(CHECK, "appendOnly"))
        self.assertIn("platform.domain_events", js_list(CHECK, "appendOnly"))
        # Pricing quotes on the ordinary login (VAY-2057): append-only, not protected.
        self.assertNotIn("booking.pricing_quotes", js_list(CHECK, "noWrite"))
        self.assertIn("booking.pricing_quotes", js_list(CHECK, "appendOnly"))
        # VAY-2079: app migration 0475 dropped the pricing authority tables and view.
        self.assertEqual(js_list(CHECK, "noDelete"), ["hotel_catalog.properties"])
        self.assertEqual(js_list(GRANT, "noDelete"), ["hotel_catalog.properties"])
        for name in ("noWrite", "noDelete", "appendOnly"):
            self.assertFalse([r for r in js_list(GRANT, name) if "pricing_authority" in r or "authority_scopes" in r], name)
        self.assertEqual(len(js_list(CHECK, "identityLockOnly")), 6)
        # Trigger-invoked Channex helpers revoked from PUBLIC by the worker provisioning (VAY-2054 follow-up).
        self.assertEqual(js_list(CHECK, "runtimeExecutableFunctions"), js_list(GRANT, "runtimeExecutableFunctions"))
        self.assertEqual(js_list(CHECK, "runtimeExecutableFunctions"), [
            "pms.enqueue_restriction_ari(uuid,text)",
            "pms.claim_channex_external_rate(uuid,text,text,uuid,jsonb)",
        ])
        self.assertIn("runtime_function_security_definer", GRANT)
        self.assertIn("runtime_function_execute_scope_too_broad", GRANT)
        self.assertIn("REVOKE EXECUTE ON FUNCTION ${name} FROM ${role}", GRANT)
        self.assertLess(CHECK.index('"runtime_security_definer_execute_forbidden"'),
                        CHECK.index('"runtime_function_execute_missing"'))
        for name in ("identityColumns", "productIdentityColumns"):
            self.assertEqual(js_object(CHECK, name), js_object(GRANT, name), name)
        extended = js_object(CHECK, "productIdentityColumns")
        for column in ('"resource_product", "resource_type", "resource_id"', '"metadata"', '"status", "updated_at"'):
            self.assertIn(column, extended)
        self.assertIn("productIdentityColumns, ...Object.fromEntries(lockColumns.rows", CHECK)
        self.assertIn("...identityColumns,\n", CHECK)  # legacy staged columns stay on the VAY-965 matrix
        self.assertIn("'vayada_migration_evidence'", CHECK)
        self.assertIn('const identityLockColumn = "created_at"', CHECK)
        self.assertNotIn("pg_policy", CHECK)

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
