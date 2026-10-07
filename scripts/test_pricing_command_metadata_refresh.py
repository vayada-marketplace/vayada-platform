"""Check the staged pricing refresh grant without AWS credentials or secret values."""
import copy
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ROLE = "arn:aws:iam::269416271598:role/vayada-pricing-command-execution"
SECRET_NAMES = ["identity-read-database-url", "owner-read-database-url",
                "owner-manage-database-url", "public-database-url", "internal-token"]
SECRETS = [f"arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/{name}-AbCd12"
           for name in SECRET_NAMES]
guard = runpy.run_path(str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"))


def render(path, values):
    text = path.read_text()
    for key, value in values.items():
        text = text.replace("${" + key + "}", value)
    return json.loads(text)


def fixture():
    resources, arns = [], []
    def resource(address, values, after=None):
        return {"address": address, "mode": "managed", "change": {
            "actions": ["no-op"] if after is None else ["update"],
            "before": values, "after": copy.deepcopy(values if after is None else after), "after_unknown": {}}}
    for key, name in sorted(guard["NAMES"].items()):
        arn = f"arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/{name}-AbCd12"
        arns.append(arn)
        resources.append(resource(f'aws_secretsmanager_secret.pricing_command["{key}"]', {
            "name": "pricing-command/prod/" + name, "arn": arn}))
    resources.append(resource(guard["ROLE"], {"name": "vayada-pricing-command-execution", "arn": ROLE}))
    resources.append(resource(guard["POLICY"], {"name": "pricing-command-exact-secret-read",
                                              "role": "vayada-pricing-command-execution",
                                              "id": "vayada-pricing-command-execution:pricing-command-exact-secret-read"}))
    additions = render(ROOT / "infra/pricing_command_metadata_policy.json.tftpl", {
        "secret_arns": json.dumps(arns), "role_arn": json.dumps(ROLE)})["Statement"]
    revoke = {"Sid": "RevokeSessionsBeforeReviewedCutover", "Effect": "Deny", "Action": "*",
              "Resource": "*", "Condition": {"DateLessThan": {"aws:TokenIssueTime": "2026-09-25T08:08:47Z"}}}
    for address, fields in (("aws_iam_role_policy.platform_plan[0]", {
            "name": "vayada-platform-plan", "role": "vayada-github-actions-platform-plan",
            "id": "vayada-github-actions-platform-plan:vayada-platform-plan"}),
            ("aws_iam_policy.platform_writer_boundary[0]", {
                "name": "vayada-platform-writer-boundary",
                "arn": "arn:aws:iam::269416271598:policy/vayada-platform-writer-boundary",
                "id": "arn:aws:iam::269416271598:policy/vayada-platform-writer-boundary"})):
        old = {"Version": "2012-10-17", "Statement": [revoke]}
        new = old | {"Statement": additions + old["Statement"]}
        resources.append(resource(address, fields | {"policy": json.dumps(old)},
                                  fields | {"policy": json.dumps(new, sort_keys=True)}))
    return {"variables": {"aws_account_id": {"value": "269416271598"},
                          "aws_region": {"value": "eu-west-1"},
                          "enable_pricing_command_credential_infrastructure": {"value": True},
                          "enable_pricing_command_metadata_refresh": {"value": True},
                          "platform_writer_boundary": {"value": {
                              "bootstrap_plan_role": True, "enforce_trust": True,
                              "revoke_before": "2026-09-25T08:08:47Z"}}},
            "resource_changes": resources}


def no_op_fixture():
    plan = fixture() | {"format_version": "1.2", "terraform_version": "1.5.7"}
    for resource in plan["resource_changes"]:
        change = resource["change"]
        change.update(actions=["no-op"], before=copy.deepcopy(change["after"]))
    return plan


class PricingMetadataTests(unittest.TestCase):
    def test_all_final_stages_require_persisted_opt_in_and_indexed_identities(self):
        for factory, check in ((fixture, guard["check_metadata"]),
                               (no_op_fixture, guard["check_no_changes"])):
            for value in (False, 1, "true", None, "missing"):
                plan = factory()
                if value == "missing":
                    plan["variables"].pop("enable_pricing_command_credential_infrastructure")
                else:
                    plan["variables"]["enable_pricing_command_credential_infrastructure"]["value"] = value
                with self.subTest(stage=factory.__name__, value=value), self.assertRaises((ValueError, KeyError)):
                    check(plan)
            for index in (5, 6):
                for moved in (False, True):
                    plan = factory()
                    resource = plan["resource_changes"][index]
                    legacy = resource["address"].removesuffix("[0]")
                    if moved:
                        resource["previous_address"] = legacy
                    else:
                        resource["address"] = legacy
                    with self.subTest(stage=factory.__name__, index=index, moved=moved), self.assertRaises((ValueError, KeyError)):
                        check(plan)

    def test_final_no_op_requires_known_unchanged_inventory_and_exact_metadata_additions(self):
        guard["check_no_changes"](no_op_fixture())
        cases = [{}, no_op_fixture() | {"resource_changes": []},
                 no_op_fixture() | {"terraform_version": "1.6.0"},
                 no_op_fixture() | {"format_version": "other"},
                 no_op_fixture() | {"errored": True},
                 no_op_fixture() | {"checks": [{"status": "unknown", "instances": []}]},
                 no_op_fixture() | {"checks": [{"status": "pass", "instances": [{"status": "fail"}]}]},
                 no_op_fixture() | {"output_changes": {
                     "value": {"actions": ["no-op"], "before": False, "after": 0}}}]
        for fields in ({"actions": ["update"]}, {"actions": ["read"]},
                       {"before": None}, {"after": {"changed": True}},
                       {"after_unknown": {"policy": True}}, {"importing": {}}):
            plan = no_op_fixture()
            plan["resource_changes"][-1]["change"].update(fields)
            cases.append(plan)
        for address in ("missing", "duplicate", "move", "drift", "output"):
            plan = no_op_fixture()
            if address == "missing":
                plan["resource_changes"].pop()
            elif address == "duplicate":
                plan["resource_changes"].append(copy.deepcopy(plan["resource_changes"][0]))
            elif address == "move":
                plan["resource_changes"][0]["previous_address"] = "old"
            elif address == "drift":
                plan["resource_drift"] = [copy.deepcopy(plan["resource_changes"][0])]
                plan["resource_drift"][0]["change"]["after"] = {"changed": True}
            else:
                plan["output_changes"] = {"value": {"actions": ["no-op"], "before": 1, "after": 2}}
            cases.append(plan)
        for index in (-2, -1):
            for mutation in (lambda d: d["Statement"].pop(0),
                             lambda d: d["Statement"].append(copy.deepcopy(d["Statement"][0])),
                             lambda d: d["Statement"][0].update(Resource="*")):
                plan = no_op_fixture()
                change = plan["resource_changes"][index]["change"]
                document = json.loads(change["after"]["policy"])
                mutation(document)
                change["before"]["policy"] = change["after"]["policy"] = json.dumps(document)
                cases.append(plan)
        for plan in cases:
            with self.subTest(plan=plan), self.assertRaises((ValueError, KeyError, TypeError)):
                guard["check_no_changes"](plan)

    def test_two_update_guard_preserves_existing_documents_regardless_of_statement_order(self):
        plan = fixture()
        guard["check_metadata"](plan)
        for resource in plan["resource_changes"][-2:]:
            after = resource["change"]["after"]
            document = json.loads(after["policy"])
            document["Statement"].reverse()
            after["policy"] = json.dumps(document)
        guard["check_metadata"](plan)

    def test_rejects_extra_grants_and_changed_existing_cutoff_or_conditions(self):
        for index in (-2, -1):
            for mutation in (lambda d: d["Statement"].append({"Effect": "Allow", "Action": "*", "Resource": "*"}),
                             lambda d: d["Statement"][0]["Action"].append("secretsmanager:GetSecretValue"),
                             lambda d: d["Statement"][0].update(Resource="*"),
                             lambda d: d["Statement"][-1].update(Condition={}),
                             lambda d: d["Statement"][-1]["Condition"]["DateLessThan"].update(
                                 {"aws:TokenIssueTime": "2026-09-25T08:09:00Z"}),
                             lambda d: d.update(Version="other")):
                plan = fixture()
                after = plan["resource_changes"][index]["change"]["after"]
                document = json.loads(after["policy"])
                mutation(document)
                after["policy"] = json.dumps(document)
                with self.assertRaises(ValueError):
                    guard["check_metadata"](plan)

    def test_rejects_wrong_physical_targets_unknowns_and_non_policy_changes(self):
        for index in (-2, -1):
            for side in ("before", "after"):
                for field in ("name", "id", "role" if index == -2 else "arn"):
                    plan = fixture()
                    plan["resource_changes"][index]["change"][side][field] = "other"
                    with self.assertRaises(ValueError):
                        guard["check_metadata"](plan)
            for fields in ({"actions": ["delete", "create"]}, {"after_unknown": {"policy": True}},
                          {"after": None}, {"importing": {}}):
                plan = fixture()
                plan["resource_changes"][index]["change"].update(fields)
                with self.assertRaises((ValueError, TypeError, AttributeError)):
                    guard["check_metadata"](plan)

    def test_rejects_incomplete_or_extra_changes_drift_moves_and_bad_stage(self):
        original = fixture()
        cases = [original | {"resource_changes": original["resource_changes"][1:]},
                 original | {"resource_changes": original["resource_changes"][:-1]},
                 original | {"resource_changes": original["resource_changes"] + [original["resource_changes"][0]]},
                 original | {"resource_drift": [{"change": {"actions": ["update"]}}]},
                 original | {"output_changes": {"secret": {"actions": ["create"]}}}]
        for index in (0, -2):
            plan = copy.deepcopy(original)
            plan["resource_changes"][index]["previous_address"] = "other"
            cases.append(plan)
        for field, value in (("aws_account_id", "other"), ("aws_region", "us-east-1"),
                             ("enable_pricing_command_metadata_refresh", False),
                             ("enable_pricing_command_metadata_refresh", 1)):
            plan = copy.deepcopy(original)
            plan["variables"][field]["value"] = value
            cases.append(plan)
        plan = copy.deepcopy(original)
        plan["resource_changes"][0]["change"]["actions"] = ["create"]
        cases.append(plan)
        plan = copy.deepcopy(original)
        plan["variables"]["platform_writer_boundary"]["value"]["enforce_trust"] = False
        cases.append(plan)
        for cutoff in (None, "2026-09-25T08:09:00Z"):
            plan = copy.deepcopy(original)
            for side in ("before", "after"):
                values = plan["resource_changes"][-1]["change"][side]
                document = json.loads(values["policy"])
                for statement in document["Statement"]:
                    if statement["Sid"] == "RevokeSessionsBeforeReviewedCutover":
                        statement["Condition"]["DateLessThan"]["aws:TokenIssueTime"] = cutoff
                values["policy"] = json.dumps(document)
            cases.append(plan)
        for plan in cases:
            with self.assertRaises((ValueError, KeyError)):
                guard["check_metadata"](plan)

    def test_rejects_unknown_changed_or_wrong_final_secret_arns_and_template_drift(self):
        for field, value in (("arn", "arn:aws:secretsmanager:eu-west-1:269416271598:secret:other-AbCd12"),
                             ("arn", None), ("name", "other")):
            plan = fixture()
            for side in ("before", "after"):
                plan["resource_changes"][0]["change"][side][field] = value
            with self.assertRaises(ValueError):
                guard["check_metadata"](plan)
        for index, field in ((5, "arn"), (6, "role"), (6, "id")):
            plan = fixture()
            for side in ("before", "after"):
                plan["resource_changes"][index]["change"][side][field] = "other"
            with self.assertRaises(ValueError):
                guard["check_metadata"](plan)
        with patch.dict(guard["check_metadata"].__globals__, METADATA_HASH="0" * 64), self.assertRaises(ValueError):
            guard["check_metadata"](fixture())

    def test_metadata_cli_is_offline_and_rejections_withhold_raw_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SECRET_SENTINEL.json"
            for plan, success in ((fixture(), True), ({"SECRET_SENTINEL": "private"}, False), ([], False)):
                path.write_text(json.dumps(plan))
                result = subprocess.run([sys.executable, str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"),
                                         "--metadata", str(path)], capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, success)
                self.assertNotIn("SECRET_SENTINEL", result.stdout + result.stderr)

    def test_only_exact_refresh_actions_and_resources(self):
        policy = render(ROOT / "infra/pricing_command_metadata_policy.json.tftpl",
                        {"secret_arns": json.dumps(SECRETS), "role_arn": json.dumps(ROLE)})
        secrets, role = policy["Statement"]
        self.assertEqual(secrets["Resource"], SECRETS)
        self.assertEqual(set(secrets["Action"]),
                         {"secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"})
        self.assertEqual(role["Resource"], ROLE)
        self.assertEqual(set(role["Action"]),
                         {"iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy",
                          "iam:ListAttachedRolePolicies"})
        for statement in policy["Statement"]:
            self.assertEqual(statement["Effect"], "Allow")
            self.assertNotIn("Condition", statement)
            for action in statement["Action"]:
                self.assertTrue(action.split(":")[1].startswith(("Get", "List", "Describe")))
                self.assertNotIn("*", action)
            self.assertNotIn("*", json.dumps(statement["Resource"]))
        base = render(ROOT / "infra/platform_plan_policy.json.tftpl",
                      {"account_id": "269416271598", "region": "eu-west-1", "kms_resources": "[]"})
        base["Statement"] += policy["Statement"]
        self.assertLess(len(json.dumps(base, separators=(",", ":"))), 10240)

    def test_default_off_and_both_policies_use_final_resource_arns(self):
        source = (ROOT / "infra/pricing_command_secrets.tf").read_text()
        self.assertRegex(source, r'variable "enable_pricing_command_metadata_refresh"\s*\{[^}]*default\s*=\s*false')
        self.assertIn("jsondecode(var.enable_pricing_command_metadata_refresh ? templatefile(", source)
        self.assertIn("}) : jsonencode({ Statement = [] })).Statement", source)
        self.assertIn("secret_arns = jsonencode([for secret in aws_secretsmanager_secret.pricing_command : secret.arn])", source)
        self.assertIn("role_arn    = jsonencode(aws_iam_role.pricing_command_execution[0].arn)", source)
        assembly = (ROOT / "infra/platform_writer_boundary.tf").read_text()
        self.assertEqual(assembly.count("local.pricing_command_metadata_statements"), 2)
        self.assertIn("RevokeSessionsBeforeReviewedCutover", assembly)


if __name__ == "__main__":
    unittest.main()
