import copy
import io
import json
import unittest
from unittest import mock

import probe
import runner


class RunnerTests(unittest.TestCase):
    def metadata(self):
        return [{
            "serviceName": f"vayada-recovery-{key}",
            "serviceArn": f"arn:aws:ecs:{runner.REGION}:{runner.ACCOUNT}:service/{runner.CLUSTER}/vayada-recovery-{key}",
            "taskDefinition": f"arn:aws:ecs:{runner.REGION}:{runner.ACCOUNT}:task-definition/vayada-recovery-{key}:1",
            "networkConfiguration": {"awsvpcConfiguration": {"subnets": [runner.SUBNET], "securityGroups": [runner.GROUP]}},
            "runningCount": 1, "desiredCount": 1, "pendingCount": 0,
        } for key in sorted(probe.SERVICES)]

    def test_network_and_identity_drift_stop_before_mutation(self):
        for field, value in [
            ("serviceArn", "arn:aws:ecs:eu-west-1:269416271598:service/vayada-backend-cluster/live"),
            ("networkConfiguration", {"awsvpcConfiguration": {"subnets": ["subnet-live"], "securityGroups": [runner.GROUP]}}),
            ("pendingCount", 1),
            ("taskDefinition", "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1121"),
        ]:
            services = copy.deepcopy(self.metadata())
            services[0][field] = value
            with self.subTest(field=field), mock.patch.object(runner, "aws", side_effect=[
                {"Account": runner.ACCOUNT}, {"services": services},
            ]) as calls:
                with self.assertRaises(ValueError):
                    runner.inspect()
                self.assertEqual(calls.call_count, 2)

    def test_operator_credentials_cannot_launch_probe(self):
        with mock.patch.object(runner, "aws") as calls:
            with self.assertRaisesRegex(ValueError, "dedicated fixture role"):
                runner.run_probe({"Arn": f"arn:aws:iam::{runner.ACCOUNT}:user/operator"}, {})
            calls.assert_not_called()

    def test_private_probe_binds_service_and_revision(self):
        targets = {key: f"10.229.0.{index + 10}" for index, key in enumerate(sorted(probe.SERVICES))}
        for wrong_revision in (False, True):
            replies = []
            for key in sorted(targets):
                body = {"status": "ok", "service": key, "revision": "wrong" if wrong_revision else "bootstrap-v1"}
                response = io.BytesIO(json.dumps(body).encode())
                response.status = 200
                replies.append(response)
            with mock.patch.object(probe.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = replies
                if wrong_revision:
                    with self.assertRaises(ValueError):
                        probe.probe(targets)
                else:
                    self.assertEqual(len(probe.probe(targets)["services"]), 6)
                self.assertEqual(build.call_args.args[0].proxies, {})
                self.assertIsInstance(build.call_args.args[1], probe.NoRedirect)
        self.assertIsNone(probe.NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_probe_rejects_nonfixture_address(self):
        targets = dict.fromkeys(probe.SERVICES, "169.254.169.254")
        with mock.patch.object(probe.urllib.request, "build_opener") as build:
            with self.assertRaises(ValueError):
                probe.probe(targets)
            build.return_value.open.assert_not_called()

    def test_probe_exit_failure_timeout_and_cleanup(self):
        role = {"Arn": f"arn:aws:sts::{runner.ACCOUNT}:assumed-role/vayada-recovery-runner/test"}
        definition = f"arn:aws:ecs:{runner.REGION}:{runner.ACCOUNT}:task-definition/vayada-recovery-probe:1"
        task = f"arn:aws:ecs:{runner.REGION}:{runner.ACCOUNT}:task/{runner.CLUSTER}/probe1"
        for outcome in ("success", "failed", "timeout", "api-error"):
            operations = []

            def api(service, operation, *args):
                operations.append(operation)
                if operation == "register-task-definition":
                    payload = json.loads(args[1])
                    self.assertNotIn("taskRoleArn", payload)
                    self.assertEqual(payload["executionRoleArn"], runner.EXECUTION)
                    return {"taskDefinition": {"taskDefinitionArn": definition}}
                if operation == "run-task":
                    self.assertEqual(args[:2], ("--cluster", runner.CLUSTER))
                    return {"tasks": [{"taskArn": task}]}
                if operation == "describe-tasks":
                    if outcome == "api-error":
                        raise RuntimeError("bounded AWS error")
                    return {"tasks": [{"lastStatus": "RUNNING" if outcome == "timeout" else "STOPPED",
                                       "containers": [{"exitCode": 0 if outcome == "success" else 1}]}]}
                if operation == "stop-task":
                    self.assertIn(task, args)
                    return {}
                self.fail(f"Unexpected AWS mutation: {operation}")

            with self.subTest(outcome=outcome), mock.patch.object(runner, "aws", side_effect=api), \
                 mock.patch.object(runner.time, "monotonic", side_effect=[0, 1, 241]), \
                 mock.patch.object(runner.time, "sleep"):
                if outcome == "success":
                    self.assertEqual(runner.run_probe(role, {})["exitCode"], 0)
                else:
                    with self.assertRaises((RuntimeError, ValueError)):
                        runner.run_probe(role, {})
                self.assertEqual("stop-task" in operations, outcome in {"timeout", "api-error"})


if __name__ == "__main__":
    unittest.main()
