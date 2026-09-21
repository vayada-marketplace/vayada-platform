#!/usr/bin/env python3
import base64
import gzip
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = (ROOT / "scripts/run-target-database-runtime-preflight.sh").read_text()
GRANT = (ROOT / "scripts/grant-target-database-product-audit-insert.mjs").read_text()
IAM = (ROOT / "infra/target_database_preflight_iam.tf").read_text()


class RuntimePreflightRunnerTest(unittest.TestCase):
    def test_temporary_task_receives_only_the_runtime_database_secret(self) -> None:
        self.assertIn('secret_name="TARGET_DATABASE_URL"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/target-database-runtime-url"', RUNNER)
        self.assertIn('.secrets=[{name:$secret_name,valueFrom:$secret_parameter}]', RUNNER)
        for secret in ("CHANNEX_API_KEY", "STRIPE_SECRET_KEY", "WORKOS_API_KEY"):
            self.assertNotIn(secret, RUNNER)
        self.assertIn("del(.taskRoleArn)", RUNNER)

    def test_audit_grant_uses_only_the_owner_secret_in_explicit_mode(self) -> None:
        self.assertIn('--grant-product-audit-insert|--grant-affiliate-read|--grant-domain-events-append|--grant-jobs-insert|--grant-expense-category-insert)', RUNNER)
        self.assertIn('grant_scope="audit_insert"', RUNNER)
        self.assertIn('grant_scope="affiliate_read"', RUNNER)
        self.assertIn('grant_scope="domain_events_append"', RUNNER)
        self.assertIn('grant_scope="jobs_insert"', RUNNER)
        self.assertIn('grant_scope="expense_category_insert"', RUNNER)
        self.assertIn('secret_name="TARGET_DATABASE_MIGRATION_URL"', RUNNER)
        self.assertIn('secret_parameter="/vayada/prod/target-database-url"', RUNNER)
        self.assertIn('code_file="grant-target-database-product-audit-insert.mjs"', RUNNER)
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

    def test_identity_modes_use_only_owner_and_dedicated_identity_secrets(self) -> None:
        self.assertIn('--provision-identity-role|--grant-identity-runtime)', RUNNER)
        self.assertIn('code_file="provision-target-database-identity-runtime.mjs"', RUNNER)
        self.assertIn('code_file="grant-target-database-identity-runtime.mjs"', RUNNER)
        self.assertIn('extra_secret_name="IDENTITY_DATABASE_URL"', RUNNER)
        self.assertIn('extra_secret_parameter="/vayada/prod/target-database-identity-runtime-url"', RUNNER)
        self.assertIn('.secrets += [{name:$extra_secret_name,valueFrom:$extra_secret_parameter}]', RUNNER)
        self.assertNotIn('secret_name="AUTH_DATABASE_URL"', RUNNER)

    def test_identity_grant_pins_one_ca_and_fits_override_budget(self) -> None:
        self.assertIn('ca_bundle="${ca_bundle%%-----END CERTIFICATE-----*}-----END CERTIFICATE-----"', RUNNER)
        self.assertIn('6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86', RUNNER)
        self.assertIn('${#ca_payload}" -gt 2100', RUNNER)
        grant_code = (ROOT / 'scripts/grant-target-database-identity-runtime.mjs').read_bytes()
        encoded_code = base64.b64encode(gzip.compress(grant_code, compresslevel=9, mtime=0))
        self.assertLessEqual(len(encoded_code) + 2100 + 1024, 8192)

    def test_cleanup_is_scoped_to_dedicated_cluster_and_log_group(self) -> None:
        self.assertIn('cluster="vayada-target-database-runtime-preflight"', RUNNER)
        self.assertIn(
            "task/vayada-target-database-runtime-preflight/*",
            IAM,
        )
        self.assertIn("log-group:/ecs/vayada-next-api:log-stream:*", IAM)


if __name__ == "__main__":
    unittest.main()
