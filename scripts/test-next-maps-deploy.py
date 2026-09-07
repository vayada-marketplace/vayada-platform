"""Offline deployment guards; never calls AWS or the owner API."""
import pathlib
import json
import urllib.error
import runpy
import unittest
from unittest.mock import MagicMock, patch

api = runpy.run_path(str(pathlib.Path(__file__).with_name("deploy-next-maps-canary.py")))


class DeploymentGuards(unittest.TestCase):
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
        conditions = [[{"Field": "path-pattern", "PathPatternConfig": {"Values": [str(i)]}}] for i in range(7)]
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
