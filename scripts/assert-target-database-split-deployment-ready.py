#!/usr/bin/env python3
import json
from pathlib import Path
import re
import sys


ECR_REPOSITORY = "269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api"
OWNER_PARAMETER = "/vayada/prod/target-database-url"
RUNTIME_PARAMETER = "/vayada/prod/target-database-runtime-url"
PARAMETER_ARN = re.compile(
    r"^arn:aws:ssm:eu-west-1:269416271598:parameter(?P<name>/vayada/prod/[^/]+)$"
)
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
COMPATIBLE_IMAGES = dict(
    line.split()
    for line in (Path(__file__).with_name("next-api-split-compatible-images.txt"))
    .read_text()
    .splitlines()
    if line.strip() and not line.startswith("#")
)


def fail(message: str) -> None:
    raise SystemExit(f"target database split preflight failed: {message}")


def parameter_name(value: str | None) -> str | None:
    if value is None or value.startswith("/"):
        return value
    match = PARAMETER_ARN.fullmatch(value)
    return match.group("name") if match else None


def load(path: str) -> dict:
    return json.loads(Path(path).read_text())


def main() -> None:
    if len(sys.argv) != 5:
        fail(
            "usage: assert-target-database-split-deployment-ready.py "
            "<service.json> <task-definition.json> <reviewed-image.json> "
            "<running-tasks.json>"
        )
    service_document, task_document, image_document, tasks_document = (
        load(path) for path in sys.argv[1:]
    )
    services = service_document.get("services", [])
    if len(services) != 1:
        fail("expected exactly one next-api service")
    service = services[0]
    primary = [item for item in service.get("deployments", []) if item.get("status") == "PRIMARY"]
    if len(primary) != 1 or primary[0].get("rolloutState") != "COMPLETED":
        fail("next-api service does not have one completed PRIMARY deployment")
    desired = service.get("desiredCount")
    if not isinstance(desired, int) or desired < 1:
        fail("next-api service must desire at least one task")
    if service.get("runningCount") != desired or service.get("pendingCount") != 0:
        fail("next-api service is not stable")

    task = task_document.get("taskDefinition", task_document)
    current_task_definition = service.get("taskDefinition")
    if task.get("taskDefinitionArn") != current_task_definition:
        fail("inspected task definition is not the service task definition")
    containers = [
        item for item in task.get("containerDefinitions", [])
        if item.get("name") == "vayada-next-api"
    ]
    if len(containers) != 1:
        fail("expected exactly one vayada-next-api container")
    container = containers[0]

    environment_entries = container.get("environment", [])
    environment_names = [item.get("name") for item in environment_entries]
    if None in environment_names or len(environment_names) != len(set(environment_names)):
        fail("environment variable names must be present and unique")
    protected_names = {
        "TARGET_DATABASE_URL",
        "AUTH_DATABASE_URL",
        "TARGET_DATABASE_MIGRATION_URL",
    }
    if protected_names.intersection(environment_names):
        fail("database credentials must not be supplied as plaintext environment variables")
    for item in environment_entries:
        name = item["name"].strip().lower()
        value = str(item.get("value", "")).strip().lower()
        database_name = "database" in name or "postgres" in name or re.search(
            r"(^|_)db(_|$)", name
        )
        database_uri = any(
            marker in value
            for marker in ("postgres://", "postgresql://", "jdbc:postgresql:")
        )
        libpq_dsn = re.search(
            r"(?:^|\s)(?:host|hostaddr|dbname|user|password|service)\s*=",
            value,
        )
        if database_name or database_uri or libpq_dsn:
            fail("database-like plaintext environment entries are forbidden")
    if container.get("environmentFiles"):
        fail("next-api environment files are not reviewed credential sources")

    secret_entries = container.get("secrets", [])
    secret_names = [item.get("name") for item in secret_entries]
    if None in secret_names or len(secret_names) != len(set(secret_names)):
        fail("secret names must be present and unique")
    if set(environment_names).intersection(secret_names):
        fail("environment and secret names must be disjoint")
    secrets = {
        item["name"]: parameter_name(item.get("valueFrom")) for item in secret_entries
    }
    owner_refs = {name for name, value in secrets.items() if value == OWNER_PARAMETER}
    runtime_refs = {name for name, value in secrets.items() if value == RUNTIME_PARAMETER}

    split = {
        "TARGET_DATABASE_URL": RUNTIME_PARAMETER,
        "AUTH_DATABASE_URL": RUNTIME_PARAMETER,
        "TARGET_DATABASE_MIGRATION_URL": OWNER_PARAMETER,
    }
    is_split = all(secrets.get(name) == value for name, value in split.items())
    if is_split:
        if owner_refs != {"TARGET_DATABASE_MIGRATION_URL"}:
            fail("split task has an unexpected owner database secret reference")
        if runtime_refs != {"TARGET_DATABASE_URL", "AUTH_DATABASE_URL"}:
            fail("split task has an unexpected runtime database secret reference")
    else:
        unsplit = {
            "TARGET_DATABASE_URL": OWNER_PARAMETER,
            "AUTH_DATABASE_URL": OWNER_PARAMETER,
        }
        if not all(secrets.get(name) == value for name, value in unsplit.items()):
            fail("current task has neither the reviewed pre-split nor split secret mapping")
        if owner_refs != {"TARGET_DATABASE_URL", "AUTH_DATABASE_URL"}:
            fail("pre-split task has an unexpected owner database secret reference")
        if runtime_refs:
            fail("pre-split task unexpectedly references the runtime database secret")
        if "TARGET_DATABASE_MIGRATION_URL" in secrets:
            fail("pre-split task unexpectedly carries a migration override")

    image = container.get("image", "")
    reviewed_digests = {
        item.get("imageDigest") for item in image_document.get("imageDetails", [])
        if item.get("imageDigest") in COMPATIBLE_IMAGES.values()
        and DIGEST.fullmatch(item.get("imageDigest", ""))
    }
    running_tasks = tasks_document.get("tasks", [])
    if tasks_document.get("failures") or len(running_tasks) != desired:
        fail("could not inspect every running next-api task")
    running_digests = []
    for running_task in running_tasks:
        if running_task.get("lastStatus") != "RUNNING":
            fail("inspected next-api task is not RUNNING")
        if running_task.get("taskDefinitionArn") != current_task_definition:
            fail("running task does not use the current service task definition")
        app_containers = [
            item for item in running_task.get("containers", [])
            if item.get("name") == "vayada-next-api"
        ]
        if len(app_containers) != 1 or not DIGEST.fullmatch(
            app_containers[0].get("imageDigest", "")
        ):
            fail("running task lacks one exact next-api image digest")
        running_digests.append(app_containers[0]["imageDigest"])

    if is_split:
        prefix = f"{ECR_REPOSITORY}@"
        if not image.startswith(prefix) or not DIGEST.fullmatch(image[len(prefix):]):
            fail("split task definition must pin the exact next-api image digest")
        expected_digest = image[len(prefix):]
        if expected_digest not in reviewed_digests:
            fail("split task digest lacks a launcher-compatibility attestation")
        if any(digest != expected_digest for digest in running_digests):
            fail("running split task digest does not match its pinned task definition")
        print("target database split preflight passed: current tasks are already split")
        return

    reviewed_tags = {
        f"{ECR_REPOSITORY}:next-{release}" for release in COMPATIBLE_IMAGES
    }
    digest_prefix = f"{ECR_REPOSITORY}@"
    task_digest = image[len(digest_prefix):] if image.startswith(digest_prefix) else None
    if image not in reviewed_tags and task_digest not in reviewed_digests:
        fail("initial rollout requires the exact reviewed split-aware launcher image")
    if not reviewed_digests or any(digest not in reviewed_digests for digest in running_digests):
        fail("running tasks do not use the exact reviewed launcher digest")
    print("target database split preflight passed: compatible launcher tasks are healthy")


if __name__ == "__main__":
    main()
