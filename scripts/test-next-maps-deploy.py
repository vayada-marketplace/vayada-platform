"""Offline deployment guards; never calls AWS or the owner API."""
import io
import os
import subprocess
import contextlib
import pathlib
import json
import urllib.error
import runpy
import unittest
from unittest.mock import MagicMock, patch

api = runpy.run_path(str(pathlib.Path(__file__).with_name("deploy-next-maps-canary.py")))


class DeploymentGuards(unittest.TestCase):
    def test_channex_secret_reference_and_disabled_capabilities(self):
        source = {"image": "pinned", "environment": [
            {"name": "PMS_CHANNEX_CONNECTION_MODE", "value": "mutating"},
            {"name": "API_BACKGROUND_WORKERS_ENABLED", "value": "false"},
            {"name": "CHANNEX_API_KEY", "value": "must-remove"}],
            "secrets": [{"name": "CHANNEX_API_KEY", "valueFrom": "production"},
                        {"name": "OTHER", "valueFrom": "preserve"}]}
        api["configure_channex_staging"](source)
        env = {e["name"]: e["value"] for e in source["environment"]}
        self.assertEqual(env["API_BACKGROUND_WORKERS_ENABLED"], "false")
        self.assertEqual(env["CHANNEX_API_BASE_URL"], "https://staging.channex.io")
        self.assertEqual(env["PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID"], api["PROPERTY"])
        self.assertNotIn("CHANNEX_API_KEY", env)
        for mode in ("CONNECTION", "PROVISIONING", "BOOKING_SYNC", "MARKUPS", "MESSAGING", "IFRAME"):
            self.assertEqual(env[f"PMS_CHANNEX_{mode}_MODE"], "observe_only")
        self.assertEqual(source["image"], "pinned")
        self.assertEqual(source["secrets"], [{"name": "OTHER", "valueFrom": "preserve"},
                         {"name": "CHANNEX_API_KEY", "valueFrom": api["CHANNEX_SECRET"]}])

    def test_meals_opt_in_scopes_config_and_route(self):
        source = {"environment": [], "secrets": []}
        api["configure_channex_staging"](source, meals=True)
        env = {e["name"]: e["value"] for e in source["environment"]}
        self.assertEqual(env["PMS_CHANNEX_STAGING_MEALS_ENABLED"], "true")
        self.assertEqual(env["PMS_CHANNEX_PROVISIONING_MODE"], "mutating")
        self.assertEqual(env["PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID"], api["PROPERTY"])
        for mode in ("CONNECTION", "BOOKING_SYNC", "MARKUPS", "MESSAGING", "IFRAME"):
            self.assertEqual(env[f"PMS_CHANNEX_{mode}_MODE"], "observe_only")
        main = api["main"]
        def aws(service, op, **kwargs):
            if op == "get-caller-identity": return {"Account": api["ACCOUNT"]}
            if op == "describe-services": return {"services": [{"taskDefinition": "baseline"}] if kwargs["services"] == ["vayada-next-api-service"] else []}
            if op == "describe-task-definition": return {"taskDefinition": {"containerDefinitions": [{"name": "vayada-next-api"}]}}
            if op == "describe-target-groups": return {"TargetGroups": []}
            if op == "describe-rules": return {"Rules": []}
            raise AssertionError(op)
        for meals in (False, True):
            args = ["deploy", "--image-sha", "next-" + "a" * 40, "--plan", "--channex-staging"]
            if meals: args.append("--channex-staging-meals")
            out = io.StringIO()
            with patch("sys.argv", args), patch.dict(main.__globals__, {"aws": aws}), contextlib.redirect_stdout(out):
                main()
            conditions = json.loads(out.getvalue())["conditions"]
            paths = [v for c in conditions for part in c for v in part.get("PathPatternConfig", {}).get("Values", [])]
            self.assertEqual([p for p in paths if "flexible-rate-plan" in p],
                             [f"/api/pms/properties/{api['PROPERTY']}/room-types/*/flexible-rate-plan"] if meals else [])

    def test_meals_require_staging_before_aws(self):
        main = api["main"]
        aws = MagicMock(side_effect=AssertionError("AWS must not be called"))
        with patch("sys.argv", ["deploy", "--image-sha", "next-" + "a" * 40, "--channex-staging-meals"]), patch.dict(main.__globals__, {"aws": aws}):
            with self.assertRaisesRegex(ValueError, "require --channex-staging"):
                main()
        aws.assert_not_called()

    def test_channex_cannot_activate_or_remove(self):
        main = api["main"]
        aws = MagicMock(side_effect=AssertionError("AWS must not be called"))
        for mode in ("--remove", "--activate-guest"):
            with patch("sys.argv", ["deploy", "--image-sha", "next-" + "a" * 40, "--channex-staging", mode]), patch.dict(main.__globals__, {"aws": aws}):
                with self.assertRaises(ValueError):
                    main()
        aws.assert_not_called()

    def test_activation_removal_conflict_before_aws(self):
        main = api["main"]
        aws = MagicMock(side_effect=AssertionError("AWS must not be called"))
        argv = ["deploy", "--image-sha", "next-" + "a" * 40, "--activate-guest", "--remove"]
        with patch("sys.argv", argv), patch.dict(main.__globals__, {"aws": aws}):
            with self.assertRaises(ValueError):
                main()
        aws.assert_not_called()

    def test_current_publication_response(self):
        verify = api["verify_active_publication"]
        valid = {"contractVersion": "public-bookability.v1", "publicVisibility": "public_safe",
                 "hotel": {"propertyId": api["PROPERTY"], "slug": api["SLUG"], "trust": {"bookabilityStatus": "bookable"}},
                 "freshness": {"status": "fresh"}}
        for change in (None, "property", "slug", "stale", "revoked", "cached", "oversize", "version"):
            profile = json.loads(json.dumps(valid))
            response = MagicMock(status=200, headers={"Cache-Control": "no-store"})
            if change == "property":
                profile["hotel"]["propertyId"] = "other"
            if change == "slug":
                profile["hotel"]["slug"] = "other"
            if change == "stale":
                profile["freshness"]["status"] = "stale"
            if change == "revoked":
                response.status = 404
            if change == "cached": response.headers = {"Cache-Control":
                "max-age=60"}
            if change == "version":
                profile["contractVersion"] = "unknown"
            response.read.return_value = b"x" * (1024 * 1024 + 1) if change == "oversize" else json.dumps(profile).encode()
            response.__enter__.return_value = response
            opener = MagicMock()
            opener.open.return_value = response
            with self.subTest(change=change), patch("urllib.request.build_opener", return_value=opener):
                if change is None:
                    verify()
                else:
                    with self.assertRaises(RuntimeError):
                        verify()
            self.assertEqual(opener.open.call_args.kwargs["timeout"], 15)
            self.assertEqual(opener.open.call_args.args[0].full_url, "https://next-api.vayada.com" + api["PROBE_PATH"])
        for error in (TimeoutError(), urllib.error.HTTPError("probe", 404, "revoked", {}, None)):
            with patch("urllib.request.build_opener") as factory:
                factory.return_value.open.side_effect = error
                with self.assertRaises(type(error)):
                    verify()
        self.assertIsNone(api["NoRedirect"]().redirect_request(None, None, 302, "", {}, "https://other.example"))

    def test_publication_failure_never_activates_guest(self):
        activate = api["activate_guest"]
        conditions = [[{"Field": "path-pattern", "PathPatternConfig": {"Values": [str(i)]}}] for i in range(8)]
        conditions[6] = [{"Field": "path-pattern", "PathPatternConfig": {"Values": [api["PROBE_PATH"]]}}]
        conditions[7] = [{"Field": "path-pattern", "PathPatternConfig": {"Values": [f"/api/pms/properties/{api["PROPERTY"]}/channex/*"]}}]
        group = {"TargetGroupArn": "canary"}
        rules = [{"Conditions": c, "RuleArn": str(i), "Actions": [{"Type": "forward", "TargetGroupArn": "canary"}]} for i, c in enumerate(conditions)]
        existing = [{"taskDefinition": "task", "deployments": [{"status": "PRIMARY", "taskDefinition": "task", "rolloutState": "COMPLETED"}]}]
        container = {"name": "vayada-next-api", "image": "image@digest", "environment": [
            {"name": "API_BACKGROUND_WORKERS_ENABLED", "value": "false"},
            {"name": "PUBLIC_HOTEL_PROFILE_SOURCE", "value": "active_publication"},
            {"name": "GOOGLE_NEARBY_ENABLED", "value": "true"}]}
        def aws(service, op, **kwargs):
            if op == "describe-task-definition": return {"taskDefinition": {"containerDefinitions":
                [container]}}
            if op == "describe-target-health": return {"TargetHealthDescriptions": [{"TargetHealth": {"State":
                "healthy"}}]}
            if op == "modify-rule":
                return {}
            raise AssertionError(op)
        for fail in (True, False):
            calls = MagicMock(side_effect=aws)
            gate = MagicMock(side_effect=RuntimeError("revoked") if fail else None)
            with patch.dict(activate.__globals__, {"aws": calls, "verify_active_publication": gate}):
                if fail:
                    with self.assertRaisesRegex(RuntimeError, "revoked"):
                        activate(existing, group, rules, conditions, "digest")
                else:
                    activate(existing, group, rules, conditions, "digest")
            mutations = [c for c in calls.call_args_list if c.args[1] == "modify-rule"]
            self.assertEqual(len(mutations), 0 if fail else 1)
            if not fail:
                self.assertEqual(mutations[0].kwargs["RuleArn"], "2")
        container["environment"][1]["value"] = "target"
        with patch.dict(activate.__globals__, {"aws": MagicMock(side_effect=aws), "verify_active_publication": MagicMock()}) as _:
            with self.assertRaises(AssertionError):
                activate(existing, group, rules, conditions, "digest")

    def test_health_configuration_preserves_nondefaults(self):
        source = dict(
            Protocol="HTTP", Port=8003, VpcId="vpc-test", TargetType="ip",
            HealthCheckEnabled=True, HealthCheckProtocol="HTTP", HealthCheckPort="8080",
            HealthCheckPath="/ready", HealthCheckIntervalSeconds=17,
            HealthCheckTimeoutSeconds=8, HealthyThresholdCount=3,
            UnhealthyThresholdCount=3, Matcher={"HttpCode": "200-399"},
        )
        self.assertEqual(api["target_group_config"]({**source, "TargetGroupArn": "ignored"}), source)
        del source["Matcher"]
        with self.assertRaises(KeyError):
            api["target_group_config"](source)

    def test_owned_conditions_reject_broadening(self):
        host = {"Field": "host-header", "HostHeaderConfig": {"Values": ["next-booking-admin.vayada.com"]}}
        cookie = {"Field": "http-header", "HttpHeaderConfig": {"HttpHeaderName": "Cookie", "Values": ["*vay1480_preview=1*"]}}
        expected = [host, cookie]
        matches = api["matching_conditions"]
        self.assertTrue(matches([cookie, {**host, "Values": host["HostHeaderConfig"]["Values"]}], expected))
        for actual in (
            [host], [host, cookie, cookie],
            [host, cookie, {"Field": "path-pattern", "PathPatternConfig": {"Values": ["/private/*"]}}],
            [{**host, "Values": ["other.example"]}, cookie],
            [{**host, "HostHeaderConfig": {"Values": ["*.vayada.com"]}}, cookie],
        ):
            with self.subTest(actual=actual):
                self.assertFalse(matches(actual, expected))



