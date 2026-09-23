#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/assert-target-database-split-deployment-ready.py"
OWNER = "/vayada/prod/target-database-url"
RUNTIME = "/vayada/prod/target-database-runtime-url"
IDENTITY = "/vayada/prod/target-database-identity-runtime-url"
FINANCE_EXPENSE = "/vayada/prod/target-database-finance-expense-worker-url"
RELEASE = "8c2cdef397522740c9fe7803efc2ed36d637bac5"
REPOSITORY = "269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api"
DIGEST = "sha256:b097e04a61d5bd3b5910bbf856f13849bddd7b66c5883a4e2e160e311737bfca"
TASK_DEFINITION = "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:643"


def run(
    image: str,
    secrets: dict[str, str] | list[dict[str, str]],
    *,
    running_digest: str = DIGEST,
    stable: bool = True,
    running_task_definition: str = TASK_DEFINITION,
    reviewed_digest: str | None = DIGEST,
    environment: list[dict[str, str]] | None = None,
    environment_files: list[dict[str, str]] | None = None,
) -> subprocess.CompletedProcess[str]:
    secret_entries = secrets if isinstance(secrets, list) else [
        {"name": name, "valueFrom": value} for name, value in secrets.items()
    ]
    service = {"services": [{
        "taskDefinition": TASK_DEFINITION,
        "desiredCount": 1,
        "runningCount": 1 if stable else 0,
        "pendingCount": 0,
        "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED"}],
    }]}
    task = {"taskDefinition": {
        "taskDefinitionArn": TASK_DEFINITION,
        "containerDefinitions": [{
            "name": "vayada-next-api",
            "image": image,
            "secrets": secret_entries,
            "environment": environment or [],
            "environmentFiles": environment_files or [],
        }],
    }}
    reviewed_image = {"imageDetails": [] if reviewed_digest is None else [{
        "imageDigest": reviewed_digest, "imageTags": [f"next-{RELEASE}"],
    }]}
    running_tasks = {"tasks": [{
        "lastStatus": "RUNNING",
        "taskDefinitionArn": running_task_definition,
        "containers": [{"name": "vayada-next-api", "imageDigest": running_digest}],
    }], "failures": []}
    with tempfile.TemporaryDirectory() as directory:
        paths = []
        for name, document in (
            ("service", service), ("task", task),
            ("image", reviewed_image), ("running", running_tasks),
        ):
            path = Path(directory) / f"{name}.json"
            path.write_text(json.dumps(document))
            paths.append(str(path))
        return subprocess.run(
            ["python3", str(CHECK), *paths], capture_output=True, check=False, text=True
        )


