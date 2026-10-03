"""Render the actual Terraform locals/policy; check credential separation offline."""
import fnmatch
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "infra/hotel_setup_credentials.tf"
TEMPLATE = ROOT / "infra/hotel_setup_secret_read_policy.json.tftpl"


def render(enabled, mode="property_commands"):
    with tempfile.TemporaryDirectory() as directory:
        # Only locals/variables: no provider, backend, AWS access or state.
        text = SOURCE.read_text().split('resource "', 1)[0]
        text += (ROOT / "infra/hotel_setup_creation_bootstrap.tf").read_text().split('resource "', 1)[0]
        text += '\nvariable "aws_region" { default = "eu-west-1" }\n'
        text += '\nvariable "aws_account_id" { default = "269416271598" }\n'
        Path(directory, "main.tf").write_text(text)
        Path(directory, TEMPLATE.name).write_text(TEMPLATE.read_text())
        # Execution resource ARNs need AWS state; model only their generated suffix.
        expression = '''jsonencode({
          bootstrap_enabled=local.hotel_setup_creation_bootstrap_enabled,
          bootstrap_policy=jsondecode(local.hotel_setup_creation_bootstrap_policy),
          names=local.hotel_setup_secret_names,
          trust=jsondecode(local.hotel_setup_role_trust),
          policy=jsondecode(templatefile("hotel_setup_secret_read_policy.json.tftpl",{secret_arns=jsonencode([local.hotel_setup_native_secret_arn])})),
          execution_policy=jsondecode(templatefile("hotel_setup_secret_read_policy.json.tftpl",{secret_arns=jsonencode([for name in values(local.hotel_setup_secret_names): "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${name}-AbCd12"])}))
        })'''.replace("\n", " ")
        result = subprocess.run(
            ["terraform", "console", "-no-color", f"-var=enable_hotel_setup_credential_infrastructure={str(enabled).lower()}", f"-var=hotel_setup_command_mode={mode}"],
            input=expression + "\n", text=True, capture_output=True, cwd=directory, check=True, timeout=30)
        return json.loads(json.loads(result.stdout.strip()))


