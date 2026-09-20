"""Offline guards and composed recovery flow; these do not establish AWS IAM access."""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
SPEC = importlib.util.spec_from_file_location("fixture_scenarios", HERE / "scenarios.py")
scenarios = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scenarios)
sys.path.pop(0)
release = scenarios.release


class Interrupted(BaseException):
    pass


class MemoryAws(scenarios.ScenarioAws):
    def __init__(self, published, output):
        super().__init__(published, output)
        self.state, self.live, self.tasks = {}, {}, {}
        self.deny = False
        self.smokes = []
        for key in scenarios.SERVICES:
            self.live[key] = self.register_rendered_task(key, {}, published["variants"]["baseline"][key])

    def get_parameter(self, name):
        self.parameter(name)
        return copy.deepcopy(self.state.get(name))

    def put_parameter(self, name, value):
        self.parameter(name)
        if self.deny and name.endswith("/services/booking-admin/provenance"):
            raise release.ReleaseError("Fixture AWS ssm/put-parameter failed (AccessDenied)")
        self.state[name] = copy.deepcopy(value)

    def verify_image(self, key, image):
        assert image["digest"] in {images[key] for images in self.published["variants"].values()}

    def register_rendered_task(self, key, before, image_digest):
        arn = f"arn:aws:ecs:{scenarios.fixture.REGION}:{scenarios.fixture.ACCOUNT}:task-definition/vayada-recovery-{key}:{len(self.tasks) + 1}"
        self.tasks[arn] = {"taskDefinitionArn": arn, "digest": image_digest,
                           "serviceArn": f"arn:aws:ecs:{scenarios.fixture.REGION}:{scenarios.fixture.ACCOUNT}:service/{scenarios.fixture.CLUSTER}/vayada-recovery-{key}",
                           "image": f"{scenarios.REGISTRY}/vayada-recovery-{key}@{image_digest}"}
        return arn

    def service_snapshot(self, key):
        return copy.deepcopy(self.tasks[self.live[key]])

    def wait_service(self, key):
        pass

    def update_service(self, key, task_definition):
        self.live[key] = task_definition
        self.updates.append((key, task_definition))
        if self.interrupt:
            raise Interrupted()

    def smoke(self, runner, config, key, source):
        self.smokes.append(key)
        if self.service_snapshot(key)["digest"] == self.published["variants"]["bad"][key]:
            raise release.ReleaseError("Synthetic readiness rejected")


class ScenarioTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.published = {"scope": "isolated-recovery-scenarios-v1", "runId": 123, "runAttempt": 1,
                          "sourceSha": "a" * 40, "repository": "vayada-marketplace/vayada-platform",
                          "variants": {variant: {key: "sha256:" + digit * 64 for key in scenarios.SERVICES}
                                       for variant, digit in (("baseline", "1"), ("good", "2"), ("bad", "3"))}}
        self.path = self.directory / "publication.json"
        self.path.write_text(json.dumps(self.published))
        self.enterContext(mock.patch.dict(os.environ, {
            "GITHUB_REPOSITORY": self.published["repository"], "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "GITHUB_STEP_SUMMARY": "",
        }))
        self.cloud = self.enterContext(mock.patch.object(scenarios.fixture, "aws", side_effect=AssertionError("Unexpected cloud call")))
        self.process = self.enterContext(mock.patch.object(subprocess, "run", side_effect=AssertionError("Unexpected subprocess")))
        self.enterContext(mock.patch.object(release.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network")))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def argv(self, phase):
        return ["scenarios.py", "--phase", phase, "--publication", str(self.path),
                "--expected-baseline-sha256", "b" * 64, "--output-dir", str(self.directory)]

    def test_publication_is_bound_to_main_manual_run_and_exact_variant_images(self):
        self.assertEqual(scenarios.publication(self.path), self.published)
        mutations = [
            lambda p: p.update(repository="attacker/repo"),
            lambda p: p.update(runId=124),
            lambda p: p.update(runAttempt=2),
            lambda p: p.update(sourceSha="b" * 40),
            lambda p: p["variants"]["good"].pop("api"),
            lambda p: p["variants"]["good"].update(api="not-a-digest"),
            lambda p: p["variants"]["good"].update(api=p["variants"]["bad"]["api"]),
            lambda p: p["variants"].pop("bad"),
        ]
        for change in mutations:
            with self.subTest(change=change):
                altered = copy.deepcopy(self.published)
                change(altered)
                self.path.write_text(json.dumps(altered))
                with self.assertRaises((ValueError, release.ReleaseError)):
                    scenarios.publication(self.path)
        self.path.write_text(json.dumps(self.published))
        for variable, value in (("GITHUB_REF", "refs/heads/other"), ("GITHUB_EVENT_NAME", "push"),
                                ("GITHUB_REPOSITORY", "other/repo")):
            with self.subTest(variable=variable), mock.patch.dict(os.environ, {variable: value}):
                with self.assertRaises(ValueError):
                    scenarios.publication(self.path)
        self.cloud.assert_not_called()

    def test_phase_role_mismatch_stops_before_runner_or_mutation(self):
        for phase, role in (("exercise", "vayada-recovery-state-denial"), ("deny", "vayada-recovery-scenarios"),
                            ("recover", "vayada-recovery-state-denial")):
            with self.subTest(phase=phase):
                self.cloud.side_effect = None
                self.cloud.return_value = {"Arn": f"arn:aws:sts::{scenarios.fixture.ACCOUNT}:assumed-role/{role}/test"}
                with mock.patch.object(sys, "argv", self.argv(phase)), mock.patch.object(scenarios, "ScenarioAws") as constructor:
                    with self.assertRaisesRegex(ValueError, "Dedicated fixture role"):
                        scenarios.main()
                    constructor.assert_not_called()
        self.assertTrue(all(call.args == ("sts", "get-caller-identity") for call in self.cloud.call_args_list))

    def test_changed_baseline_stops_before_state_write_or_update(self):
        aws = mock.Mock()
        with mock.patch.object(scenarios, "inventory", return_value={"changed": True}):
            with self.assertRaisesRegex(ValueError, "baseline changed"):
                scenarios.bootstrap(aws, "0" * 64)
        self.assertEqual(aws.mock_calls, [])
        self.cloud.assert_not_called()

    def test_expected_failure_rejects_unrelated_cause(self):
        aws = MemoryAws(self.published, self.directory)
        for message in ("Synthetic readiness rejected", "Fixture AWS ecs/update-service failed (AccessDenied)"):
            with self.subTest(message=message), mock.patch.object(scenarios, "reconcile", side_effect=release.ReleaseError(message)):
                with self.assertRaisesRegex(ValueError, "Unexpected failure cause"):
                    scenarios.expect_failure(aws, "good", "booking-admin", "denial", "Fixture AWS ssm/put-parameter failed (AccessDenied)")
        self.assertEqual(aws.updates, [])

    def test_expected_ssm_denial_rolls_back_and_retains_hold_through_real_core(self):
        aws = MemoryAws(self.published, self.directory)
        before = aws.live["booking-admin"]
        aws.deny = True
        scenarios.expect_failure(aws, "good", "booking-admin", "denial", "Fixture AWS ssm/put-parameter failed (AccessDenied)")
        self.assertEqual(aws.live["booking-admin"], before)
        self.assertEqual(len(aws.updates), 2)
        self.assertEqual(scenarios.state(aws, "booking-admin", "pending-operation")["status"], "rolled-back-held")
        self.assertEqual(scenarios.state(aws, "booking-admin", "hold")["status"], "active")

    def test_private_probe_failure_and_timeout_cleanup_are_bounded(self):
        task = f"arn:aws:ecs:{scenarios.fixture.REGION}:{scenarios.fixture.ACCOUNT}:task/{scenarios.fixture.CLUSTER}/probe"
        for mode in ("negative", "readiness", "timeout", "api-error", "success"):
            def cloud(service, operation, *args):
                if operation == "register-task-definition":
                    return {"taskDefinition": {"taskDefinitionArn": "probe-definition"}}
                if operation == "run-task":
                    return {"tasks": [{"taskArn": task}]}
                if operation == "describe-tasks":
                    if mode == "api-error":
                        raise RuntimeError("probe transport failed")
                    return {"tasks": [{"lastStatus": "STOPPED", "containers": [{"exitCode": {"negative": 1, "readiness": 42}.get(mode, 0)}]}]}
                if operation == "stop-task":
                    return {}
                raise AssertionError(operation)
            with self.subTest(mode=mode):
                self.cloud.reset_mock()
                self.cloud.side_effect = cloud
                with mock.patch.object(scenarios.time, "monotonic", side_effect=[0, 241] if mode == "timeout" else [0, 1]):
                    if mode == "success":
                        scenarios.private_probe("api", "10.229.0.10", "good")
                    else:
                        with self.assertRaisesRegex((release.ReleaseError, RuntimeError), {"negative": "Probe failed", "readiness": "readiness rejected", "timeout": "timed out", "api-error": "transport"}[mode]):
                            scenarios.private_probe("api", "10.229.0.10", "good")
                stops = [call for call in self.cloud.call_args_list if call.args[1] == "stop-task"]
                self.assertEqual(len(stops), int(mode in {"timeout", "api-error"}))
                if stops:
                    self.assertIn(task, stops[0].args)

    def test_probe_rejects_nonfixture_target_before_cloud(self):
        with self.assertRaises(ValueError):
            scenarios.private_probe("api", "10.228.0.10", "good")
        self.cloud.assert_not_called()

    def test_interruption_exit_occurs_after_update_wait_and_durable_evidence(self):
        aws = scenarios.ScenarioAws(self.published, self.directory)
        aws.interrupt = True
        task = f"arn:aws:ecs:{scenarios.fixture.REGION}:{scenarios.fixture.ACCOUNT}:task-definition/vayada-recovery-api:2"
        order = []
        def terminate(code):
            self.assertEqual(code, 77)
            self.assertEqual(order, ["update", "wait"])
            evidence = json.loads((self.directory / f"updates-{os.getpid()}.json").read_text())
            self.assertEqual(evidence[0]["taskDefinitionArn"], task)
            self.assertIn("completedAt", evidence[0])
            raise Interrupted()
        with mock.patch.object(aws.runner, "run", side_effect=lambda *a: order.append("update")), \
             mock.patch.object(aws, "wait_service", side_effect=lambda key: order.append("wait")), \
             mock.patch.object(scenarios.os, "_exit", side_effect=terminate) as terminate_process:
            with self.assertRaises(Interrupted):
                aws.update_service("api", task)
            terminate_process.assert_called_once_with(77)

    def test_exercise_denial_recovery_composes_with_actual_reconciliation(self):
        aws = MemoryAws(self.published, self.directory)
        suite_path = release.state_path(aws.config, "suite")
        phase = "exercise"
        def identity(*args):
            self.assertEqual(args, ("sts", "get-caller-identity"))
            role = "vayada-recovery-state-denial" if phase == "deny" else "vayada-recovery-scenarios"
            return {"Arn": f"arn:aws:sts::{scenarios.fixture.ACCOUNT}:assumed-role/{role}/test"}
        self.cloud.side_effect = identity
        def bootstrap(instance, expected):
            self.assertIs(instance, aws)
            aws.put_parameter(suite_path, {"publicationSha256": scenarios.digest(self.published), "status": "running"})
        def child(command, **kwargs):
            self.assertIn("interrupt", command)
            with mock.patch.object(sys, "argv", command[1:]):
                try:
                    scenarios.main()
                except Interrupted:
                    return subprocess.CompletedProcess(command, 77)
                finally:
                    aws.interrupt = False
            self.fail("Child did not reach interrupted mutation")
        self.process.side_effect = child
        with mock.patch.object(scenarios, "ScenarioAws", return_value=aws), mock.patch.object(scenarios, "bootstrap", side_effect=bootstrap):
            for phase, expected in (("exercise", "awaiting-denial"), ("deny", "awaiting-recovery"), ("recover", "completed")):
                aws.deny = phase == "deny"
                with mock.patch.object(sys, "argv", self.argv(phase)):
                    scenarios.main()
                self.assertEqual(aws.get_parameter(suite_path)["status"], expected)
        for key in scenarios.SERVICES:
            self.assertEqual(aws.service_snapshot(key)["digest"], self.published["variants"]["good"][key])
            self.assertFalse(release.active_hold(aws, aws.config, key))
        self.assertTrue((self.directory / "interrupted-pending.json").is_file())
        self.assertTrue((self.directory / "state-denial-result.json").is_file())
        self.assertTrue((self.directory / "recover-state.json").is_file())
        self.process.assert_called_once()


if __name__ == "__main__":
    unittest.main()
