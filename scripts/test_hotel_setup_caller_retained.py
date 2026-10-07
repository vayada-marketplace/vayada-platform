import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("assert-hotel-setup-caller-retained.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class CallerRetainedTests(unittest.TestCase):
    def documents(self, old, new, prefix="HOTEL_SETUP_COMMAND"):
        def container(state):
            env = [] if state == "off" else [{"name": prefix + "_ADMISSION", "value": "enabled" if state == "enabled" else "blocked"}]
            secrets = []
            if state in ("enabled", "blocked"):
                env.append({"name": prefix + "_ORIGIN", "value": "https://hotel-setup-property-command.vayada.com"})
                secrets.append({"name": prefix + "_INTERNAL_TOKEN", "valueFrom": "arn:exact-token"})
            return {"environment": env, "secrets": secrets}
        return ({"taskDefinition": {"containerDefinitions": [container(old)]}}, {"planned_values": {"root_module": {"resources": [{"type": "aws_ecs_task_definition", "values": {"family": "vayada-next-api", "container_definitions": json.dumps([container(new)])}}]}}})
    def test_initial_hold_and_retained_states(self):
        for old, new in (("off", "hold"), ("hold", "hold"), ("blocked", "blocked"), ("enabled", "enabled")):
            guard.check(*self.documents(old, new))
    def test_ordinary_apply_cannot_weaken_activation(self):
        for old, new in (("hold", "off"), ("blocked", "hold"), ("enabled", "hold"), ("enabled", "blocked"), ("enabled", "off")):
            with self.assertRaises(ValueError):
                guard.check(*self.documents(old, new))
    def test_logo_pair_retained_and_paused_callers_never_reopened(self):
        for prefix in guard.PREFIXES:
            guard.check(*self.documents("enabled", "enabled", prefix))
            guard.check(*self.documents("blocked", "blocked", prefix))
            for old, new in (("enabled","off"),("blocked","hold"),("blocked","enabled"),("hold","enabled")):
                with self.assertRaises(ValueError):
                    guard.check(*self.documents(old, new, prefix))
    def test_repointed_token_denied(self):
        current, plan = self.documents("enabled", "enabled")
        task = plan["planned_values"]["root_module"]["resources"][0]["values"]
        containers = json.loads(task["container_definitions"])
        containers[0]["secrets"][0]["valueFrom"] = "arn:other-token"
        task["container_definitions"] = json.dumps(containers)
        with self.assertRaises(ValueError):
            guard.check(current, plan)

    def test_profile_caller_is_retained_once_installed_and_optional_before(self):
        self.assertEqual(guard.PREFIXES[-1], "HOTEL_SETUP_PROFILE_COMMAND")
        prefix = "HOTEL_SETUP_PROFILE_COMMAND"
        for old, new in (("off", "off"), ("off", "hold"), ("off", "blocked"), ("blocked", "blocked"), ("enabled", "enabled")):
            guard.check(*self.documents(old, new, prefix))
        for old, new in (("enabled", "off"), ("enabled", "blocked"), ("blocked", "off"), ("hold", "off"), ("blocked", "enabled")):
            with self.assertRaises(ValueError):
                guard.check(*self.documents(old, new, prefix))

    def test_creation_caller_cannot_be_disabled(self):
        with self.assertRaises(ValueError):
            guard.check(*self.documents("enabled", "blocked", "HOTEL_SETUP_CREATION_COMMAND"))

    def test_secret_admission_marker_denied_on_both_sides(self):
        for prefix in guard.PREFIXES:
            for side in ("current", "planned"):
                current, plan = self.documents("enabled", "enabled", prefix)
                task = plan["planned_values"]["root_module"]["resources"][0]["values"]
                containers = json.loads(task["container_definitions"])
                selected = current["taskDefinition"]["containerDefinitions"] if side == "current" else containers
                selected[0]["secrets"].append({"name": prefix + "_ADMISSION", "valueFrom": "arn:admission-marker"})
                task["container_definitions"] = json.dumps(containers)
                with self.assertRaises(ValueError):
                    guard.check(current, plan)