class DeploymentReadinessTest(unittest.TestCase):
    def test_accepts_exact_compatible_pre_split_launcher_and_running_digest(self) -> None:
        result = run(
            f"{REPOSITORY}:next-{RELEASE}",
            {"TARGET_DATABASE_URL": OWNER, "AUTH_DATABASE_URL": OWNER},
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_wrong_repository_or_running_digest(self) -> None:
        for image, digest in (
            (f"example/vayada-next-api:next-{RELEASE}", DIGEST),
            (f"{REPOSITORY}:next-{RELEASE}", "sha256:" + "b" * 64),
        ):
            with self.subTest(image=image, digest=digest):
                self.assertNotEqual(run(
                    image,
                    {"TARGET_DATABASE_URL": OWNER, "AUTH_DATABASE_URL": OWNER},
                    running_digest=digest,
                ).returncode, 0)

    def test_accepts_real_parameter_arns(self) -> None:
        prefix = "arn:aws:ssm:eu-west-1:269416271598:parameter"
        result = run(
            f"{REPOSITORY}@{DIGEST}",
            {
                "TARGET_DATABASE_URL": f"{prefix}{OWNER}",
                "AUTH_DATABASE_URL": f"{prefix}{OWNER}",
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_existing_split_only_with_pinned_running_digest(self) -> None:
        secrets = {
            "TARGET_DATABASE_URL": RUNTIME,
            "AUTH_DATABASE_URL": RUNTIME,
            "TARGET_DATABASE_MIGRATION_URL": OWNER,
        }
        self.assertEqual(run(f"{REPOSITORY}@{DIGEST}", secrets).returncode, 0)
        self.assertNotEqual(
            run(f"{REPOSITORY}@{DIGEST}", secrets, reviewed_digest=None).returncode,
            0,
        )
        self.assertEqual(run(f"{REPOSITORY}@{DIGEST}", {
            **secrets,
            "FINANCE_EXPENSE_WORKER_DATABASE_URL": FINANCE_EXPENSE,
        }).returncode, 0)
        self.assertNotEqual(run(f"{REPOSITORY}:next-latest", secrets).returncode, 0)

    def test_accepts_identity_split_only_with_pinned_running_digest(self) -> None:
        secrets = {
            "TARGET_DATABASE_URL": RUNTIME,
            "AUTH_DATABASE_URL": IDENTITY,
            "TARGET_DATABASE_MIGRATION_URL": OWNER,
        }
        self.assertEqual(run(f"{REPOSITORY}@{DIGEST}", secrets).returncode, 0)
        self.assertNotEqual(
            run(f"{REPOSITORY}@{DIGEST}", secrets, reviewed_digest=None).returncode,
            0,
        )

    def test_rejects_partial_drifted_or_hidden_owner_mapping(self) -> None:
        cases = [
            {"TARGET_DATABASE_URL": RUNTIME, "AUTH_DATABASE_URL": OWNER},
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": RUNTIME,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "HIDDEN_OWNER_URL": OWNER,
            },
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": IDENTITY,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "HIDDEN_IDENTITY_URL": IDENTITY,
            },
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": IDENTITY,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "HIDDEN_URL": "/vayada/prod/db-marketplace-url",
            },
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": IDENTITY,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "HIDDEN_URL": "/vayada/prod/db-auth-url",
            },
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": IDENTITY,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "FINANCE_EXPENSE_WORKER_DATABASE_URL": "/vayada/prod/db-marketplace-url",
            },
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": IDENTITY,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "POSTGRES_URL": "/vayada/prod/postgres-admin-url",
            },
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": IDENTITY,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "PG_URL": "/vayada/prod/pg-owner-url",
            },
            {
                "TARGET_DATABASE_URL": RUNTIME,
                "AUTH_DATABASE_URL": IDENTITY,
                "TARGET_DATABASE_MIGRATION_URL": OWNER,
                "RDS_URL": "/vayada/prod/rds-master-url",
            },
        ]
        for secrets in cases:
            with self.subTest(secrets=secrets):
                self.assertNotEqual(run(f"{REPOSITORY}@{DIGEST}", secrets).returncode, 0)

    def test_rejects_duplicate_secret_names(self) -> None:
        secrets = [
            {"name": "TARGET_DATABASE_URL", "valueFrom": OWNER},
            {"name": "TARGET_DATABASE_URL", "valueFrom": RUNTIME},
            {"name": "AUTH_DATABASE_URL", "valueFrom": OWNER},
        ]
        self.assertNotEqual(run(f"{REPOSITORY}:next-{RELEASE}", secrets).returncode, 0)

    def test_rejects_alternate_database_credential_sources(self) -> None:
        secrets = {"TARGET_DATABASE_URL": OWNER, "AUTH_DATABASE_URL": OWNER}
        cases = [
            {"environment": [{"name": "TARGET_DATABASE_URL", "value": "postgresql://leak"}]},
            {"environment": [{"name": "OTHER_URL", "value": " POSTGRESQL://leak"}]},
            {"environment": [{"name": "CONNECTION", "value": "host=db user=owner"}]},
            {"environment": [{"name": "OWNER_DB", "value": "opaque"}]},
            {"environment_files": [{"type": "s3", "value": "arn:aws:s3:::env"}]},
        ]
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                self.assertNotEqual(
                    run(f"{REPOSITORY}:next-{RELEASE}", secrets, **kwargs).returncode,
                    0,
                )

    def test_rejects_unstable_or_mismatched_running_task(self) -> None:
        secrets = {"TARGET_DATABASE_URL": OWNER, "AUTH_DATABASE_URL": OWNER}
        self.assertNotEqual(
            run(f"{REPOSITORY}:next-{RELEASE}", secrets, stable=False).returncode, 0
        )
        self.assertNotEqual(run(
            f"{REPOSITORY}:next-{RELEASE}", secrets,
            running_task_definition="different",
        ).returncode, 0)


if __name__ == "__main__":
    unittest.main()
