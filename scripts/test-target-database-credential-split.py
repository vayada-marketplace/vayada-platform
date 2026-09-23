#!/usr/bin/env python3
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


class TargetDatabaseCredentialSplitTest(unittest.TestCase):
    def test_next_api_uses_runtime_for_requests_and_owner_for_migrations(self) -> None:
        ecs = read("infra/ecs.tf")
        self.assertIn(
            '{ name = "TARGET_DATABASE_URL", valueFrom = "/vayada/prod/target-database-runtime-url" }',
            ecs,
        )
        self.assertIn(
            '{ name = "AUTH_DATABASE_URL", valueFrom = "/vayada/prod/target-database-identity-runtime-url" }',
            ecs,
        )
        self.assertIn(
            '{ name = "TARGET_DATABASE_MIGRATION_URL", valueFrom = "/vayada/prod/target-database-url" }',
            ecs,
        )
        self.assertNotIn(
            '{ name = "TARGET_DATABASE_URL", valueFrom = "/vayada/prod/target-database-url" }',
            ecs,
        )
        self.assertNotIn(
            '{ name = "AUTH_DATABASE_URL", valueFrom = "/vayada/prod/target-database-url" }',
            ecs,
        )

    def test_runtime_secret_is_externally_provisioned(self) -> None:
        ssm = read("infra/ssm.tf")
        docs = read("docs/environments.md")
        self.assertNotIn("target_database_runtime_url", ssm)
        self.assertIn(
            "`target-database-runtime-url` is provisioned outside Terraform", docs
        )
        self.assertNotIn("target_database_identity_runtime_url", ssm)
        self.assertIn("`/vayada/prod/target-database-identity-runtime-url`", docs)

    def test_one_off_api_tasks_do_not_receive_migration_owner(self) -> None:
        for path in ("infra/finance_folio_inventory.tf", "infra/next_stripe_test.tf"):
            source = read(path)
            self.assertIn("parameter/vayada/prod/target-database-runtime-url", source)
            self.assertNotIn("parameter/vayada/prod/target-database-url", source)

if __name__ == "__main__":
    unittest.main()
