import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch
from urllib.parse import urlsplit


SCRIPT = pathlib.Path(__file__).with_name("restore-rds-admin-from-ssm.py")
ROOT = SCRIPT.parent.parent
SPEC = importlib.util.spec_from_file_location("restore_rds_admin", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

ADMIN_URL = f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require"


def trusted_clients(stable=True):
    sts = Mock()
    sts.get_caller_identity.return_value = {"Account": MODULE.ACCOUNT}
    ssm = Mock()
    ssm.get_parameter.return_value = {
        "Parameter": {"Name": MODULE.PARAMETER, "Type": "SecureString", "Value": ADMIN_URL}
    }
    rds = Mock()
    rds.describe_db_instances.return_value = {"DBInstances": [{
        "DBInstanceIdentifier": MODULE.INSTANCE,
        "DBInstanceStatus": "available" if stable else "modifying",
        "MasterUsername": MODULE.MASTER_USER,
        "Engine": "postgres",
        "CACertificateIdentifier": MODULE.EXPECTED_CA,
        "ManageMasterUserPassword": False,
        "PendingModifiedValues": {} if stable else {"MasterUserPassword": "****"},
        "Endpoint": {"Address": MODULE.HOST, "Port": 5432},
    }]}
    return sts, ssm, rds


class RestoreRdsAdminTests(unittest.TestCase):
    def test_workflow_uses_production_mutation_lock(self):
        workflow = (ROOT / ".github/workflows/rotate-rds-admin.yml").read_text()
        self.assertIn("group: production-ecs-mutations", workflow)
        self.assertIn('python3 scripts/restore-rds-admin-from-ssm.py "$MODE"', workflow)
        self.assertIn("default: check", workflow)
        self.assertIn('test "$MODE" = check || test "$CONFIRMATION" = "VAY-2038"', workflow)
        self.assertNotIn("api.vayada.com", workflow + SCRIPT.read_text())
        self.assertNotIn("TF_VAR_DB_MASTER_PASSWORD", workflow)

    def test_no_longer_touches_the_deleted_marketplace_api(self):
        # VAY-2259: the legacy Marketplace API service and its -ssl parameter are deleted.
        source = SCRIPT.read_text()
        for retired in ("vayada-marketplace-backend", "db-marketplace-url-ssl", "update_service", '"ecs"'):
            self.assertNotIn(retired, source)

    def test_terraform_preserves_rotated_value_and_scopes_rds_write(self):
        ssm = (ROOT / "infra/ssm.tf").read_text()
        iam = (ROOT / "infra/rds_admin_rotation_iam.tf").read_text()
        self.assertIn('from = aws_ssm_parameter.secrets["db-marketplace-url"]', ssm)
        self.assertIn("ignore_changes = [value]", ssm)
        self.assertIn('actions   = ["rds:ModifyDBInstance"]', iam)
        self.assertIn("db:vayada-database", iam)
        self.assertIn("aws_iam_role_policy_attachment", iam)
        for action in ("iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"):
            self.assertIn(action, iam)
        self.assertIn('id = "arn:aws:iam::269416271598:policy/vayada-rds-admin-rotation"', iam)

    def test_validate_accepts_exact_resources(self):
        url = MODULE.validate(*trusted_clients(), recovery=False)
        self.assertEqual(url.hostname, MODULE.HOST)
        self.assertEqual(url.path, "/postgres")

    def test_validate_rejects_wrong_account_before_secret_read(self):
        sts, ssm, rds = trusted_clients()
        sts.get_caller_identity.return_value = {"Account": "000000000000"}
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_account_validation"):
            MODULE.validate(sts, ssm, rds, recovery=False)
        ssm.get_parameter.assert_not_called()

    def test_validate_rejects_an_unexpected_admin_url(self):
        sts, ssm, rds = trusted_clients()
        ssm.get_parameter.return_value["Parameter"]["Value"] = ADMIN_URL.replace("/postgres", "/other")
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_url_validation"):
            MODULE.validate(sts, ssm, rds, recovery=False)

    def test_validate_allows_expected_instability_during_recovery(self):
        url = MODULE.validate(*trusted_clients(stable=False), recovery=True)
        self.assertEqual(url.hostname, MODULE.HOST)

    def test_validate_rejects_instability_without_recovery_marker(self):
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_rds_readiness"):
            MODULE.validate(*trusted_clients(stable=False), recovery=False)

    def test_pending_metadata_requires_exact_tags(self):
        ssm = Mock()
        ssm.describe_parameters.return_value = {"Parameters": [{
            "Name": MODULE.PENDING_PARAMETER,
            "Type": "SecureString",
            "KeyId": "alias/aws/ssm",
        }]}
        ssm.list_tags_for_resource.return_value = {"TagList": [
            {"Key": key, "Value": value} for key, value in MODULE.PENDING_TAGS.items()
        ]}
        self.assertTrue(MODULE.pending_metadata(ssm))
        ssm.list_tags_for_resource.return_value = {"TagList": []}
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_pending_validation"):
            MODULE.pending_metadata(ssm)

    def test_rotate_reuses_pending_and_keeps_it_on_stage_failure(self):
        _, ssm, rds = trusted_clients()
        ssm.get_parameter.return_value = {
            "Parameter": {"Name": MODULE.PENDING_PARAMETER, "Type": "SecureString", "Value": "pending-safe-password"}
        }
        rds.modify_db_instance.side_effect = RuntimeError("hidden SDK detail")
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_rds_update"):
            MODULE.rotate(ssm, rds, urlsplit(ADMIN_URL), recovery=True)
        ssm.delete_parameter.assert_not_called()

    def test_rotate_updates_the_admin_url_proves_the_login_then_removes_pending(self):
        _, ssm, rds = trusted_clients()
        secret = "generated-safe-password"
        with patch.object(MODULE.secrets, "token_urlsafe", return_value=secret), patch.object(
            MODULE, "verify_admin_login"
        ) as login:
            MODULE.rotate(ssm, rds, urlsplit(ADMIN_URL), recovery=False)
        self.assertEqual(rds.modify_db_instance.call_args.kwargs["MasterUserPassword"], secret)
        writes = [call.kwargs for call in ssm.put_parameter.call_args_list]
        self.assertEqual([item["Name"] for item in writes], [MODULE.PENDING_PARAMETER, MODULE.PARAMETER])
        self.assertIn(secret, writes[-1]["Value"])
        login.assert_called_once_with()
        ssm.delete_parameter.assert_called_once_with(Name=MODULE.PENDING_PARAMETER)

    def test_admin_login_requires_the_runner_pass_for_the_master_user(self):
        passed = subprocess.CompletedProcess(MODULE.ADMIN_LOGIN_CHECK, 0, '{"status": "PASS", "user": "vayada_admin"}\n', "")
        with patch.object(MODULE.subprocess, "run", return_value=passed) as run:
            MODULE.verify_admin_login()
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][-1], "--check-rds-admin-login")
        for result in (
            subprocess.CompletedProcess(MODULE.ADMIN_LOGIN_CHECK, 1, "", "Runtime preflight task failed"),
            subprocess.CompletedProcess(MODULE.ADMIN_LOGIN_CHECK, 0, '{"status": "PASS", "user": "other"}\n', ""),
            subprocess.CompletedProcess(MODULE.ADMIN_LOGIN_CHECK, 0, "not json\n", ""),
        ):
            with patch.object(MODULE.subprocess, "run", return_value=result) as run, self.assertRaisesRegex(
                MODULE.RotationError, "rotation_failed_admin_login"
            ):
                MODULE.verify_admin_login()
            self.assertEqual(run.call_count, 2)
        with patch.object(MODULE.subprocess, "run", side_effect=subprocess.TimeoutExpired("bash", 900)), \
                self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_admin_login"):
            MODULE.verify_admin_login()

    def test_admin_login_failure_is_sanitized_and_preserves_pending(self):
        _, ssm, rds = trusted_clients()
        with patch.object(MODULE, "load_or_create_pending", return_value="generated-safe-password"), patch.object(
            MODULE, "verify_admin_login", side_effect=MODULE.RotationError("rotation_failed_admin_login")
        ), self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_admin_login"):
            MODULE.rotate(ssm, rds, urlsplit(ADMIN_URL), recovery=False)
        ssm.delete_parameter.assert_not_called()

    def test_check_logs_in_but_never_rotates_or_prints_password(self):
        output = io.StringIO()
        with patch.object(MODULE, "clients", return_value=trusted_clients()), patch.object(
            MODULE, "pending_metadata", return_value=False
        ), patch.object(sys, "argv", [str(SCRIPT), "check"]), patch.object(
            MODULE, "rotate"
        ) as rotate, patch.object(MODULE, "verify_admin_login") as login, redirect_stdout(output):
            MODULE.main()
        rotate.assert_not_called()
        login.assert_called_once_with()
        self.assertEqual(json.loads(output.getvalue()), {
            "status": "PASS", "mode": "check", "recovery": False, "adminLogin": "PASS",
        })
        self.assertNotIn("legacy", output.getvalue())


if __name__ == "__main__":
    unittest.main()
