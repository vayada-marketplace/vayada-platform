import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pricing_guard", ROOT / "scripts/assert-pricing-bootstrap-plan.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
SOURCE = guard.SOURCE.read_bytes()


def fixture():
    def create(address, after, unknown=None):
        return {"address": address, "mode": "managed", "change": {
            "actions": ["create"], "before": None, "after": after,
            "after_unknown": unknown or {},
        }}
    trust = {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"},
        "Action": "sts:AssumeRole", "Condition": {
            "StringEquals": {"aws:SourceAccount": guard.ACCOUNT},
            "ArnLike": {"aws:SourceArn": f"arn:aws:ecs:{guard.REGION}:{guard.ACCOUNT}:*"},
        },
    }]}
    resources = [create(guard.ROLE, {"name": "vayada-pricing-command-execution",
                                   "assume_role_policy": json.dumps(trust)}),
                 create(guard.POLICY, {"name": "pricing-command-exact-secret-read", "policy": None, "role": None},
                        {"policy": True, "role": True})]
    resources += [create(f'aws_secretsmanager_secret.pricing_command["{key}"]', {
        "name": f"pricing-command/prod/{name}", "kms_key_id": None, "policy": None,
        "tags": {"Project": "vayada", "Environment": "production", "Purpose": f"pricing-command-{key}"},
    }) for key, name in guard.NAMES.items()]
    return {"variables": {"aws_account_id": {"value": guard.ACCOUNT},
                          "aws_region": {"value": guard.REGION},
                          "enable_pricing_command_metadata_refresh": {"value": False}},
            "resource_changes": resources, "configuration": {"root_module": {"resources": [{
                "address": guard.POLICY, "expressions": {"role": {"references": [
                    "aws_iam_role.pricing_command_execution.id", "aws_iam_role.pricing_command_execution",
                ]}, "policy": {
                    "references": ["aws_secretsmanager_secret.pricing_command"],
                }},
            }]}}}


