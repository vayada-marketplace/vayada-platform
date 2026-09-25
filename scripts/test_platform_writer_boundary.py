import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("guard", ROOT / "scripts/assert-platform-writer-boundary-plan.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def plan(address, field, before, after):
    return {"resource_changes": [{"address": address, "change": {
        "before": {field: json.dumps(before)}, "after": {field: json.dumps(after)}}}]}


def revoke(cutoff):
    return {"Statement": [{"Sid": "RevokeSessionsBeforeReviewedCutover", "Effect": "Deny",
        "Action": "*", "Resource": "*", "Condition": {"DateLessThan": {"aws:TokenIssueTime": cutoff}}}]}


class BoundaryTests(unittest.TestCase):
    def test_trust_enforcement_stage_does_not_revoke_sessions(self):
        config = json.loads((ROOT / "infra/platform_writer_boundary.auto.tfvars.json").read_text())
        self.assertEqual(config["platform_writer_boundary"],
                         {"bootstrap_plan_role": True, "enforce_trust": True, "revoke_before": None})
        guard.check({"resource_changes": []})

    def test_installed_trust_cannot_be_relaxed_or_deleted(self):
        before = {"Statement": [{"Condition": {"StringEquals": {
            "token.actions.githubusercontent.com:sub": guard.SUBJECT}}}]}
        guard.check(plan(guard.ROLE, "assume_role_policy", before, before))
        for after in [{}, {"Statement": [{"Condition": {"StringLike": {
                "token.actions.githubusercontent.com:sub": "repo:vayada-marketplace/vayada-platform:*"}}}]}]:
            with self.assertRaises(ValueError):
                guard.check(plan(guard.ROLE, "assume_role_policy", before, after))

    def test_cutoff_only_advances(self):
        before = revoke("2026-09-21T12:00:00Z")
        for after in [before, revoke("2026-09-21T12:01:00Z")]:
            guard.check(plan(guard.POLICY, "policy", before, after))
        changed = revoke("2026-09-21T12:01:00Z")
        changed["Statement"][0]["Action"] = "ecs:UpdateService"
        for after in [{}, revoke("2026-09-21T11:59:59Z"), changed]:
            with self.assertRaises(ValueError):
                guard.check(plan(guard.POLICY, "policy", before, after))

    def test_attachment_cannot_be_removed_repointed_or_hidden_by_move(self):
        before = {"role": "vayada-github-actions-platform-deploy",
                  "policy_arn": "arn:aws:iam::269416271598:policy/vayada-platform-writer-boundary"}
        for after in [{}, dict(before, role="another"), dict(before, policy_arn=None)]:
            change = {"address": "aws_iam_role_policy_attachment.renamed",
                      "previous_address": guard.ATTACHMENT,
                      "change": {"before": before, "after": after}}
            with self.assertRaises(ValueError):
                guard.check({"resource_changes": [change]})
        guard.check({"resource_changes": [{"address": guard.ATTACHMENT,
                     "change": {"before": before, "after": before}}]})

    def test_physical_identity_survives_resource_rename_then_next_plan(self):
        trust = {"Statement": [{"Condition": {"StringEquals": {
            "token.actions.githubusercontent.com:sub": guard.SUBJECT}}}]}
        cases = [
            (guard.ROLE, "aws_iam_role.renamed", {"name": "vayada-github-actions-platform-deploy",
             "assume_role_policy": json.dumps(trust)}, {"name": "vayada-github-actions-platform-deploy",
             "assume_role_policy": "{}"}),
            (guard.POLICY, "aws_iam_policy.renamed", {"name": "vayada-platform-writer-boundary",
             "policy": json.dumps(revoke("2026-09-21T12:00:00Z"))},
             {"name": "vayada-platform-writer-boundary", "policy": "{}"}),
            (guard.ATTACHMENT, "aws_iam_role_policy_attachment.renamed",
             {"role": "vayada-github-actions-platform-deploy",
              "policy_arn": "arn:aws:iam::269416271598:policy/vayada-platform-writer-boundary"}, {}),
        ]
        for old_address, renamed, before, weakened in cases:
            guard.check({"resource_changes": [{"address": renamed, "previous_address": old_address,
                         "change": {"before": before, "after": before}}]})
            # Subsequent plans no longer carry previous_address.
            with self.assertRaises(ValueError):
                guard.check({"resource_changes": [{"address": renamed,
                             "change": {"before": before, "after": weakened}}]})

    def test_plan_policy_has_no_resource_writes_except_exact_lock(self):
        text = (ROOT / "infra/platform_plan_policy.json.tftpl").read_text()
        for name, value in {"account_id": "269416271598", "region": "eu-west-1",
                            "kms_resources": '["arn:aws:kms:eu-west-1:269416271598:key/test"]'}.items():
            text = text.replace("${" + name + "}", value)
        policy = json.loads(text)
        self.assertLess(len(json.dumps(policy, separators=(",", ":"))), 10240)
        writes = []
        for statement in policy["Statement"]:
            for action in statement["Action"]:
                verb = action.split(":")[1]
                self.assertNotIn("*", action)
                if not verb.startswith(("Get", "List", "Describe")):
                    writes.append((action, statement))
        self.assertEqual({a for a, _ in writes}, {"dynamodb:PutItem", "dynamodb:DeleteItem"})
        for _, statement in writes:
            self.assertEqual(statement["Resource"], "arn:aws:dynamodb:eu-west-1:269416271598:table/vayada-terraform-lock")
            self.assertEqual(statement["Condition"]["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"],
                             ["vayada-terraform-state/platform/terraform.tfstate",
                              "vayada-terraform-state/platform/terraform.tfstate-md5"])
        objects = next(s for s in policy["Statement"] if s["Sid"] == "ExactManagedObjects")
        self.assertEqual(len(objects["Resource"]), 2)
        self.assertTrue(all("*" not in arn for arn in objects["Resource"]))

    def test_migration_patch_applies_and_covers_all_callers(self):
        patch = ROOT / "deployment/platform-writer-boundary-workflows.patch"
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for name in ["deploy.yml", "tf-apply.yml", "tf-plan.yml", "rotate-rds-admin.yml"]:
                out = base / ".github/workflows" / name
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text((ROOT / ".github/workflows" / name).read_text())
            applied = subprocess.run(["git", "apply", str(patch)], cwd=base, capture_output=True)
            if applied.returncode:
                # Later reviewed migration commits must also keep this check green.
                subprocess.run(["git", "apply", "--reverse", "--check", str(patch)],
                               cwd=base, check=True, capture_output=True)
            for name, count in [("deploy.yml", 2), ("tf-apply.yml", 1), ("rotate-rds-admin.yml", 1)]:
                content = (base / ".github/workflows" / name).read_text()
                self.assertEqual(content.count("environment: platform-mutations-v2"), count)
                self.assertEqual(content.count('run: test "$WORKFLOW_REF" = refs/heads/main'), count)
            content = (base / ".github/workflows/tf-plan.yml").read_text()
            self.assertNotIn("role/vayada-github-actions-platform-deploy", content)
            self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", content)


if __name__ == "__main__":
    unittest.main()
