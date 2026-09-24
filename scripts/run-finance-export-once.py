#!/usr/bin/env python3
"""Run a reviewed Dashboard export task; never enable an API service worker."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

ACCOUNT = "269416271598"
REGION = "eu-west-1"
CLUSTER = "vayada-finance-export-once"
SERVICE_CLUSTER = "vayada-backend-cluster"
SERVICE = "vayada-next-api-service"
FAMILY = "vayada-finance-export-once"
PROPERTY = "65f6b2fc-c783-4963-9d6b-a85f82319769"
OLD_EXPORT = "f3429f38-b462-4453-b7f1-d901fc86ebfa"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/vayada-finance-export-once"
WRITER = ROLE + "-writer"
SECRET = "/vayada/prod/target-database-finance-export-worker-url"
IMAGE_PREFIX = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/vayada-next-api@"


def require(ok, code):
    if not ok:
        raise ValueError(code)


def deadline_for(export_id, dispatched_at, now):
    require(bool(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", export_id)), "export_id_invalid")
    require(export_id != OLD_EXPORT, "terminal_export_forbidden")
    try:
        dispatched = datetime.strptime(dispatched_at, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        raise ValueError("dispatch_time_invalid") from None
    require(dispatched.isoformat(timespec="milliseconds").replace("+00:00", "Z") == dispatched_at, "dispatch_time_not_canonical")
    require(dispatched <= now < dispatched + timedelta(minutes=15), "dispatch_window_invalid")
    return dispatched + timedelta(minutes=15)


def task_definition(source, export_id, dispatched_at, digest, revision, now):
    deadline_for(export_id, dispatched_at, now)
    require(bool(re.fullmatch(r"[0-9a-f]{40}", revision)), "source_invalid")
    require(bool(re.fullmatch(r"sha256:[0-9a-f]{64}", digest)), "digest_invalid")
    containers = source.get("containerDefinitions", [])
    require(len(containers) == 1 and containers[0]["name"] == "vayada-next-api", "source_container_drift")
    container = containers[0]
    require(container["image"] == IMAGE_PREFIX + digest, "serving_image_drift")
    env = {entry["name"]: entry["value"] for entry in container.get("environment", [])}
    for worker in ("EXPENSE", "EXPORT"):
        require(env.get(f"FINANCE_{worker}_WORKER_ENABLED") == "false", "service_worker_enabled")
        require(not env.get(f"FINANCE_{worker}_WORKER_PROPERTY_ID"), "service_scope_present")
    require(not env.get("FINANCE_EXPORT_WORKER_EXPORT_ID"), "service_export_present")
    require(not any(s["name"] in {"FINANCE_EXPORT_WORKER_DATABASE_URL", "FINANCE_EXPENSE_WORKER_DATABASE_URL"} for s in container.get("secrets", [])), "service_worker_secret_present")
    bucket = env.get("PLATFORM_MEDIA_BUCKET", "")
    require(bucket == "vayada-media-production", "private_bucket_drift")
    require(source.get("executionRoleArn") == f"arn:aws:iam::{ACCOUNT}:role/ecsTaskExecutionRole", "execution_role_drift")
    logs = container.get("logConfiguration", {})
    require(logs.get("logDriver") == "awslogs" and logs.get("options", {}).get("awslogs-group") == "/ecs/vayada-next-api", "log_configuration_drift")
    require(source.get("networkMode") == "awsvpc" and "FARGATE" in source.get("requiresCompatibilities", []), "task_network_drift")
    require(source.get("runtimePlatform", {}).get("cpuArchitecture", "X86_64") == "X86_64", "task_architecture_drift")
    return {
        "family": FAMILY, "taskRoleArn": ROLE,
        "executionRoleArn": source["executionRoleArn"], "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"], "cpu": source["cpu"], "memory": source["memory"],
        "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
        "containerDefinitions": [{
            "name": "vayada-next-api", "essential": True, "image": IMAGE_PREFIX + digest,
            "command": ["node", "apps/api/dist/jobs/runFinanceDashboardExportOnce.js"],
            "stopTimeout": 30, "logConfiguration": logs,
            "secrets": [{"name": "FINANCE_EXPORT_WORKER_DATABASE_URL", "valueFrom": SECRET}],
            "environment": [{"name": key, "value": value} for key, value in {
                "NODE_ENV": "production", "AWS_REGION": REGION, "APPLICATION_RELEASE": revision,
                "FINANCE_EXPORT_WORKER_PROPERTY_ID": PROPERTY,
                "FINANCE_EXPORT_WORKER_EXPORT_ID": export_id,
                "FINANCE_EXPORT_DISPATCHED_AT": dispatched_at,
                "FINANCE_EXPORT_WRITER_ROLE_ARN": WRITER, "PLATFORM_MEDIA_BUCKET": bucket,
            }.items()],
        }],
    }


def aws(*args):
    result = subprocess.run(["aws", *args, "--region", REGION, "--output", "json", "--cli-connect-timeout", "5", "--cli-read-timeout", "15"], capture_output=True, text=True, timeout=25)
    require(result.returncode == 0, "aws_call_failed")  # Never print AWS errors containing task environment.
    return json.loads(result.stdout or "{}")


def utcnow():
    return datetime.now(timezone.utc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-id", required=True)
    parser.add_argument("--dispatched-at", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-task", required=True)
    args = parser.parse_args()
    deadline = deadline_for(args.export_id, args.dispatched_at, utcnow())
    reviewed = dict(line.split() for line in Path(__file__).with_name("next-api-split-compatible-images.txt").read_text().splitlines() if line and not line.startswith("#"))
    require(reviewed.get(args.source) == args.digest, "image_not_attested")
    service = aws("ecs", "describe-services", "--cluster", SERVICE_CLUSTER, "--services", SERVICE)["services"][0]
    require(service["taskDefinition"] == args.expected_task, "service_task_drift")
    require(service["desiredCount"] == service["runningCount"] == 1 and service["pendingCount"] == 0, "service_not_stable")
    require(len(service["deployments"]) == 1 and service["deployments"][0].get("rolloutState") == "COMPLETED", "service_rollout_active")
    for status in ("RUNNING", "STOPPED"):
        tasks = aws("ecs", "list-tasks", "--cluster", CLUSTER, "--family", FAMILY, "--desired-status", status)["taskArns"]
        if tasks:
            existing = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *tasks)["tasks"]
            require(not any(t.get("lastStatus") != "STOPPED" for t in existing), "other_export_task_active")
    source = aws("ecs", "describe-task-definition", "--task-definition", args.expected_task)["taskDefinition"]
    definition = task_definition(source, args.export_id, args.dispatched_at, args.digest, args.source, utcnow())
    registered = None
    task = None
    stopped = False
    exit_code = None
    cleanup_ok = True
    registration_attempted = False
    run_attempted = False
    try:
        registration_attempted = True
        registered = aws("ecs", "register-task-definition", "--cli-input-json", json.dumps(definition))["taskDefinition"]["taskDefinitionArn"]
        deadline_for(args.export_id, args.dispatched_at, utcnow())
        run_attempted = True
        result = aws("ecs", "run-task", "--cluster", CLUSTER, "--task-definition", registered,
                     "--launch-type", "FARGATE", "--count", "1", "--network-configuration", json.dumps(service["networkConfiguration"]),
                     "--client-token", hashlib.sha256(args.export_id.encode()).hexdigest(),
                     "--started-by", args.export_id)
        tasks = result.get("tasks", [])
        if tasks:
            task = tasks[0]["taskArn"]
            print(json.dumps({"status": "STARTED", "taskArn": task, "taskDefinitionArn": registered}), flush=True)
        require(len(tasks) == 1 and not result.get("failures"), "run_task_rejected")
        while utcnow() < deadline:
            state = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", task)["tasks"][0]
            if state["lastStatus"] == "STOPPED":
                stopped = True
                exit_code = state["containers"][0].get("exitCode")
                break
            time.sleep(3)
        require(stopped, "deadline_stop_required")
        require(exit_code == 0, "app_execution_not_successful")
    finally:
        if registration_attempted and not registered:
            # An unknown registration response is not evidence of no mutation.
            # Hold the window for reconciliation rather than deregistering an
            # unrelated family revision by guessing which one was created.
            cleanup_ok = False
        if run_attempted and not task:
            # A network failure may hide a successful RunTask. Discover by the
            # unique request identity, never retry RunTask automatically.
            cleanup_ok = False
            try:
                found = aws("ecs", "list-tasks", "--cluster", CLUSTER, "--started-by", args.export_id)["taskArns"]
                if len(found) == 1:
                    task = found[0]
            except Exception:
                pass
        if task and not stopped:
            try:
                aws("ecs", "stop-task", "--cluster", CLUSTER, "--task", task, "--reason", "Bounded export cleanup; preserve evidence")
                for _ in range(20):
                    state = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", task)["tasks"][0]
                    if state["lastStatus"] == "STOPPED":
                        stopped = True
                        break
                    time.sleep(3)
                cleanup_ok = cleanup_ok and stopped
            except Exception:
                cleanup_ok = False
        if registered:
            try:
                deregistered = aws("ecs", "deregister-task-definition", "--task-definition", registered)
                cleanup_ok = cleanup_ok and deregistered["taskDefinition"]["status"] == "INACTIVE"
            except Exception:
                cleanup_ok = False
        print(json.dumps({"status": "CLEANUP", "taskStopped": stopped, "cleanupVerified": cleanup_ok, "exitCode": exit_code}), flush=True)
        require(cleanup_ok, "cleanup_unverified_hold_window")
    print(json.dumps({"status": "TASK_COMPLETED", "exportId": args.export_id, "artifactAcceptance": "requires_protected_readback"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z_]+", str(error)) else "runner_failed_hold_window"
        print(json.dumps({"status": "FAIL", "code": code}), flush=True)
        raise SystemExit(1)
