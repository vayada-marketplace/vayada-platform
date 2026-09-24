import copy
import contextlib
import io
import json
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path
import runpy
import unittest

r = runpy.run_path(str(Path(__file__).with_name("run-finance-export-once.py")))
EXPORT = "3f3b65fa-8335-4848-9e2b-792b15500001"
DISPATCH = "2026-09-24T15:00:00.000Z"
NOW = datetime(2026, 9, 24, 15, 1, tzinfo=timezone.utc)
DIGEST = "sha256:" + "a" * 64
SOURCE = "b" * 40


def baseline():
    return {
        "cpu": "512", "memory": "1024", "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "executionRoleArn": f"arn:aws:iam::{r['ACCOUNT']}:role/ecsTaskExecutionRole",
        "taskRoleArn": "must-not-inherit",
        "containerDefinitions": [{
            "name": "vayada-next-api", "image": r["IMAGE_PREFIX"] + DIGEST,
            "command": ["server"], "healthCheck": {"command": ["server-health"]},
            "secrets": [{"name": "TARGET_DATABASE_MIGRATION_URL", "valueFrom": "owner"}],
            "environment": [{"name": k, "value": v} for k, v in {
                "PLATFORM_MEDIA_BUCKET": "vayada-media-production",
                "FINANCE_EXPENSE_WORKER_ENABLED": "false", "FINANCE_EXPORT_WORKER_ENABLED": "false",
                "UNRELATED_SECRET_VALUE": "must-not-copy",
            }.items()],
            "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/ecs/vayada-next-api"}},
        }],
    }


def render(source):
    return r["task_definition"](source, EXPORT, DISPATCH, DIGEST, SOURCE, NOW)


class BootstrapPlanTest(unittest.TestCase):
    def test_only_exact_new_resources_can_be_bootstrapped(self):
        guard = runpy.run_path(str(Path(__file__).with_name("assert-finance-export-bootstrap-plan.py")))
        plan = {"resource_changes": [{"address": a, "change": {"actions": ["create"]}} for a in guard["EXPECTED"]]}
        guard["validate"](plan)
        for actions in (["update"], ["delete", "create"]):
            altered = copy.deepcopy(plan); altered["resource_changes"][0]["change"]["actions"] = actions
            with self.assertRaises(ValueError): guard["validate"](altered)
        extra = copy.deepcopy(plan); extra["resource_changes"].append({"address": "aws_ecs_service.next_api", "change": {"actions": ["update"]}})
        with self.assertRaises(ValueError): guard["validate"](extra)


class ContractTest(unittest.TestCase):
    def test_task_copies_only_reviewed_permissions_and_configuration(self):
        result = render(baseline())
        self.assertEqual(result["taskRoleArn"], r["ROLE"])
        container = result["containerDefinitions"][0]
        self.assertEqual(container["secrets"], [{"name": "FINANCE_EXPORT_WORKER_DATABASE_URL", "valueFrom": r["SECRET"]}])
        self.assertEqual(container["command"], ["node", "apps/api/dist/jobs/runFinanceDashboardExportOnce.js"])
        self.assertNotIn("healthCheck", container)
        self.assertNotIn("must-not", str(result))
        self.assertNotIn("FINANCE_EXPORT_WORKER_ENABLED", str(result))

    def test_deadline_includes_queue_delay_and_rejects_future_time(self):
        check = r["deadline_for"]
        self.assertEqual(check(EXPORT, DISPATCH, NOW), NOW + timedelta(minutes=14))
        for now in (NOW - timedelta(minutes=2), NOW + timedelta(minutes=14)):
            with self.assertRaises(ValueError):
                check(EXPORT, DISPATCH, now)
        for export in (r["OLD_EXPORT"], "bad", EXPORT.upper()):
            with self.assertRaises(ValueError):
                check(export, DISPATCH, NOW)

    def test_rejects_service_scope_secret_image_and_role_drift(self):
        source = baseline()
        variants = []
        for name, value in (("FINANCE_EXPORT_WORKER_ENABLED", "true"), ("FINANCE_EXPENSE_WORKER_PROPERTY_ID", r["PROPERTY"]), ("FINANCE_EXPORT_WORKER_EXPORT_ID", EXPORT), ("PLATFORM_MEDIA_BUCKET", "other-bucket")):
            item = copy.deepcopy(source)
            item["containerDefinitions"][0]["environment"].append({"name": name, "value": value})
            variants.append(item)
        item = copy.deepcopy(source)
        item["containerDefinitions"][0]["secrets"].append({"name": "FINANCE_EXPORT_WORKER_DATABASE_URL", "valueFrom": r["SECRET"]})
        variants.append(item)
        item = copy.deepcopy(source)
        item["containerDefinitions"][0]["image"] = "mutable:latest"
        variants.append(item)
        item = copy.deepcopy(source)
        item["executionRoleArn"] = "other-role"
        variants.append(item)
        for item in variants:
            with self.assertRaises(ValueError):
                render(item)