class HotelSetupCredentialsTests(unittest.TestCase):
    def test_default_off_and_no_service_or_values(self):
        self.assertEqual(render(False)["names"], {})
        self.assertFalse(render(False, "property_creation")["bootstrap_enabled"])
        self.assertFalse(render(True)["bootstrap_enabled"])
        source = SOURCE.read_text()
        self.assertRegex(source, r'default\s*=\s*false')
        self.assertEqual(source.count('count = var.enable_hotel_setup_credential_infrastructure ? 1 : 0'), 4)
        self.assertIn('prevent_destroy = true', source)
        self.assertIn('jsonencode([for secret in aws_secretsmanager_secret.hotel_setup : secret.arn])', source)
        for forbidden in ['aws_secretsmanager_secret_version', 'aws_ecs_', 'aws_iam_role_policy_attachment', 'ssm:', 'kms:', 'PassRole']:
            self.assertNotIn(forbidden, source)
        for path in (ROOT / "infra").glob("*.tf"):
            if path != SOURCE and path.name not in ["hotel_setup_service.tf", "hotel_setup_creation_bootstrap.tf"]:
                self.assertNotIn('aws_iam_role.hotel_setup_', path.read_text(), str(path))

    def test_unknown_mode_fails_closed(self):
        with self.assertRaises((subprocess.CalledProcessError, ValueError)):
            render(True, "unreviewed")

    def test_creation_reads_exclude_property_and_injected_credentials(self):
        rendered = render(True, "property_creation")
        self.assertTrue(rendered["bootstrap_enabled"])
        bootstrap, = rendered["bootstrap_policy"]["Statement"]
        self.assertEqual(bootstrap["Action"], ["secretsmanager:CreateSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"])
        self.assertEqual(rendered["names"], {
            "reader_database_url": "hotel-setup-creation/prod/reader-database-url",
            "internal_token": "hotel-setup-creation/prod/internal-token"})
        statement, = rendered["policy"]["Statement"]
        self.assertEqual(statement["Action"], ["secretsmanager:GetSecretValue"])
        pattern, = statement["Resource"]
        prefix = "arn:aws:secretsmanager:eu-west-1:269416271598:secret:"
        self.assertEqual(pattern, prefix + "hotel-setup-command/prod/organization/vayada_next_hotel_setup_org_*")
        self.assertEqual(bootstrap["Resource"], [pattern])
        self.assertTrue(fnmatch.fnmatchcase(prefix + "hotel-setup-command/prod/organization/vayada_next_hotel_setup_org_abc-AbCd12", pattern))
        for name in [*rendered["names"].values(), "hotel-setup-command/prod/property/vayada_next_hotel_setup_property_abc", "pricing-command/prod/owner-manage-database-url", "hotel-setup-command/prod/organization/postgres"]:
            self.assertFalse(fnmatch.fnmatchcase(prefix + name + "-AbCd12", pattern), name)

    def test_native_reads_are_isolated_from_injected_and_unrelated_secrets(self):
        rendered = render(True)
        self.assertEqual(rendered["names"], {
            "reader_database_url": "hotel-setup-command/prod/reader-database-url",
            "internal_token": "hotel-setup-command/prod/internal-token"})
        statement, = rendered["policy"]["Statement"]
        self.assertEqual(statement["Effect"], "Allow")
        self.assertEqual(statement["Action"], ["secretsmanager:GetSecretValue"])
        pattern, = statement["Resource"]
        prefix = "arn:aws:secretsmanager:eu-west-1:269416271598:secret:"
        self.assertEqual(pattern, prefix + "hotel-setup-command/prod/property/vayada_next_hotel_setup_property_*")
        self.assertTrue(fnmatch.fnmatchcase(prefix + "hotel-setup-command/prod/property/vayada_next_hotel_setup_property_abc-AbCd12", pattern))
        for name in [*rendered["names"].values(), "pricing-command/prod/owner-manage-database-url", "hotel-setup-command/prod/property/vayada_next_hotel_setup_reader", "hotel-setup-command/prod/property/vayada_next_hotel_setup_org_abc", "other/prod/property/vayada_next_hotel_setup_property_abc"]:
            self.assertFalse(fnmatch.fnmatchcase(prefix + name + "-AbCd12", pattern), name)
        self.assertFalse(fnmatch.fnmatchcase(pattern.replace("269416271598", "111111111111"), pattern))
        trust, = rendered["trust"]["Statement"]
        self.assertEqual(trust["Principal"], {"Service": "ecs-tasks.amazonaws.com"})
        self.assertEqual(trust["Action"], "sts:AssumeRole")
        self.assertEqual(trust["Condition"]["StringEquals"], {"aws:SourceAccount": "269416271598"})
        self.assertEqual(trust["Condition"]["ArnLike"], {"aws:SourceArn": "arn:aws:ecs:eu-west-1:269416271598:*"})

    def test_both_read_policies_exclude_candidates_and_secret_writes(self):
        prefix = "arn:aws:secretsmanager:eu-west-1:269416271598:secret:"
        for mode in ["property_commands", "property_creation"]:
            with self.subTest(mode=mode):
                rendered = render(True, mode)
                execution, = rendered["execution_policy"]["Statement"]
                resources = execution["Resource"]
                self.assertCountEqual(resources, [prefix + name + "-AbCd12" for name in rendered["names"].values()])
                self.assertTrue(all("*" not in arn and "?" not in arn for arn in resources))
                for arn in resources:
                    for altered in [arn.replace("AbCd12", "EfGh34"), arn.replace("269416271598", "111111111111"), arn.replace("eu-west-1", "eu-west-2")]:
                        self.assertNotIn(altered, resources)
                self.assertEqual(render(False, mode)["execution_policy"]["Statement"][0]["Resource"], [])
                for policy in [rendered["policy"], rendered["execution_policy"]]:
                    statement, = policy["Statement"]
                    self.assertEqual(statement["Effect"], "Allow")
                    self.assertEqual(statement["Action"], ["secretsmanager:GetSecretValue"])
                    for name in ["hotel-setup-command/prod/reader-candidate/00000000-0000-4000-8000-000000000000", "hotel-setup-command/prod/reader-candidate/vayada_next_hotel_setup_property_abc", "hotel-setup-creation/prod/reader-candidate/00000000-0000-4000-8000-000000000000"]:
                        self.assertFalse(any(fnmatch.fnmatchcase(prefix + name + "-AbCd12", arn) for arn in statement["Resource"]), name)


if __name__ == "__main__":
    unittest.main()
