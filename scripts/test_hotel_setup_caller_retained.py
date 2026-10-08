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
        for old, new in (("blocked", "hold"), ("enabled", "hold"), ("enabled", "blocked"), ("enabled", "off")):
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
        for old, new in (("enabled", "off"), ("enabled", "blocked"), ("blocked", "enabled")):
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

    def retirement(self, states):
        """Serving task with one state per prefix; the plan retires every caller (VAY-2056 step 4)."""
        current, plan = self.documents("off", "off")
        old = current["taskDefinition"]["containerDefinitions"][0]
        for prefix, state in zip(guard.PREFIXES, states):
            item = self.documents(state, "off", prefix)[0]["taskDefinition"]["containerDefinitions"][0]
            old["environment"] += item["environment"]
            old["secrets"] += item["secrets"]
        old["environment"].append({"name": "PMS_CHANNEX_WORKER_ENABLED", "value": "true"})
        task = plan["planned_values"]["root_module"]["resources"][0]["values"]
        task["container_definitions"] = json.dumps([{"environment": [{"name": "PMS_CHANNEX_WORKER_ENABLED", "value": "true"}], "secrets": []}])
        return current, plan

    def test_blocked_callers_may_be_retired_completely(self):
        guard.check(*self.retirement(("blocked",) * 4))
        # Profile was installed last; a never-released or held caller retires the same way.
        guard.check(*self.retirement(("blocked", "blocked", "blocked", "off")))
        guard.check(*self.retirement(("blocked", "blocked", "hold", "hold")))
        for prefix in guard.PREFIXES:
            for old in ("blocked", "hold", "off"):
                guard.check(*self.documents(old, "off", prefix))

    def test_enabled_caller_is_never_retired_by_ordinary_apply(self):
        for index in range(len(guard.PREFIXES)):
            states = ["blocked"] * 4
            states[index] = "enabled"
            with self.assertRaises(ValueError):
                guard.check(*self.retirement(states))

    def test_retirement_drops_admission_origin_and_token_together(self):
        for prefix in guard.PREFIXES:
            admission, origin, token = prefix + "_ADMISSION", prefix + "_ORIGIN", prefix + "_INTERNAL_TOKEN"
            for keep_env, keep_secrets in (([admission], []), ([origin], []), ([], [token]), ([admission, origin], []), ([origin], [token])):
                current, plan = self.documents("blocked", "blocked", prefix)
                task = plan["planned_values"]["root_module"]["resources"][0]["values"]
                containers = json.loads(task["container_definitions"])
                containers[0]["environment"] = [e for e in containers[0]["environment"] if e["name"] in keep_env]
                containers[0]["secrets"] = [e for e in containers[0]["secrets"] if e["name"] in keep_secrets]
                task["container_definitions"] = json.dumps(containers)
                with self.subTest(prefix=prefix, env=keep_env, secrets=keep_secrets), self.assertRaises(ValueError):
                    guard.check(current, plan)

    def test_retired_names_in_the_wrong_field_are_not_retirement(self):
        for prefix in guard.PREFIXES:
            current, plan = self.documents("blocked", "off", prefix)
            task = plan["planned_values"]["root_module"]["resources"][0]["values"]
            containers = json.loads(task["container_definitions"])
            containers[0]["environment"].append({"name": prefix + "_INTERNAL_TOKEN", "value": "arn:exact-token"})
            task["container_definitions"] = json.dumps(containers)
            with self.assertRaises(ValueError):
                guard.check(current, plan)