class ExecutionTest(unittest.TestCase):
    def execute(self, mode):
        calls = []
        clock = [NOW]
        definition = baseline()
        current = "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:999"
        registered = "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-finance-export-once:1"
        task = "arn:aws:ecs:eu-west-1:269416271598:task/test/task1"
        def fake_aws(*args):
            calls.append(args)
            action = args[1]
            if action == "describe-services":
                return {"services": [{"taskDefinition": current, "desiredCount": 1, "runningCount": 1, "pendingCount": 0, "deployments": [{"rolloutState": "COMPLETED"}], "networkConfiguration": {"awsvpcConfiguration": {}}}]}
            if action == "describe-task-definition":
                return {"taskDefinition": definition}
            if action == "list-tasks":
                return {"taskArns": [task] if "--started-by" in args else []}
            if action == "register-task-definition":
                if mode == "registration-ambiguous":
                    raise ValueError("aws_call_failed")
                return {"taskDefinition": {"taskDefinitionArn": registered}}
            if action == "run-task":
                if mode == "ambiguous":
                    raise ValueError("aws_call_failed")
                if mode in ("deadline", "stop-failure"):
                    clock[0] = NOW + timedelta(minutes=15)
                return {"tasks": [{"taskArn": task}]}
            if action == "describe-tasks":
                return {"tasks": [{"lastStatus": "STOPPED", "containers": [{"exitCode": 1 if mode == "app-failure" else 0}]}]}
            if action == "stop-task":
                if mode == "stop-failure":
                    raise ValueError("aws_call_failed")
                return {}
            if action == "deregister-task-definition":
                if mode == "deregister-failure":
                    raise ValueError("aws_call_failed")
                return {"taskDefinition": {"status": "INACTIVE"}}
            raise AssertionError(action)
        argv = ["runner", "--export-id", EXPORT, "--dispatched-at", DISPATCH, "--digest", DIGEST, "--source", SOURCE, "--expected-task", current]
        error = None
        output = io.StringIO()
        with patch.dict(r["main"].__globals__, {"aws": fake_aws, "utcnow": lambda: clock[0]}), patch("sys.argv", argv), patch.object(Path, "read_text", return_value=SOURCE + " " + DIGEST), contextlib.redirect_stdout(output):
            try:
                r["main"]()
            except ValueError as failure:
                error = str(failure)
        return calls, error, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_success_runs_once_and_deregisters_without_claiming_artifact_success(self):
        calls, error, output = self.execute("success")
        self.assertIsNone(error)
        self.assertEqual(sum(call[1] == "run-task" for call in calls), 1)
        self.assertEqual(calls[-1][1], "deregister-task-definition")
        self.assertTrue(output[-2]["cleanupVerified"])
        self.assertEqual(output[-1]["artifactAcceptance"], "requires_protected_readback")

    def test_deadline_stops_task_and_does_not_retry(self):
        calls, error, output = self.execute("deadline")
        self.assertEqual(error, "deadline_stop_required")
        self.assertEqual(sum(call[1] == "run-task" for call in calls), 1)
        self.assertIn("stop-task", [call[1] for call in calls])
        self.assertTrue(output[-1]["cleanupVerified"])

    def test_lost_run_response_reconciles_and_keeps_window_held(self):
        calls, error, output = self.execute("ambiguous")
        self.assertEqual(error, "cleanup_unverified_hold_window")
        self.assertEqual(sum(call[1] == "run-task" for call in calls), 1)
        self.assertIn("stop-task", [call[1] for call in calls])
        self.assertFalse(output[-1]["cleanupVerified"])

    def test_failed_stop_never_reports_clean(self):
        calls, error, output = self.execute("stop-failure")
        self.assertEqual(error, "cleanup_unverified_hold_window")
        self.assertFalse(output[-1]["cleanupVerified"])
        self.assertEqual(calls[-1][1], "deregister-task-definition")

    def test_unknown_registration_keeps_window_held(self):
        calls, error, output = self.execute("registration-ambiguous")
        self.assertEqual(error, "cleanup_unverified_hold_window")
        self.assertNotIn("run-task", [call[1] for call in calls])
        self.assertFalse(output[-1]["cleanupVerified"])

    def test_deregister_failure_keeps_window_held(self):
        calls, error, output = self.execute("deregister-failure")
        self.assertEqual(error, "cleanup_unverified_hold_window")
        self.assertFalse(output[-1]["cleanupVerified"])

    def test_app_failure_is_not_retried(self):
        calls, error, output = self.execute("app-failure")
        self.assertEqual(error, "app_execution_not_successful")
        self.assertEqual(sum(call[1] == "run-task" for call in calls), 1)
        self.assertTrue(output[-1]["cleanupVerified"])


if __name__ == "__main__":
    unittest.main()
