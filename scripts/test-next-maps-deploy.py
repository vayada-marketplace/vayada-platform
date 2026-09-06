"""Offline deployment guards; never calls AWS or the owner API."""
import pathlib
import runpy
import unittest
from unittest.mock import MagicMock, patch

api = runpy.run_path(str(pathlib.Path(__file__).with_name("deploy-next-maps-canary.py")))


class DeploymentGuards(unittest.TestCase):
    def test_activation_refused_before_aws(self):
        main = api["main"]
        aws = MagicMock(side_effect=AssertionError("AWS must not be called"))
        for extra in ([], ["--plan"], ["--remove"]):
            argv = ["deploy-next-maps-canary.py", "--image-sha", "next-" + "a" * 40, "--activate-guest", *extra]
            with self.subTest(extra=extra), patch("sys.argv", argv), patch.dict(main.__globals__, {"aws": aws}):
                with self.assertRaisesRegex(RuntimeError, "current active publication verification is unavailable"):
                    main()
        aws.assert_not_called()

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


if __name__ == "__main__":
    unittest.main()
