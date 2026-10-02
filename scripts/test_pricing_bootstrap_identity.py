"""Native Terraform checks on local-only fixtures. Not live IAM authorization proof."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ROOT / "infra/pricing-bootstrap-identity"
WINDOW = {"start": "2030-01-01T00:00:00Z", "end": "2030-01-01T01:00:00Z"}
SSM_KEY = "arn:aws:kms:eu-west-1:269416271598:key/3f96b311-bfda-431d-8f05-bfced29c2114"


class IdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="vay1543-identity-test-")
        cls.fixture = Path(cls.directory.name) / "infra/pricing-bootstrap-identity"
        cls.fixture.mkdir(parents=True)
        # Remove only the backend from a copy. No production state or inputs.
        source, count = re.subn(r'  backend "s3" \{[^}]+\}\n', "", (IDENTITY / "main.tf").read_text())
        assert count == 1
        (cls.fixture / "main.tf").write_text(source)
        shutil.copyfile(IDENTITY / "operator.tf", cls.fixture / "operator.tf")
        deployment = Path(cls.directory.name) / "deployment"
        deployment.mkdir()
        for name in ("pricing-operator-trust-no-mfa.json.tftpl", "pricing-operator-session-fence.json.tftpl"):
            shutil.copyfile(ROOT / "deployment" / name, deployment / name)
        shutil.copyfile(ROOT / "infra/platform_plan_policy.json.tftpl", cls.fixture.parent / "platform_plan_policy.json.tftpl")
        shutil.copyfile(IDENTITY / ".terraform.lock.hcl", cls.fixture / ".terraform.lock.hcl")
        (cls.fixture / "offline_override.tf").write_text('''provider "aws" {
  access_key = "offline-fixture"
  secret_key = "offline-fixture"
  allowed_account_ids = null
  skip_credentials_validation = true
  skip_requesting_account_id = true
  skip_metadata_api_check = true
  skip_region_validation = true
  endpoints { iam = "http://127.0.0.1:9" }
}
''')
        config = Path(cls.directory.name) / "terraformrc"
        config.write_text("")
        cls.env = {"PATH": os.environ["PATH"], "HOME": cls.directory.name,
                   "TF_CLI_CONFIG_FILE": str(config), "TF_IN_AUTOMATION": "true", "TF_INPUT": "false",
                   "AWS_EC2_METADATA_DISABLED": "true"}
        cls.run_tf("init", "-backend=false", "-lockfile=readonly",
                   "-plugin-dir=" + str(IDENTITY / ".terraform/providers"))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    @classmethod
    def run_tf(cls, *args, input=None, ok=True):
        result = subprocess.run(["terraform", *args, "-no-color"], cwd=cls.fixture, env=cls.env,
                                input=input, capture_output=True, text=True, timeout=60)
        if ok and result.returncode:
            raise AssertionError(result.stderr)
        return result

    def inspect(self, window=None, kms=None, decrypt=False, operator=None):
        args = [] if window is None else ["-var=creation_window=" + json.dumps(window)]
        if operator is not None:
            args += ["-var=operator_creation_window=" + json.dumps(operator)]
        if kms is not None:
            args += ["-var=refresh_kms_key_arns=" + json.dumps(kms)]
        args += ["-var=enable_ssm_refresh_decryption=" + str(decrypt).lower()]
        self.run_tf("plan", "-refresh=false", "-out=fixture.tfplan", *args)
        plan = json.loads(self.run_tf("show", "-json", "fixture.tfplan").stdout)
        return {item["address"]: item for item in plan.get("resource_changes", [])}

    def test_default_is_zero_and_explicit_window_only_creates_four(self):
        self.assertEqual(self.inspect(), {})
        items = self.inspect(WINDOW)
        self.assertEqual(set(items), {"aws_iam_role.creation[0]", "aws_iam_role_policy.creation[0]",
                                     "aws_iam_policy.refresh[0]", "aws_iam_role_policy_attachment.refresh[0]"})
        self.assertTrue(all(item["change"]["actions"] == ["create"] for item in items.values()))
        role = items["aws_iam_role.creation[0]"]["change"]["after"]
        trust = json.loads(role["assume_role_policy"])["Statement"][0]
        self.assertEqual(role["name"], "vayada-pricing-bootstrap-create")
        self.assertEqual(trust["Action"], "sts:AssumeRoleWithWebIdentity")
        self.assertEqual(trust["Principal"], {"Federated": "arn:aws:iam::269416271598:oidc-provider/token.actions.githubusercontent.com"})
        self.assertEqual(trust["Condition"]["DateGreaterThanEquals"], {"aws:CurrentTime": WINDOW["start"]})
        self.assertEqual(trust["Condition"]["DateLessThan"], {"aws:CurrentTime": WINDOW["end"]})
        self.assertEqual(trust["Condition"]["StringEquals"], {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": "repo:vayada-marketplace/vayada-platform:environment:pricing-bootstrap-create-v1"})
        policy = items["aws_iam_role_policy.creation[0]"]["change"]["after"]["policy"]
        self.assertLessEqual(len(policy), 10240)
        statements = json.loads(policy)["Statement"]
        refresh = items["aws_iam_policy.refresh[0]"]["change"]["after"]["policy"]
        self.assertLessEqual(len(refresh), 6144)
        statements += json.loads(refresh)["Statement"]
        self.assertEqual(len({s["Sid"] for s in statements}), len(statements))
        by_sid = {s["Sid"]: s for s in statements}
        self.assert_role_writes_denied(statements)
        self.assertEqual(by_sid["ExactProductionStateWrite"]["Resource"], "arn:aws:s3:::vayada-terraform-state/platform/terraform.tfstate")
        self.assertEqual(by_sid["BeforeWindow"]["Condition"], {"DateLessThan": {"aws:CurrentTime": WINDOW["start"]}})
        self.assertEqual(by_sid["ExpireIssuedSessions"]["Condition"], {"DateGreaterThanEquals": {"aws:CurrentTime": WINDOW["end"]}})
        self.assertEqual(by_sid["RejectEarlierSessions"]["Condition"], {"DateLessThan": {"aws:TokenIssueTime": WINDOW["start"]}})
        for sid in ("BeforeWindow", "ExpireIssuedSessions", "RejectEarlierSessions"):
            self.assertEqual((by_sid[sid]["Effect"], by_sid[sid]["Action"], by_sid[sid]["Resource"]), ("Deny", "*", "*"))
        self.assertEqual(by_sid["TerraformLock"]["Condition"]["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"],
                         ["vayada-terraform-state/platform/terraform.tfstate", "vayada-terraform-state/platform/terraform.tfstate-md5"])
        denied = set(by_sid["NeverReadOrPopulateValuesOrPassRoles"]["Action"])
        self.assertTrue({"iam:PassRole", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"} <= denied)
        self.assertEqual(by_sid["DenyAllDecrypt"], {"Sid": "DenyAllDecrypt", "Effect": "Deny", "Action": ["kms:Decrypt"], "Resource": "*"})
        self.assertNotIn("ParameterMetadata", by_sid)
        creates = [s for s in statements if s["Action"] == ["secretsmanager:CreateSecret"]]
        tags = [s for s in statements if s["Action"] == ["secretsmanager:TagResource"]]
        self.assertEqual(len(creates), 5)
        self.assertEqual(len(tags), 5)
        expected = {"identity-read-database-url", "internal-token", "owner-manage-database-url",
                    "owner-read-database-url", "public-database-url"}
        self.assertEqual({s["Condition"]["StringEquals"]["secretsmanager:Name"].removeprefix("pricing-command/prod/") for s in creates}, expected)
        for statement in creates + tags:
            self.assertTrue(statement["Resource"].endswith("-??????"))
            self.assertNotIn("*", statement["Resource"])
            self.assertIn(statement["Resource"], {"arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/" + name + "-??????" for name in expected})
            conditions = statement["Condition"]["StringEquals"]
            self.assertEqual(conditions["aws:RequestTag/Environment"], "production")
            self.assertEqual("secretsmanager:Name" in conditions, statement in creates)
        allowed_writes = {action for s in statements if s["Effect"] == "Allow" for action in s["Action"]
                          if not action.split(":")[1].startswith(("Get", "List", "Describe"))}
        self.assertEqual(allowed_writes, {"s3:PutObject", "dynamodb:PutItem", "dynamodb:DeleteItem",
                                         "secretsmanager:CreateSecret", "secretsmanager:TagResource"})

    def assert_role_writes_denied(self, statements):
        by_sid = {s["Sid"]: s for s in statements}
        self.assertNotIn("CreateDedicatedExecutionRole", by_sid)
        self.assertEqual(by_sid["NeverMutateRoles"], {
            "Sid": "NeverMutateRoles", "Effect": "Deny", "Resource": "*",
            "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:AttachRolePolicy",
                       "iam:DetachRolePolicy", "iam:DeleteRole", "iam:DeleteRolePolicy", "iam:TagRole", "iam:UntagRole",
                       "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"]})
        allowed_iam = {a for s in statements if s["Effect"] == "Allow" for a in s["Action"] if a.startswith("iam:")}
        self.assertEqual(allowed_iam, {"iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies",
                                      "iam:ListRoleTags", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"})

    def test_exact_key_metadata_without_decrypt(self):
        key = "arn:aws:kms:eu-west-1:269416271598:key/00000000-0000-0000-0000-000000000000"
        policy = self.inspect(WINDOW, [key])["aws_iam_policy.refresh[0]"]["change"]["after"]["policy"]
        keys = [s for s in json.loads(policy)["Statement"] if s["Sid"] == "ExactKeyMetadata"]
        self.assertEqual(len(keys), 1)
        self.assertEqual(keys[0]["Resource"], [key])
        self.assertEqual(set(keys[0]["Action"]), {"kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"})

    def test_selected_operator_creates_four_with_exact_phase_scope(self):
        items = self.inspect(operator=WINDOW)
        self.assertEqual(set(items), {"aws_iam_role.operator_creation[0]", "aws_iam_role_policy.operator_creation[0]",
                                     "aws_iam_policy.operator_refresh[0]", "aws_iam_role_policy_attachment.operator_refresh[0]"})
        self.assertTrue(all(item["change"]["actions"] == ["create"] for item in items.values()))
        role = items["aws_iam_role.operator_creation[0]"]["change"]["after"]
        self.assertEqual(role["name"], "vayada-pricing-operator-create")
        self.assertEqual(role["max_session_duration"], 3600)
        trust = json.loads(role["assume_role_policy"])["Statement"]
        self.assertEqual(len(trust), 1)
        self.assertEqual(trust[0]["Principal"], {"AWS": "arn:aws:iam::269416271598:user/VayadaUser"})
        self.assertEqual(trust[0]["Action"], ["sts:AssumeRole", "sts:SetSourceIdentity"])
        self.assertEqual(trust[0]["Condition"], {
            "StringEquals": {"aws:userid": "AIDAT5OTWB3XLUEYGCQ56", "sts:SourceIdentity": "AIDAT5OTWB3XLUEYGCQ56"},
            "DateGreaterThanEquals": {"aws:CurrentTime": WINDOW["start"]},
            "DateLessThan": {"aws:CurrentTime": WINDOW["end"]}})
        policies = [item["change"]["after"]["policy"] for item in items.values() if "policy" in item["change"]["after"]]
        for policy in policies:
            self.assertLessEqual(len(policy), 6144 if policy == items["aws_iam_policy.operator_refresh[0]"]["change"]["after"]["policy"] else 10240)
        statements = [s for policy in policies for s in json.loads(policy)["Statement"]]
        by_sid = {s["Sid"]: s for s in statements}
        self.assertEqual(len(by_sid), len(statements))
        execution = "arn:aws:iam::269416271598:role/vayada-pricing-command-execution"
        self.assertEqual(by_sid["CreateDedicatedExecutionRole"], {
            "Sid": "CreateDedicatedExecutionRole", "Effect": "Allow",
            "Action": ["iam:CreateRole", "iam:PutRolePolicy"], "Resource": execution})
        self.assertEqual(by_sid["NeverCreateOrWriteOtherRoles"], {
            "Sid": "NeverCreateOrWriteOtherRoles", "Effect": "Deny",
            "Action": ["iam:CreateRole", "iam:PutRolePolicy"], "NotResource": execution})
        self.assertEqual(by_sid["NeverChangeRoleTrustOrAttachments"]["Effect"], "Deny")
        self.assertEqual(by_sid["NeverChangeRoleTrustOrAttachments"]["Resource"], "*")
        self.assertEqual(set(by_sid["NeverChangeRoleTrustOrAttachments"]["Action"]), {
            "iam:UpdateAssumeRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRole",
            "iam:DeleteRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"})
        self.assertEqual(by_sid["BeforeWindow"]["Condition"], {"DateLessThan": {"aws:CurrentTime": WINDOW["start"]}})
        self.assertEqual(by_sid["ExpireIssuedSessions"]["Condition"], {"DateGreaterThanEquals": {"aws:CurrentTime": WINDOW["end"]}})
        self.assertEqual(by_sid["RejectEarlierOrMissingSessions"]["Condition"], {"DateLessThanIfExists": {"aws:TokenIssueTime": WINDOW["start"]}})
        self.assertEqual(by_sid["SelectedSourceIdentityOnly"]["Condition"], {"StringNotEqualsIfExists": {"aws:SourceIdentity": "AIDAT5OTWB3XLUEYGCQ56"}})
        for sid in ("BeforeWindow", "ExpireIssuedSessions", "RejectEarlierOrMissingSessions", "SelectedSourceIdentityOnly"):
            self.assertEqual((by_sid[sid]["Effect"], by_sid[sid]["Action"], by_sid[sid]["Resource"]), ("Deny", "*", "*"))
        self.assertEqual(by_sid["DenyAllDecrypt"], {"Sid": "DenyAllDecrypt", "Effect": "Deny", "Action": ["kms:Decrypt"], "Resource": "*"})
        self.assertNotIn("ParameterMetadata", by_sid)
        writes = {a for s in statements if s["Effect"] == "Allow" for a in s["Action"]
                  if not a.split(":")[1].startswith(("Get", "List", "Describe"))}
        self.assertEqual(writes, {"iam:CreateRole", "iam:PutRolePolicy", "s3:PutObject", "dynamodb:PutItem",
                                 "dynamodb:DeleteItem", "secretsmanager:CreateSecret", "secretsmanager:TagResource"})
        # All reused secret/state/lock/metadata statements remain byte-for-byte equivalent.
        hosted = self.inspect(WINDOW)
        for address, target in (("aws_iam_role_policy.creation[0]", "aws_iam_role_policy.operator_creation[0]"),
                                ("aws_iam_policy.refresh[0]", "aws_iam_policy.operator_refresh[0]")):
            expected = json.loads(hosted[address]["change"]["after"]["policy"])["Statement"]
            actual = json.loads(items[target]["change"]["after"]["policy"])["Statement"]
            self.assertTrue(all(s in actual for s in expected if s["Effect"] == "Allow"))
        source = (IDENTITY / "operator.tf").read_text()
        self.assertIn("depends_on = [aws_iam_role_policy.operator_creation]", source)
        self.assertEqual(source.count("prevent_destroy = true"), 4)

    def test_operator_rejects_invalid_and_mixed_admission(self):
        for window in ({"start": "bad", "end": WINDOW["end"]},
                       {"start": WINDOW["end"], "end": WINDOW["start"]},
                       {"start": WINDOW["start"], "end": WINDOW["start"]},
                       {"start": WINDOW["start"], "end": "2030-01-01T01:00:01Z"}):
            result = self.run_tf("plan", "-refresh=false", "-var=operator_creation_window=" + json.dumps(window), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Invalid value for variable", result.stderr)
        for extra in ("-var=creation_window=" + json.dumps(WINDOW), "-var=enable_ssm_refresh_decryption=true"):
            result = self.run_tf("plan", "-refresh=false", "-var=operator_creation_window=" + json.dumps(WINDOW), extra, ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Operator creation cannot overlap", result.stderr)

    def test_fences_precede_attachment_and_ci_uses_native_binary(self):
        source = (IDENTITY / "main.tf").read_text()
        for name in ("refresh", "ssm_refresh"):
            attachment = source.split(f'resource "aws_iam_role_policy_attachment" "{name}" {{', 1)[1].split("\n}", 1)[0]
            self.assertIn("depends_on = [aws_iam_role_policy.creation]", attachment)
        workflow = (ROOT / ".github/workflows/tf-validate.yml").read_text()
        setup = workflow.split("      - name: Setup Terraform\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("terraform_wrapper: false", setup)

    def test_ssm_opt_in_is_exact_and_defaults_remain_inactive(self):
        self.assertEqual(self.inspect(decrypt=True), {})
        items = self.inspect(WINDOW, decrypt=True)
        self.assertEqual(len(items), 6)
        self.assertTrue(all(item["change"]["actions"] == ["create"] for item in items.values()))
        policies = [item["change"]["after"]["policy"] for item in items.values() if "policy" in item["change"]["after"]]
        for item in items.values():
            if "policy" in item["change"]["after"]:
                self.assertLessEqual(len(item["change"]["after"]["policy"]), 6144 if item["type"] == "aws_iam_policy" else 10240)
        statements = [statement for policy in policies for statement in json.loads(policy)["Statement"]]
        by_sid = {s["Sid"]: s for s in statements}
        self.assertEqual(len(by_sid), len(statements))
        self.assert_role_writes_denied(statements)
        self.assertNotIn("ParameterMetadata", by_sid)
        self.assertNotIn("DenyAllDecrypt", by_sid)
        parameters = by_sid["ExactManagedParameterRefresh"]
        self.assertEqual(set(parameters["Action"]), {"ssm:GetParameter", "ssm:GetParameters", "ssm:ListTagsForResource"})
        self.assertTrue(all("*" not in arn and "?" not in arn for arn in parameters["Resource"]))
        # Fixed allowlist must match the root's declarations, not a live prefix scan.
        source = (ROOT / "infra/ssm.tf").read_text()
        expected = set()
        for name, prefix in (("prod_core_ssm_secrets", "prod"), ("prod_next_api_required_ssm_secrets", "prod"),
                             ("staging_pms_runtime_ssm_secrets", "staging")):
            block = source.split(name + " =", 1)[1].split("\n  }", 1)[0]
            expected.update(f"arn:aws:ssm:eu-west-1:269416271598:parameter/vayada/{prefix}/{key}"
                            for key in re.findall(r'^\s*"([a-z0-9-]+)"\s*=', block, re.M))
        conditional = source.split("prod_next_api_ssm_secrets =", 1)[1].split("\n  )", 1)[0]
        expected.update("arn:aws:ssm:eu-west-1:269416271598:parameter/vayada/prod/" + key
                        for key in re.findall(r'"([a-z0-9-]+)"\s*=', conditional))
        expected.update("arn:aws:ssm:eu-west-1:269416271598:parameter" + name
                        for name in re.findall(r'^  name\s*=\s*"(/vayada/[^"$]+)"', source, re.M))
        self.assertEqual(set(parameters["Resource"]), expected)
        self.assertEqual(len(expected), 36)
        declarations = {(path.name, name) for path in (ROOT / "infra").glob("*.tf")
                        for name in re.findall(r'resource "aws_ssm_parameter" "([^"]+)"', path.read_text())}
        self.assertEqual(declarations, {("ssm.tf", name) for name in
                         ("marketplace_database_url", "secrets", "staging_rehearsal_secrets", "next_stripe_test_secret")})
        self.assertEqual(by_sid["SSMRefreshDecrypt"], {"Sid": "SSMRefreshDecrypt", "Effect": "Allow", "Action": ["kms:Decrypt"],
                         "Resource": SSM_KEY, "Condition": {"StringEquals": {"kms:ViaService": "ssm.eu-west-1.amazonaws.com"}}})
        self.assertEqual(by_sid["DenyOtherDecryptKeys"], {"Sid": "DenyOtherDecryptKeys", "Effect": "Deny",
                         "Action": ["kms:Decrypt"], "NotResource": SSM_KEY})
        for sid, key, value in (("DenyDecryptOutsideSSM", "kms:ViaService", "ssm.eu-west-1.amazonaws.com"),
                                ("DenyDecryptOutsideManagedParameters", "kms:EncryptionContext:PARAMETER_ARN", parameters["Resource"])):
            self.assertEqual(by_sid[sid], {"Sid": sid, "Effect": "Deny", "Action": ["kms:Decrypt"], "Resource": "*",
                             "Condition": {"StringNotEqualsIfExists": {key: value}}})
        self.assertNotIn("ssm:GetParametersByPath", {a for s in statements for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])})

    def test_reject_invalid_windows_and_key_scope(self):
        for window in ({"start": "bad", "end": WINDOW["end"]},
                       {"start": WINDOW["end"], "end": WINDOW["start"]},
                       {"start": WINDOW["start"], "end": WINDOW["start"]},
                       {"start": WINDOW["start"], "end": "2030-01-01T01:00:01Z"}):
            result = self.run_tf("plan", "-refresh=false", "-var=creation_window=" + json.dumps(window), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Invalid value for variable", result.stderr)
        result = self.run_tf("plan", "-refresh=false", '-var=refresh_kms_key_arns=["arn:aws:kms:eu-west-1:269416271598:key/*"]', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid value for variable", result.stderr)


if __name__ == "__main__":
    unittest.main()
