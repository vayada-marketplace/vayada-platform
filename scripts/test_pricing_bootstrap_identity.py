"""Native Terraform checks on local-only fixtures. Not live IAM authorization proof."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ROOT / "infra/pricing-bootstrap-identity"
WINDOW = {"start": "2030-01-01T00:00:00Z", "end": "2030-01-01T01:00:00Z"}
SSM_KEY = "arn:aws:kms:eu-west-1:269416271598:key/3f96b311-bfda-431d-8f05-bfced29c2114"
spec = importlib.util.spec_from_file_location("approval", ROOT / "scripts/pricing_bootstrap_approval.py")
approval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approval)


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
        shutil.copyfile(IDENTITY / "operator_metadata.tf", cls.fixture / "operator_metadata.tf")
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

    def inspect(self, window=None, kms=None, decrypt=False, operator=None, operator_decrypt=False,
                metadata=None, metadata_decrypt=False, secret_arns=None):
        args = [] if window is None else ["-var=creation_window=" + json.dumps(window)]
        if operator is not None:
            args += ["-var=operator_creation_window=" + json.dumps(operator)]
        if kms is not None:
            args += ["-var=refresh_kms_key_arns=" + json.dumps(kms)]
        args += ["-var=enable_ssm_refresh_decryption=" + str(decrypt).lower()]
        args += ["-var=enable_operator_ssm_refresh_decryption=" + str(operator_decrypt).lower()]
        args += ["-var=enable_metadata_ssm_refresh_decryption=" + str(metadata_decrypt).lower()]
        if metadata is not None:
            args += ["-var=operator_metadata_window=" + json.dumps(metadata)]
        if secret_arns is not None:
            args += ["-var=metadata_secret_arns=" + json.dumps(secret_arns)]
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

    def test_native_two_update_metadata_plan_and_extra_grant_rejection(self):
        # Synthetic local state, real declarations/provider. Never refresh or apply.
        fixture = Path(self.directory.name) / "metadata"
        fixture.mkdir()
        for name in ("pricing_command_secrets.tf", "platform_writer_boundary.tf",
                     "pricing_command_metadata_policy.json.tftpl", "platform_plan_policy.json.tftpl",
                     "platform_writer_boundary.auto.tfvars.json"):
            shutil.copyfile(ROOT / "infra" / name, fixture / name)
        shutil.copyfile(IDENTITY / ".terraform.lock.hcl", fixture / ".terraform.lock.hcl")
        provider = (self.fixture / "offline_override.tf").read_text().replace(
            'endpoints { iam = "http://127.0.0.1:9" }', '''endpoints {
    iam = "http://127.0.0.1:9"
    secretsmanager = "http://127.0.0.1:9"
    kms = "http://127.0.0.1:9"
  }''')
        (fixture / "main.tf").write_text('''terraform {
  required_version = "~> 1.5.0"
  required_providers { aws = { source = "hashicorp/aws", version = "5.100.0" } }
}
variable "aws_account_id" { default = "269416271598" }
variable "aws_region" { default = "eu-west-1" }
resource "aws_iam_role" "github_actions_platform_deploy" {
  name = "offline-deploy-role"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [] })
}
''' + provider.replace('provider "aws" {', 'provider "aws" {\n  region = "eu-west-1"') + "\n" +
            "\n".join(f'resource "aws_kms_key" "{name}" {{ count = 0 }}' for name in (
                "finance_folio_recipient", "finance_folio_recipient_fingerprint", "finance_bank_transfer",
                "migration_rehearsal_application", "migration_rehearsal_inbox_application")))
        with patch.object(type(self), "fixture", fixture):
            self.run_tf("init", "-backend=false", "-lockfile=readonly",
                        "-plugin-dir=" + str(IDENTITY / ".terraform/providers"))
            schemas = json.loads(self.run_tf("providers", "schema", "-json").stdout)[
                "provider_schemas"]["registry.terraform.io/hashicorp/aws"]["resource_schemas"]

            def plan(enabled=False):
                (fixture / "pricing_stage.auto.tfvars.json").write_text(json.dumps({
                    "enable_pricing_command_metadata_refresh": enabled}))
                self.run_tf("plan", "-refresh=false", "-out=fixture.tfplan")
                return json.loads(self.run_tf("show", "-json", "fixture.tfplan").stdout)

            # Populate only synthetic provider-computed identities. A second native
            # plan resolves the real policy expressions against those identities.
            for _ in range(2):
                resources = {}
                for resource in plan()["resource_changes"]:
                    attributes = resource["change"]["after"]
                    kind = resource["type"]
                    name = attributes.get("name")
                    if "tags_all" in schemas[kind]["block"]["attributes"] and attributes.get("tags_all") is None:
                        attributes["tags_all"] = attributes.get("tags") or {}
                    if kind == "aws_secretsmanager_secret":
                        attributes.update(arn=f"arn:aws:secretsmanager:eu-west-1:269416271598:secret:{name}-AbCd12")
                        attributes["id"] = attributes["arn"]
                    elif kind in ("aws_iam_role", "aws_iam_policy"):
                        prefix = "role" if kind == "aws_iam_role" else "policy"
                        attributes.update(arn=f"arn:aws:iam::269416271598:{prefix}/{name}")
                        attributes["id"] = name if kind == "aws_iam_role" else attributes["arn"]
                        if kind == "aws_iam_role":
                            attributes.update(unique_id="AROAOFFLINEFIXTURE", create_date="2030-01-01T00:00:00Z",
                                              inline_policy=[], managed_policy_arns=[])
                    elif kind == "aws_iam_role_policy":
                        attributes.setdefault("role", "vayada-pricing-command-execution" if
                                              name == "pricing-command-exact-secret-read" else "vayada-github-actions-platform-plan")
                        attributes["id"] = f'{attributes["role"]}:{name}'
                    elif kind == "aws_iam_role_policy_attachment":
                        attributes["id"] = "offline-attachment"
                        attributes.setdefault("policy_arn", "arn:aws:iam::269416271598:policy/vayada-platform-writer-boundary")
                    instance = {"schema_version": schemas[kind]["version"], "attributes": attributes}
                    if "index" in resource:
                        instance["index_key"] = resource["index"]
                    resources.setdefault((kind, resource["name"]), {
                        "mode": "managed", "type": kind, "name": resource["name"],
                        "provider": 'provider["registry.terraform.io/hashicorp/aws"]', "instances": []
                    })["instances"].append(instance)
                (fixture / "terraform.tfstate").write_text(json.dumps({
                    "version": 4, "terraform_version": "1.5.7", "serial": 1,
                    "lineage": "00000000-0000-0000-0000-000000000000", "outputs": {}, "resources": list(resources.values())}))
            self.assertEqual([(r["address"], r["change"]) for r in plan()["resource_changes"]
                              if r["change"]["actions"] != ["no-op"]], [])
            guard = runpy.run_path(str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"))["check_metadata"]
            enabled = plan(True)
            self.assertIs(enabled["variables"]["enable_pricing_command_metadata_refresh"]["value"], True)
            guard(enabled)
            if hasattr(os, "memfd_create"):
                # Native sealed bytes pass writer/metadata checks. This partial
                # fixture lacks Finance state, so the full-root guard must reject.
                saved = fixture / "fixture.tfplan"
                saved.chmod(0o600)
                digest = hashlib.sha256(saved.read_bytes()).hexdigest()
                with approval.sealed_saved_plan(saved, digest) as fd:
                    native = subprocess.run
                    calls = []
                    def inspect(*args, **kwargs):
                        result = native(*args, **kwargs)
                        calls.append(result)
                        return result
                    with patch.object(approval.subprocess, "run", side_effect=inspect):
                        with self.assertRaisesRegex(ValueError, "guards rejected"):
                            approval.guard_saved_plan(fd, digest, phase="metadata")
                    self.assertEqual(len(calls), 3)
                    self.assertTrue(all(result.returncode == 0 for result in calls[:2]))
                    self.assertEqual(json.loads(calls[1].stdout), enabled)
                    self.assertNotEqual(calls[2].returncode, 0)
                    self.assertIn("Cannot prove a unique Finance KMS plan phase.", calls[2].stderr)
                    with self.assertRaisesRegex(ValueError, "guards rejected"):
                        approval.guard_saved_plan(fd, digest)
            # Local synthetic state only: resolve the final installed metadata
            # expressions without apply, refresh, a backend or AWS calls.
            state_path = fixture / "terraform.tfstate"
            state = json.loads(state_path.read_text())
            for resource in state["resources"]:
                for instance in resource["instances"]:
                    address = resource["type"] + "." + resource["name"]
                    if "index_key" in instance:
                        address += "[" + json.dumps(instance["index_key"]) + "]"
                    instance["attributes"] = next(r["change"]["after"] for r in enabled["resource_changes"]
                                                   if r["address"] == address)
            state_path.write_text(json.dumps(state))
            final = plan(True)
            runpy.run_path(str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"))["check_no_changes"](final)
            template = fixture / "pricing_command_metadata_policy.json.tftpl"
            template.write_text(template.read_text().replace(
                '"secretsmanager:DescribeSecret"', '"secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"'))
            with self.assertRaisesRegex(ValueError, "Only exact metadata statements"):
                guard(plan(True))

    @unittest.skipUnless(hasattr(os, "memfd_create"), "Requires native Linux sealing")
    def test_native_terraform_reads_the_sealed_plan_after_original_removal(self):
        expected = self.inspect(operator=WINDOW, operator_decrypt=True)
        path = self.fixture / "fixture.tfplan"
        path.chmod(0o600)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with approval.sealed_saved_plan(path, digest) as fd:
            path.unlink()
            result = subprocess.run(["terraform", "show", "-json", f"/proc/self/fd/{fd}"],
                                    cwd=self.fixture, env=self.env, pass_fds=(fd,),
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, "Native Terraform could not read sealed plan")
            actual = {item["address"]: item for item in json.loads(result.stdout)["resource_changes"]}
            self.assertEqual(actual, expected)
            self.assertEqual(len(actual), 8)
            # A genuine native saved plan is not enough: these eight IAM
            # prerequisite additions must fail the pricing seven-create guard.
            native_run = subprocess.run
            observed = []
            def inspect(*args, **kwargs):
                result = native_run(*args, **kwargs)
                observed.append(result)
                return result
            with patch.object(approval.subprocess, "run", side_effect=inspect), \
                    self.assertRaisesRegex(ValueError, "guards rejected"):
                approval.guard_saved_plan(fd, digest)
            self.assertEqual(len(observed), 2)
            self.assertEqual(observed[0].returncode, 0, "Native version observation failed")
            runtime = json.loads(observed[0].stdout)
            self.assertEqual(runtime["terraform_version"], "1.5.7")
            self.assertEqual(runtime["platform"], "linux_amd64")
            self.assertEqual(runtime["provider_selections"], {
                "registry.terraform.io/hashicorp/aws": "5.100.0",
                "registry.terraform.io/cloudflare/cloudflare": "4.52.7"})
            self.assertEqual(observed[1].returncode, 0, "Native guarded inspection failed")
            self.assertEqual(len(json.loads(observed[1].stdout)["resource_changes"]), 8)

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
        self.assertEqual(source.count("prevent_destroy = true"), 8)

    def test_operator_ssm_opt_in_reuses_exact_scope_without_widening_other_phases(self):
        self.assertEqual(self.inspect(operator_decrypt=True, decrypt=True), {})
        baseline = self.inspect(operator=WINDOW)
        items = self.inspect(operator=WINDOW, operator_decrypt=True)
        self.assertEqual(set(items), set(baseline) | {
            "aws_iam_policy.operator_ssm_refresh[0]", "aws_iam_role_policy_attachment.operator_ssm_refresh[0]",
            "aws_iam_policy.operator_decrypt[0]", "aws_iam_role_policy_attachment.operator_decrypt[0]"})
        self.assertTrue(all(item["change"]["actions"] == ["create"] for item in items.values()))
        hosted = self.inspect(WINDOW, decrypt=True)
        self.assertEqual(items["aws_iam_policy.operator_ssm_refresh[0]"]["change"]["after"]["policy"],
                         hosted["aws_iam_policy.ssm_refresh[0]"]["change"]["after"]["policy"])
        self.assertEqual(items["aws_iam_role.operator_creation[0]"]["change"]["after"],
                         baseline["aws_iam_role.operator_creation[0]"]["change"]["after"])
        self.assertEqual(items["aws_iam_policy.operator_refresh[0]"]["change"]["after"],
                         baseline["aws_iam_policy.operator_refresh[0]"]["change"]["after"])
        def policy(plan, address):
            return json.loads(plan[address]["change"]["after"]["policy"])["Statement"]

        actual = policy(items, "aws_iam_role_policy.operator_creation[0]")
        unchanged = [s for s in policy(baseline, "aws_iam_role_policy.operator_creation[0]") if s["Sid"] != "DenyAllDecrypt"]
        decrypt = [s for s in policy(hosted, "aws_iam_role_policy.creation[0]") if s["Sid"] in {
            "SSMRefreshDecrypt", "DenyOtherDecryptKeys", "DenyDecryptOutsideSSM", "DenyDecryptOutsideManagedParameters"}]
        self.assertEqual(actual, unchanged)
        self.assertEqual(policy(items, "aws_iam_policy.operator_decrypt[0]"), decrypt)
        for item in items.values():
            if "policy" in item["change"]["after"]:
                self.assertLessEqual(len(item["change"]["after"]["policy"]), 6144 if item["type"] == "aws_iam_policy" else 10240)
        # The operator opt-in cannot enable SSM access on the hosted role.
        hosted_without_decrypt = self.inspect(WINDOW, operator_decrypt=True)
        self.assertEqual(len(hosted_without_decrypt), 4)
        self.assertIn("DenyAllDecrypt", {s["Sid"] for s in policy(hosted_without_decrypt, "aws_iam_role_policy.creation[0]")})
        source = (IDENTITY / "operator.tf").read_text()
        attachment = source.split('resource "aws_iam_role_policy_attachment" "operator_ssm_refresh" {', 1)[1].split("\n}", 1)[0]
        self.assertIn("depends_on = [aws_iam_role_policy.operator_creation, aws_iam_role_policy_attachment.operator_decrypt]", attachment)
        decrypt_attachment = source.split('resource "aws_iam_role_policy_attachment" "operator_decrypt" {', 1)[1].split("\n}", 1)[0]
        self.assertIn("depends_on = [aws_iam_role_policy.operator_creation]", decrypt_attachment)

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

    def test_metadata_operator_is_distinct_inactive_and_exactly_scoped(self):
        names = runpy.run_path(str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"))["NAMES"]
        arns = {key: f"arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/{name}-AbCd12"
                for key, name in names.items()}
        self.assertEqual(self.inspect(metadata_decrypt=True, secret_arns=arns), {})
        items = self.inspect(metadata=WINDOW, secret_arns=arns)
        expected = {"aws_iam_role.operator_metadata[0]", "aws_iam_role_policy.operator_metadata[0]",
                    "aws_iam_policy.metadata_refresh[0]", "aws_iam_role_policy_attachment.metadata_refresh[0]"}
        self.assertEqual(set(items), expected)
        self.assertTrue(all(r["change"]["actions"] == ["create"] for r in items.values()))
        role = items["aws_iam_role.operator_metadata[0]"]["change"]["after"]
        self.assertEqual(role["name"], "vayada-pricing-operator-metadata")
        creation = self.inspect(operator=WINDOW)
        self.assertEqual(role["assume_role_policy"], creation["aws_iam_role.operator_creation[0]"]["change"]["after"]["assume_role_policy"])
        self.assertEqual(role["max_session_duration"], 3600)
        def statements(plan, address):
            item = plan[address]
            policy = item["change"]["after"]["policy"]
            self.assertLessEqual(len(policy), 6144 if item["type"] == "aws_iam_policy" else 10240)
            return json.loads(policy)["Statement"]

        inline = statements(items, "aws_iam_role_policy.operator_metadata[0]")
        refresh = statements(items, "aws_iam_policy.metadata_refresh[0]")
        by_sid = {s["Sid"]: s for s in inline + refresh}
        self.assertEqual(len(by_sid), len(inline + refresh))
        plan_role = "arn:aws:iam::269416271598:role/vayada-github-actions-platform-plan"
        boundary = "arn:aws:iam::269416271598:policy/vayada-platform-writer-boundary"
        self.assertEqual(by_sid["UpdateExistingPlanRolePolicy"], {
            "Sid": "UpdateExistingPlanRolePolicy", "Effect": "Allow", "Action": ["iam:PutRolePolicy"], "Resource": plan_role})
        self.assertEqual(by_sid["CreateReviewedBoundaryVersion"], {
            "Sid": "CreateReviewedBoundaryVersion", "Effect": "Allow", "Action": ["iam:CreatePolicyVersion"], "Resource": boundary})
        self.assertEqual(by_sid["NeverWriteOtherRolePolicies"], {
            "Sid": "NeverWriteOtherRolePolicies", "Effect": "Deny", "Action": ["iam:PutRolePolicy"], "NotResource": plan_role})
        self.assertEqual(by_sid["NeverVersionOtherPolicies"], {
            "Sid": "NeverVersionOtherPolicies", "Effect": "Deny", "Action": ["iam:CreatePolicyVersion"], "NotResource": boundary})
        writes = {a for s in inline + refresh if s["Effect"] == "Allow" for a in s["Action"]
                  if not a.split(":")[1].startswith(("Get", "List", "Describe"))}
        self.assertEqual(writes, {"iam:PutRolePolicy", "iam:CreatePolicyVersion", "s3:PutObject", "dynamodb:PutItem", "dynamodb:DeleteItem"})
        self.assertTrue({"iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:CreateRole", "iam:UpdateAssumeRolePolicy",
                         "iam:AttachRolePolicy", "iam:DeleteRolePolicy"} <= set(by_sid["NeverChangeOtherIAMOrRetireVersions"]["Action"]))
        self.assertEqual((by_sid["NeverChangeOtherIAMOrRetireVersions"]["Effect"],
                          by_sid["NeverChangeOtherIAMOrRetireVersions"]["Resource"]), ("Deny", "*"))
        self.assertEqual(by_sid["NeverCreatePricingContainers"]["Effect"], "Deny")
        self.assertEqual(by_sid["NeverCreatePricingContainers"]["Resource"], "*")
        self.assertEqual(by_sid["VerifyFinalPricingSecretMetadata"]["Resource"], [arns[k] for k in sorted(arns)])
        self.assertEqual(by_sid["DenyAllDecrypt"], {"Sid": "DenyAllDecrypt", "Effect": "Deny", "Action": ["kms:Decrypt"], "Resource": "*"})
        creation_inline = statements(creation, "aws_iam_role_policy.operator_creation[0]")
        for sid in ("BeforeWindow", "ExpireIssuedSessions", "RejectEarlierOrMissingSessions", "SelectedSourceIdentityOnly",
                    "NeverPassOrChainRoles", "NeverReadOrPopulateValuesOrPassRoles", "ExactProductionStateWrite"):
            self.assertEqual(by_sid[sid], next(s for s in creation_inline if s["Sid"] == sid))
        opted = self.inspect(metadata=WINDOW, secret_arns=arns, metadata_decrypt=True)
        self.assertEqual(set(opted), expected | {
            "aws_iam_policy.metadata_ssm_refresh[0]", "aws_iam_policy.metadata_decrypt[0]",
            "aws_iam_role_policy_attachment.metadata_ssm_refresh[0]", "aws_iam_role_policy_attachment.metadata_decrypt[0]"})
        self.assertEqual(statements(opted, "aws_iam_policy.metadata_ssm_refresh[0]"), json.loads(
            self.inspect(operator=WINDOW, operator_decrypt=True)["aws_iam_policy.operator_ssm_refresh[0]"]["change"]["after"]["policy"])["Statement"])
        self.assertNotIn("DenyAllDecrypt", {s["Sid"] for s in statements(opted, "aws_iam_role_policy.operator_metadata[0]")})
        self.assertEqual(statements(opted, "aws_iam_policy.metadata_decrypt[0]"), json.loads(
            self.inspect(operator=WINDOW, operator_decrypt=True)["aws_iam_policy.operator_decrypt[0]"]["change"]["after"]["policy"])["Statement"])
        unchanged = self.inspect(operator=WINDOW, metadata_decrypt=True)
        self.assertEqual(unchanged, creation)
        source = (IDENTITY / "operator_metadata.tf").read_text()
        self.assertEqual(source.count("prevent_destroy = true"), 8)
        for name, dependency in (("metadata_refresh", "[aws_iam_role_policy.operator_metadata]"),
                                 ("metadata_decrypt", "[aws_iam_role_policy.operator_metadata]"),
                                 ("metadata_ssm_refresh", "[aws_iam_role_policy.operator_metadata, aws_iam_role_policy_attachment.metadata_decrypt]")):
            attachment = source.split(f'resource "aws_iam_role_policy_attachment" "{name}" {{', 1)[1].split("\n}", 1)[0]
            self.assertIn("depends_on = " + dependency, attachment)

    def test_metadata_operator_rejects_unknown_identity_invalid_window_and_overlap(self):
        names = runpy.run_path(str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"))["NAMES"]
        arns = {key: f"arn:aws:secretsmanager:eu-west-1:269416271598:secret:pricing-command/prod/{name}-AbCd12"
                for key, name in names.items()}
        for invalid in ({}, {**arns, "public": arns["public"].replace("AbCd12", "??????")},
                        {**arns, "public": arns["owner_read"]}, {**arns, "unreviewed": arns["public"]}):
            result = self.run_tf("plan", "-refresh=false", "-var=operator_metadata_window=" + json.dumps(WINDOW),
                                 "-var=metadata_secret_arns=" + json.dumps(invalid), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("five exact final secret ARNs", result.stderr)
        for invalid in ({"start": "bad", "end": WINDOW["end"]},
                        {"start": WINDOW["end"], "end": WINDOW["start"]},
                        {"start": WINDOW["start"], "end": WINDOW["start"]},
                        {"start": WINDOW["start"], "end": "2030-01-01T01:00:01Z"}):
            result = self.run_tf("plan", "-refresh=false", "-var=operator_metadata_window=" + json.dumps(invalid), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Invalid value for variable", result.stderr)
        for name in ("creation_window", "operator_creation_window"):
            result = self.run_tf("plan", "-refresh=false", "-var=operator_metadata_window=" + json.dumps(WINDOW),
                                 "-var=metadata_secret_arns=" + json.dumps(arns), "-var=" + name + "=" + json.dumps(WINDOW), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("after both retained creation windows expire", result.stderr)
        later = {"start": WINDOW["end"], "end": "2030-01-01T02:00:00Z"}
        combined = self.inspect(operator=WINDOW, metadata=later, secret_arns=arns)
        self.assertEqual(len(combined), 8)

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