class WorkerStateChanges(unittest.TestCase):
    def fixture(self, enabled="true"):
        container = {"name": "vayada-next-api", "image": f"{api['ACCOUNT']}.dkr.ecr.{api['REGION']}.amazonaws.com/vayada-next-api@sha256:" + "b" * 64,
                     "environment": [{"name": "API_BACKGROUND_WORKERS_ENABLED", "value": "false"}, {"name": "UNRELATED", "value": "preserve"}],
                     "secrets": [{"name": "OTHER", "valueFrom": "preserve"}]}
        api["configure_channex_staging"](container, meals=True, worker_enabled=enabled)
        definition = {"containerDefinitions": [container], "cpu": "512", "memory": "1024", "taskRoleArn": "role", "revision": 15, "family": api["FAMILY"], "tags": [*api["TAGS"], {"key": "Other", "value": "keep"}], "pidMode": "task", "ipcMode": "none", "proxyConfiguration": {"type": "APPMESH", "containerName": "proxy"}, "enableFaultInjection": False}
        existing = [{"taskDefinition": "previous", "deployments": [{"status": "PRIMARY", "taskDefinition": "previous", "rolloutState": "COMPLETED"}]}]
        return existing, definition

    def test_pause_resume_preserve_every_other_task_field_and_never_touch_routes(self):
        for enabled, state, value in (("true", "paused", "false"), ("false", "running", "true")):
            existing, definition = self.fixture(enabled)
            before = json.loads(json.dumps(definition))
            def aws(aws_service, op, **kw):
                if op == "describe-images": return {"imageDetails": [{"imageDigest": "sha256:" + "b" * 64}]}
                if op == "register-task-definition": return {"taskDefinition": {"taskDefinitionArn": "changed"}}
                if op == "update-service": return {}
                if op == "describe-services": return {"services": [{"deployments": [{"status": "PRIMARY", "taskDefinition": "changed", "rolloutState": "COMPLETED"}]}]}
                raise AssertionError((aws_service, op))
            calls = MagicMock(side_effect=aws)
            fn = api["change_staging_worker"]
            with self.subTest(state=state), patch.dict(fn.__globals__, {"aws": calls}):
                fn(existing, definition, "next-" + "a" * 40, state, True)
            self.assertEqual(definition, before)
            payload = next(c.kwargs for c in calls.call_args_list if c.args[1] == "register-task-definition")
            expected = {k: v for k, v in before.items() if k != "revision"}
            next(e for e in expected["containerDefinitions"][0]["environment"] if e["name"] == "PMS_CHANNEX_WORKER_ENABLED")["value"] = value
            self.assertEqual(payload, expected)
            self.assertTrue(all(c.args[0] in ("ecs", "ecr") for c in calls.call_args_list))

    def test_plan_and_same_state_are_read_only(self):
        fn = api["change_staging_worker"]
        for enabled, plan in (("true", True), ("false", False)):
            existing, definition = self.fixture(enabled)
            calls = MagicMock(return_value={"imageDetails": [{"imageDigest": "sha256:" + "b" * 64}]})
            with patch.dict(fn.__globals__, {"aws": calls}):
                fn(existing, definition, "next-" + "a" * 40, "paused", True, plan)
            self.assertEqual([c.args[1] for c in calls.call_args_list], ["describe-images"])

    def test_invalid_runtime_or_new_image_rejected_before_mutation(self):
        fn = api["change_staging_worker"]
        for mutation in ("scope", "base", "global", "secret", "duplicate", "image", "inflight", "meals", "globalduplicate", "unknown"):
            existing, definition = self.fixture()
            c = definition["containerDefinitions"][0]
            if mutation == "scope": next(e for e in c["environment"] if e["name"] == "PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID")["value"] = "other"
            if mutation == "base": next(e for e in c["environment"] if e["name"] == "CHANNEX_API_BASE_URL")["value"] = "production"
            if mutation == "global": c["environment"][0]["value"] = "true"
            if mutation == "secret": c["secrets"][-1]["valueFrom"] = "production"
            if mutation == "duplicate": c["environment"].append({"name": "PMS_CHANNEX_WORKER_ENABLED", "value": "true"})
            if mutation == "image": c["image"] = "other@sha256:" + "c" * 64
            if mutation == "inflight": existing[0]["deployments"][0]["rolloutState"] = "IN_PROGRESS"
            if mutation == "globalduplicate": c["environment"].insert(0, {"name": "API_BACKGROUND_WORKERS_ENABLED", "value": "true"})
            if mutation == "unknown": definition["newTaskSetting"] = "preserve-or-reject"
            calls = MagicMock(return_value={"imageDetails": [{"imageDigest": "sha256:" + "b" * 64}]})
            with self.subTest(mutation=mutation), patch.dict(fn.__globals__, {"aws": calls}):
                with self.assertRaises((ValueError, AssertionError)):
                    fn(existing, definition, "next-" + "a" * 40, "paused", mutation != "meals")
            self.assertTrue(all(c.args[1] == "describe-images" for c in calls.call_args_list))

    def test_failed_rollout_restores_previous_definition(self):
        existing, definition = self.fixture()
        def aws(aws_service, op, **kw):
            if op == "describe-images": return {"imageDetails": [{"imageDigest": "sha256:" + "b" * 64}]}
            if op == "register-task-definition": return {"taskDefinition": {"taskDefinitionArn": "changed"}}
            if op == "update-service": return {}
            if op == "describe-services": return {"services": [{"deployments": [{"status": "PRIMARY", "taskDefinition": "changed", "rolloutState": "FAILED"}]}]}
            raise AssertionError(op)
        calls = MagicMock(side_effect=aws)
        fn = api["change_staging_worker"]
        with patch.dict(fn.__globals__, {"aws": calls}), self.assertRaisesRegex(RuntimeError, "rollout failed"):
            fn(existing, definition, "next-" + "a" * 40, "paused", True)
        self.assertEqual([c.kwargs["taskDefinition"] for c in calls.call_args_list if c.args[1] == "update-service"], ["changed", "previous"])

    def test_pause_survives_regular_image_configuration(self):
        _, definition = self.fixture("false")
        baseline = {"environment": [], "secrets": []}
        api["configure_channex_staging"](baseline, meals=True, worker_enabled=api["staging_worker_value"](definition))
        self.assertEqual(next(e["value"] for e in baseline["environment"] if e["name"] == "PMS_CHANNEX_WORKER_ENABLED"), "false")

    def test_workflow_guard_rejects_wrong_service_before_aws(self):
        script = pathlib.Path(__file__).with_name("validate-channex-worker-state.sh")
        for service, state, staging, environment, activation, ok in (
            ("next-maps-canary", "paused", "true", "next", "false", True),
            ("next-maps-canary", "running", "true", "next", "false", True),
            ("next-target-backend", "paused", "true", "next", "false", False),
            ("next-maps-guest", "running", "true", "next", "false", False),
            ("next-maps-canary", "paused", "false", "next", "false", False),
            ("next-maps-canary", "paused", "true", "production", "false", False),
            ("next-maps-canary", "paused", "true", "next", "true", False),
            ("next-target-backend", "preserve", "false", "production", "false", True),
        ):
            env = {**os.environ, "SERVICE": service, "CHANNEX_WORKER_STATE": state,
                   "CHANNEX_STAGING": staging, "ENVIRONMENT": environment, "ACTIVATE_GUEST": activation}
            result = subprocess.run(["bash", str(script)], env=env, capture_output=True)
            self.assertEqual(result.returncode == 0, ok, (service, state, staging, environment, activation))
        workflow = pathlib.Path(__file__).parent.parent.joinpath(".github/workflows/deploy.yml").read_text()
        for section in workflow.split("    steps:")[1:]:
            self.assertLess(section.index("bash scripts/validate-channex-worker-state.sh"), section.index("aws-actions/configure-aws-credentials"))

    def test_orphan_staging_routes_can_still_be_removed(self):
        fn = api["main"]
        condition = [{"Field": "host-header", "HostHeaderConfig": {"Values": ["next-api.vayada.com"]}},
                     {"Field": "path-pattern", "PathPatternConfig": {"Values": [f"/api/pms/properties/{api['PROPERTY']}/channex", f"/api/pms/properties/{api['PROPERTY']}/channex/*"]}}]
        def aws(aws_service, op, **kw):
            if op == "get-caller-identity": return {"Account": api["ACCOUNT"]}
            if op == "describe-services": return {"services": [{"taskDefinition": "baseline"}] if kw["services"] == ["vayada-next-api-service"] else []}
            if op == "describe-task-definition":
                assert kw["taskDefinition"] == "baseline"
                return {"taskDefinition": {"containerDefinitions": [{"name": "vayada-next-api"}]}}
            if op == "describe-target-groups": return {"TargetGroups": [{"TargetGroupName": api["GROUP"], "TargetGroupArn": "canary"}]}
            if op == "describe-tags": return {"TagDescriptions": [{"Tags": [{"Key": "Task", "Value": "VAY-1480"}]}]}
            if op == "describe-rules": return {"Rules": [{"RuleArn": "orphan", "Conditions": condition, "Actions": [{"TargetGroupArn": "canary"}]}]}
            if op == "delete-rule": return {}
            raise AssertionError(op)
        calls = MagicMock(side_effect=aws)
        with patch("sys.argv", ["deploy", "--image-sha", "next-" + "a" * 40, "--remove"]), patch.dict(fn.__globals__, {"aws": calls}):
            fn()
        self.assertEqual([c.kwargs for c in calls.call_args_list if c.args[1] == "delete-rule"], [{"RuleArn": "orphan"}])

    def test_worker_state_requires_staging_before_aws(self):
        fn = api["main"]
        calls = MagicMock()
        with patch("sys.argv", ["deploy", "--image-sha", "next-" + "a" * 40, "--channex-worker-state", "paused"]), patch.dict(fn.__globals__, {"aws": calls}):
            with self.assertRaisesRegex(ValueError, "require --channex-staging"):
                fn()
        calls.assert_not_called()


