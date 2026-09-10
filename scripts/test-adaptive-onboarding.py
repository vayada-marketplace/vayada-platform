import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class AdaptiveOnboardingTest(unittest.TestCase):
    def run_flag(self, state, current_image=None, **overrides):
        task = {"family": "vayada-next-marketplace-frontend", "containerDefinitions": [
            {"name": "vayada-next-marketplace-frontend", "image": "unchanged@sha256:abc",
             "environment": [{"name": "OTHER", "value": "keep"},
                             {"name": "HOTEL_SETUP_ADAPTIVE_SHELL_ENABLED", "value": "false"}]},
            {"name": "sidecar", "environment": [{"name": "OTHER", "value": "keep"}]}]}
        original = copy.deepcopy(task)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "task.json"
            path.write_text(json.dumps(task))
            current_path = Path(directory) / "current.json"
            current = copy.deepcopy(task)
            if current_image:
                current["containerDefinitions"][0]["image"] = current_image
            current_path.write_text(json.dumps(current))
            env = {**os.environ, "ADAPTIVE_ONBOARDING": state,
                   "SERVICE": "next-marketplace-frontend", "ENVIRONMENT": "next",
                   "EVENT_NAME": "workflow_dispatch", "TASK_DEFINITION": str(path),
                   "CURRENT_TASK_DEFINITION": str(current_path), **overrides}
            result = subprocess.run(["python3", str(Path(__file__).with_name("set-adaptive-onboarding.py"))],
                                    env=env, capture_output=True)
            return result.returncode, original, json.loads(path.read_text())

    def test_toggle_only_changes_flag(self):
        for state, value in [("enabled", "true"), ("disabled", "false")]:
            code, original, actual = self.run_flag(state)
            self.assertEqual(code, 0)
            original["containerDefinitions"][0]["environment"][1]["value"] = value
            self.assertEqual(actual, original)

    def test_preserve_is_noop_for_automated_deployments(self):
        for state in ("", "preserve"):
            code, original, actual = self.run_flag(state, EVENT_NAME="repository_dispatch")
            self.assertEqual(code, 0)
            self.assertEqual(actual, original)

    def test_invalid_scopes_fail_without_writing(self):
        for overrides in ({"SERVICE": "marketplace-backend"}, {"ENVIRONMENT": "production"},
                          {"EVENT_NAME": "repository_dispatch"}, {"ADAPTIVE_ONBOARDING": "true"}):
            code, original, actual = self.run_flag("enabled", **overrides)
            self.assertNotEqual(code, 0)
            self.assertEqual(actual, original)


    def test_stale_image_fails_without_writing(self):
        code, original, actual = self.run_flag("enabled", current_image="newer@sha256:def")
        self.assertNotEqual(code, 0)
        self.assertEqual(actual, original)


if __name__ == "__main__":
    unittest.main()