class BootstrapPlanTest(unittest.TestCase):
    def test_exact_seven(self):
        guard.check(fixture(), SOURCE)

    def test_reject_unsafe_variations(self):
        cases = []
        def changed(label, mutate):
            plan = fixture()
            mutate(plan)
            cases.append((label, plan))
        changed("missing", lambda p: p["resource_changes"].pop())
        changed("extra", lambda p: p["resource_changes"].append(copy.deepcopy(p["resource_changes"][0])))
        changed("replacement", lambda p: p["resource_changes"][0]["change"].update(actions=["delete", "create"]))
        changed("update", lambda p: p["resource_changes"][0]["change"].update(actions=["update"]))
        changed("import", lambda p: p["resource_changes"][0]["change"].update(importing={"id": "existing"}))
        changed("move", lambda p: p["resource_changes"][0].update(previous_address="aws_iam_role.existing"))
        changed("account", lambda p: p["variables"]["aws_account_id"].update(value="111111111111"))
        changed("stage", lambda p: p["variables"]["enable_pricing_command_metadata_refresh"].update(value=True))
        changed("shared prefix", lambda p: p["resource_changes"][2]["change"]["after"].update(name="vayada/pricing-command/prod/private"))
        changed("resource policy", lambda p: p["resource_changes"][2]["change"]["after"].update(policy='{"Statement": []}'))
        changed("trust", lambda p: p["resource_changes"][0]["change"]["after"].update(assume_role_policy='{"Statement": []}'))
        changed("policy reference", lambda p: p["configuration"]["root_module"]["resources"][0]["expressions"]["policy"].update(references=["var.arbitrary_policy"]))
        changed("drift", lambda p: p.update(resource_drift=[{"change": {"actions": ["update"]}}]))
        changed("output", lambda p: p.update(output_changes={"x": {"actions": ["create"]}}))
        changed("no-op import", lambda p: p["resource_changes"].append({
            "address": "aws_iam_role.unrelated", "mode": "managed",
            "change": {"actions": ["no-op"], "importing": {"id": "existing"}},
        }))
        changed("no-op move", lambda p: p["resource_changes"].append({
            "address": "aws_iam_role.renamed", "previous_address": "aws_iam_role.old", "mode": "managed",
            "change": {"actions": ["no-op"]},
        }))
        changed("contradictory policy", lambda p: p["resource_changes"][1]["change"]["after"].update(policy='{"Resource":"*"}'))
        changed("shared role", lambda p: p["configuration"]["root_module"]["resources"][0]["expressions"]["role"].update(references=["data.aws_iam_role.ecs_task_execution.name"]))
        changed("managed policy", lambda p: p["resource_changes"][0]["change"]["after"].update(managed_policy_arns=["arn:aws:iam::aws:policy/AdministratorAccess"]))
        for label, plan in cases:
            with self.subTest(label=label), self.assertRaises((ValueError, KeyError, TypeError)):
                guard.check(plan, SOURCE)
        with self.assertRaises(ValueError):
            guard.check(fixture(), SOURCE + b"\n")

    def test_override_files_are_rejected_before_planning(self):
        for name in ("override.tf", "override.tf.json", "security_override.tf", "security_override.tf.json"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                (path / name).write_text("fixture override")
                with self.assertRaises(ValueError):
                    guard.check_source(SOURCE, path)

    def test_cli_error_does_not_echo_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            path.write_text('{"private":"SECRET_SENTINEL"}')
            result = subprocess.run([sys.executable, str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"), str(path)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("SECRET_SENTINEL", result.stdout + result.stderr)

    def test_workflow_is_plan_only_and_preserves_input_bindings(self):
        workflow = (ROOT / ".github/workflows/pricing-command-bootstrap-plan.yml").read_text()
        ordinary = (ROOT / ".github/workflows/tf-apply.yml").read_text().split("      - name: Terraform plan\n", 1)[1]
        ordinary = ordinary.split("      - name: Preserve installed", 1)[0]
        def bindings(text):
            return re.findall(r"^          TF_VAR_.*$", text, re.MULTILINE)
        self.assertEqual(bindings(workflow), bindings(ordinary))
        checkout, verification = workflow.split("      - name: Require exact reviewed current main\n", 1)
        verification, later_steps = verification.split("      - name: Allocate private transient plan directory\n", 1)
        self.assertIn("persist-credentials: false", checkout)
        self.assertIn("GH_TOKEN: ${{ github.token }}", verification)
        self.assertIn('gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha', verification)
        self.assertNotIn("GH_TOKEN", later_steps)
        self.assertNotIn("git ls-remote", workflow)
        for forbidden in ("terraform apply", "upload-artifact", "actions/cache", "-target", "--with-decryption"):
            self.assertNotIn(forbidden, workflow)
        for required in ("environment: platform-mutations-v2", "group: production-ecs-mutations",
                         'test "$WORKFLOW_REF" = refs/heads/main', 'test "$EXPECTED_SHA" = "$WORKFLOW_SHA"',
                         "assert-platform-writer-boundary-plan.py", "assert-pricing-bootstrap-plan.py",
                         "terraform_wrapper: false", "if: always()", "umask 077", "-lock-timeout=60s"):
            self.assertIn(required, workflow)
        self.assertEqual(re.findall(r"uses: ([^\s]+)", workflow), [
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd",
            "hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e"])
        self.assertIn('terraform_version: "1.5.7"', workflow)
        self.assertIn("terraform init -input=false -no-color -lockfile=readonly", workflow)

    def test_workflow_guard_failures_withhold_private_diagnostics_and_stop(self):
        workflow = (ROOT / ".github/workflows/pricing-command-bootstrap-plan.yml").read_text()
        block = workflow.split("          if ! {\n", 1)[1].split('          echo "Reviewed source:', 1)[0]
        block = textwrap.dedent("          if ! {\n" + block)
        functions = '''set -euo pipefail
umask 077
run_guard() { printf 'SECRET_SENTINEL\n'; printf 'SECRET_SENTINEL\n' >&2; [[ "$1" != *"$FAIL_GUARD"* ]]; }
python3() { run_guard "$1"; }
bash() { run_guard "$1"; }
'''
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "terraform.log"
            for index, failed in enumerate(("writer-boundary", "finance-folio", "pricing-bootstrap", "none"), 1):
                with self.subTest(failed=failed):
                    log.unlink(missing_ok=True)
                    result = subprocess.run(["bash", "-c", functions + block], capture_output=True, text=True,
                                            env={"PATH": os.environ["PATH"], "PLAN_DIR": directory, "FAIL_GUARD": failed})
                    self.assertEqual(result.returncode, 0 if failed == "none" else 1)
                    self.assertNotIn("SECRET_SENTINEL", result.stdout + result.stderr)
                    self.assertEqual(log.read_text().count("SECRET_SENTINEL"), 2 * min(index, 3))
                    self.assertEqual(log.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