class GuestFrontendSelection(unittest.TestCase):
    def setUp(self):
        self.frontend = runpy.run_path(str(pathlib.Path(__file__).with_name("deploy-next-maps-frontends.py")))

    def test_guest_only_selection_and_legacy_default(self):
        main = self.frontend["main"]
        deploy = MagicMock()
        aws = MagicMock(return_value={"Account": self.frontend["ACCOUNT"]})
        sha, digest = "a" * 40, "sha256:" + "b" * 64
        with patch.dict(main.__globals__, {"deploy": deploy, "aws": aws}):
            main(["--guest-image-sha", "next-" + sha, "--guest-image-digest", digest])
            kind, baseline, _, host = self.frontend["SPECS"][0]
            deploy.assert_called_once_with((kind, baseline, sha, host), False, digest)
            deploy.reset_mock()
            main([])
            self.assertEqual([call.args[0] for call in deploy.call_args_list], self.frontend["SPECS"])

    def test_invalid_selection_rejected_before_aws(self):
        main = self.frontend["main"]
        aws, deploy = MagicMock(), MagicMock()
        for argv in (["--guest-image-sha", "", "--guest-image-digest", ""],
                     ["--guest-image-digest", ""],
                     ["--guest-image-sha", "next-latest"],
                     ["--guest-image-sha", "next-" + "a" * 40],
                     ["--guest-image-digest", "sha256:" + "b" * 64],
                     ["--remove", "--guest-image-sha", "next-" + "a" * 40]):
            with self.subTest(argv=argv), patch.dict(main.__globals__, {"aws": aws, "deploy": deploy}):
                with self.assertRaises(SystemExit):
                    main(argv)
        aws.assert_not_called()
        deploy.assert_not_called()

    def test_digest_mismatch_prevents_task_or_route_mutation(self):
        deploy = self.frontend["deploy"]
        def aws(service, op, **kwargs):
            if op == "describe-services":
                if kwargs["services"] == ["vayada-next-maps-guest-service"]:
                    return {"services": []}
                return {"services": [{"loadBalancers": [{"targetGroupArn": "baseline"}]}]}
            if op == "describe-target-groups":
                return {"TargetGroups": [{"TargetGroupName": "baseline", "TargetGroupArn": "baseline"}]}
            if op == "describe-rules":
                return {"Rules": [{"Priority": "10", "Actions": [{"TargetGroupArn": "baseline"}]}]}
            if op == "describe-images":
                return {"imageDetails": [{"imageDigest": "sha256:" + "c" * 64}]}
            raise AssertionError("Unexpected AWS call: " + op)
        with patch.dict(deploy.__globals__, {"aws": aws}):
            with self.assertRaisesRegex(ValueError, "digest does not match"):
                deploy(self.frontend["SPECS"][0], expected_digest="sha256:" + "b" * 64)


if __name__ == "__main__":
    unittest.main()
