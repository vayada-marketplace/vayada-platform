#!/usr/bin/env python3
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = (ROOT / "scripts/run-target-database-runtime-preflight.sh").read_text()
IAM = (ROOT / "infra/target_database_preflight_iam.tf").read_text()


class RuntimePreflightRunnerTest(unittest.TestCase):
    def test_temporary_task_receives_only_the_runtime_database_secret(self) -> None:
        self.assertIn(
            '.secrets=[{name:"TARGET_DATABASE_URL",valueFrom:"/vayada/prod/target-database-runtime-url"}]',
            RUNNER,
        )
        for secret in ("CHANNEX_API_KEY", "STRIPE_SECRET_KEY", "WORKOS_API_KEY"):
            self.assertNotIn(secret, RUNNER)
        self.assertIn("del(.taskRoleArn)", RUNNER)

    def test_task_is_bounded_and_cleaned_up(self) -> None:
        self.assertIn("trap cleanup EXIT", RUNNER)
        self.assertIn("aws ecs stop-task", RUNNER)
        self.assertIn("aws ecs deregister-task-definition", RUNNER)
        self.assertIn("Runtime preflight task exceeded five minutes", RUNNER)

    def test_cleanup_is_scoped_to_dedicated_cluster_and_log_group(self) -> None:
        self.assertIn('cluster="vayada-target-database-runtime-preflight"', RUNNER)
        self.assertIn(
            "task/vayada-target-database-runtime-preflight/*",
            IAM,
        )
        self.assertIn("log-group:/ecs/vayada-next-api:log-stream:*", IAM)


if __name__ == "__main__":
    unittest.main()
