"""Check the staged pricing refresh grant without AWS credentials or secret values."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
ROLE = "arn:aws:iam::269416271598:role/vayada-pricing-command-execution"
SECRET_NAMES = ["identity-read-database-url", "owner-read-database-url",
                "owner-manage-database-url", "public-database-url", "internal-token"]
SECRETS = [f"arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/{name}-AbCd12"
           for name in SECRET_NAMES]


def render(path, values):
    text = path.read_text()
    for key, value in values.items():
        text = text.replace("${" + key + "}", value)
    return json.loads(text)


class PricingMetadataTests(unittest.TestCase):
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
        self.assertIn("var.enable_pricing_command_metadata_refresh ? templatefile(", source)
        self.assertIn("jsonencode({ Statement = [] })).Statement", source)
        self.assertIn("secret_arns = jsonencode([for secret in aws_secretsmanager_secret.pricing_command : secret.arn])", source)
        self.assertIn("role_arn    = jsonencode(aws_iam_role.pricing_command_execution[0].arn)", source)
        assembly = (ROOT / "infra/platform_writer_boundary.tf").read_text()
        self.assertEqual(assembly.count("local.pricing_command_metadata_statements"), 2)
        self.assertIn("RevokeSessionsBeforeReviewedCutover", assembly)


if __name__ == "__main__":
    unittest.main()
