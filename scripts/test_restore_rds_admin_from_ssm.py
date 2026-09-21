import importlib.util
import io
import json
import pathlib
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch


SCRIPT = pathlib.Path(__file__).with_name("restore-rds-admin-from-ssm.py")
ROOT = SCRIPT.parent.parent
SPEC = importlib.util.spec_from_file_location("restore_rds_admin", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def trusted_clients(stable=True):
    sts = Mock()
    sts.get_caller_identity.return_value = {"Account": MODULE.ACCOUNT}
    ssm = Mock()
    ssm.get_parameter.return_value = {
        "Parameter": {
            "Name": MODULE.PARAMETER,
            "Type": "SecureString",
            "Value": f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require",
        }
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
    ecs = Mock()
    ecs.describe_services.return_value = {"services": [{
        "status": "ACTIVE",
        "desiredCount": 1,
        "runningCount": 1 if stable else 0,
        "pendingCount": 0 if stable else 1,
        "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED" if stable else "IN_PROGRESS"}],
    }]}
    return sts, ssm, rds, ecs


class RestoreRdsAdminTests(unittest.TestCase):
    def test_workflow_uses_production_mutation_lock(self):
        workflow = (ROOT / ".github/workflows/rotate-rds-admin.yml").read_text()
        self.assertIn("group: production-ecs-mutations", workflow)
        self.assertIn("python3 scripts/restore-rds-admin-from-ssm.py apply", workflow)
        self.assertNotIn("TF_VAR_DB_MASTER_PASSWORD", workflow)

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

    def test_validate_rejects_wrong_account_before_secret_read(self):
        sts, ssm, rds, ecs = trusted_clients()
        sts.get_caller_identity.return_value = {"Account": "000000000000"}
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_account_validation"):
            MODULE.validate(sts, ssm, rds, ecs, recovery=False)
        ssm.get_parameter.assert_not_called()

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
        _, ssm, rds, ecs = trusted_clients()
        ssm.get_parameter.return_value = {
            "Parameter": {"Name": MODULE.PENDING_PARAMETER, "Type": "SecureString", "Value": "pending-safe-password"}
        }
        rds.modify_db_instance.side_effect = RuntimeError("hidden SDK detail")
        url = MODULE.validate(*trusted_clients(), recovery=False)
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_rds_update"):
            MODULE.rotate(ssm, rds, ecs, url, recovery=True)
        ssm.delete_parameter.assert_not_called()

    def test_rotate_updates_all_targets_then_removes_pending(self):
        _, ssm, rds, ecs = trusted_clients()
        url = MODULE.validate(*trusted_clients(), recovery=False)
        secret = "generated-safe-password"
        with patch.object(MODULE.secrets, "token_urlsafe", return_value=secret), patch.object(
            MODULE, "verify_database_health"
        ) as health:
            MODULE.rotate(ssm, rds, ecs, url, recovery=False)
        self.assertEqual(rds.modify_db_instance.call_args.kwargs["MasterUserPassword"], secret)
        self.assertIn("generated-safe-password", ssm.put_parameter.call_args_list[-1].kwargs["Value"])
        ecs.update_service.assert_called_once_with(
            cluster=MODULE.CLUSTER, service=MODULE.SERVICE, forceNewDeployment=True
        )
        health.assert_called_once_with()
        ssm.delete_parameter.assert_called_once_with(Name=MODULE.PENDING_PARAMETER)

    def test_database_health_requires_database_connection(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"status":"healthy","database":{"connected":true}}'
        with patch.object(MODULE, "urlopen", return_value=response):
            MODULE.verify_database_health()

    def test_database_health_failure_is_sanitized_and_preserves_pending(self):
        _, ssm, rds, ecs = trusted_clients()
        url = MODULE.validate(*trusted_clients(), recovery=False)
        with patch.object(MODULE, "load_or_create_pending", return_value="generated-safe-password"), patch.object(
            MODULE, "verify_database_health", side_effect=MODULE.RotationError("rotation_failed_database_health")
        ), self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_database_health"):
            MODULE.rotate(ssm, rds, ecs, url, recovery=False)
        ssm.delete_parameter.assert_not_called()

    def test_check_never_rotates_or_prints_password(self):
        clients = trusted_clients()
        output = io.StringIO()
        with patch.object(MODULE, "clients", return_value=clients), patch.object(
            MODULE, "pending_metadata", return_value=False
        ), patch.object(sys, "argv", [str(SCRIPT), "check"]), patch.object(
            MODULE, "rotate"
        ) as rotate, redirect_stdout(output):
            MODULE.main()
        rotate.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), {"status": "PASS", "mode": "check", "recovery": False})


if __name__ == "__main__":
    unittest.main()
