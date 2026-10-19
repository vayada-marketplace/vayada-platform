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
    old_service = {
        "status": "ACTIVE",
        "desiredCount": 1,
        "runningCount": 1 if stable else 0,
        "pendingCount": 0 if stable else 1,
        "taskDefinition": "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-marketplace-backend:89",
        "deployments": [{
            "id": "ecs-svc/old",
            "status": "PRIMARY",
            "rolloutState": "COMPLETED" if stable else "IN_PROGRESS",
            "taskDefinition": "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-marketplace-backend:89",
        }],
    }
    new_service = {
        **old_service,
        "runningCount": 1,
        "pendingCount": 0,
        "deployments": [{
            "id": "ecs-svc/new",
            "status": "PRIMARY",
            "rolloutState": "COMPLETED",
            "taskDefinition": old_service["taskDefinition"],
        }],
    }
    ecs.describe_services.side_effect = lambda **_: {
        "services": [new_service if ecs.update_service.called else old_service]
    }
    ecs.update_service.return_value = {"service": new_service}
    ecs.describe_task_definition.return_value = {"taskDefinition": {"containerDefinitions": [{
        "name": MODULE.SERVICE_CONTAINER,
        "secrets": [{
            "name": "DATABASE_URL",
            "valueFrom": f"arn:aws:ssm:{MODULE.REGION}:{MODULE.ACCOUNT}:parameter{MODULE.PARAMETER}",
        }],
    }]}}
    return sts, ssm, rds, ecs


class RestoreRdsAdminTests(unittest.TestCase):
    def test_workflow_uses_production_mutation_lock(self):
        workflow = (ROOT / ".github/workflows/rotate-rds-admin.yml").read_text()
        self.assertIn("group: production-ecs-mutations", workflow)
        self.assertIn('python3 scripts/restore-rds-admin-from-ssm.py "$MODE"', workflow)
        self.assertIn("default: check", workflow)
        self.assertIn('test "$MODE" = check || test "$CONFIRMATION" = "VAY-2038"', workflow)
        self.assertNotIn("api.vayada.com", workflow + SCRIPT.read_text())
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
        url, consumer_parameter, consumer_url, task_definition, deployment_id = MODULE.validate(
            *trusted_clients(), recovery=False
        )
        self.assertEqual(url.hostname, MODULE.HOST)
        self.assertEqual(consumer_parameter, MODULE.PARAMETER)
        self.assertIs(consumer_url, url)
        self.assertTrue(task_definition.endswith(":89"))
        self.assertEqual(deployment_id, "ecs-svc/old")

    def test_validate_rejects_wrong_account_before_secret_read(self):
        sts, ssm, rds, ecs = trusted_clients()
        sts.get_caller_identity.return_value = {"Account": "000000000000"}
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_account_validation"):
            MODULE.validate(sts, ssm, rds, ecs, recovery=False)
        ssm.get_parameter.assert_not_called()

    def test_validate_allows_expected_instability_during_recovery(self):
        url, *_ = MODULE.validate(*trusted_clients(stable=False), recovery=True)
        self.assertEqual(url.hostname, MODULE.HOST)

    def test_validate_rejects_instability_without_recovery_marker(self):
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_rds_readiness"):
            MODULE.validate(*trusted_clients(stable=False), recovery=False)

    def test_validate_accepts_reviewed_legacy_consumer_parameter(self):
        sts, ssm, rds, ecs = trusted_clients()
        ssm.get_parameter.side_effect = lambda Name, WithDecryption: {"Parameter": {
            "Name": Name,
            "Type": "SecureString",
            "Value": f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require",
        }}
        ecs.describe_task_definition.return_value["taskDefinition"]["containerDefinitions"][0]["secrets"][0][
            "valueFrom"
        ] = f"arn:aws:ssm:{MODULE.REGION}:{MODULE.ACCOUNT}:parameter{MODULE.LEGACY_PARAMETER}"
        url, consumer_parameter, consumer_url, _, _ = MODULE.validate(sts, ssm, rds, ecs, recovery=True)
        self.assertEqual(consumer_parameter, MODULE.LEGACY_PARAMETER)
        self.assertEqual(consumer_url.hostname, MODULE.HOST)
        self.assertEqual(ssm.get_parameter.call_count, 2)

    def test_validate_rejects_unreviewed_consumer_parameter(self):
        sts, ssm, rds, ecs = trusted_clients()
        ecs.describe_task_definition.return_value["taskDefinition"]["containerDefinitions"][0]["secrets"][0][
            "valueFrom"
        ] = "arn:aws:ssm:eu-west-1:269416271598:parameter/vayada/prod/other"
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_service_mapping"):
            MODULE.validate(sts, ssm, rds, ecs, recovery=True)

    def test_validate_skips_switched_off_consumer_and_keeps_its_parameter(self):
        sts, ssm, rds, ecs = trusted_clients()
        ecs.describe_services.side_effect = None
        ecs.describe_services.return_value = {"services": [{"status": "ACTIVE", "desiredCount": 0, "deployments": []}]}
        ssm.describe_parameters.return_value = {"Parameters": [{"Name": MODULE.LEGACY_PARAMETER}]}
        ssm.get_parameter.side_effect = lambda Name, WithDecryption: {"Parameter": {
            "Name": Name,
            "Type": "SecureString",
            "Value": f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require",
        }}
        url, consumer_parameter, consumer_url, task_definition, deployment_id = MODULE.validate(
            sts, ssm, rds, ecs, recovery=False
        )
        self.assertEqual(consumer_parameter, MODULE.LEGACY_PARAMETER)
        self.assertEqual(consumer_url.hostname, MODULE.HOST)
        self.assertIsNone(task_definition)
        self.assertIsNone(deployment_id)
        ecs.describe_task_definition.assert_not_called()

    def test_validate_accepts_deleted_consumer_without_its_parameter(self):
        sts, ssm, rds, ecs = trusted_clients()
        ecs.describe_services.side_effect = None
        ecs.describe_services.return_value = {"services": [], "failures": [{"reason": "MISSING"}]}
        ssm.describe_parameters.return_value = {"Parameters": []}
        url, consumer_parameter, consumer_url, task_definition, _ = MODULE.validate(sts, ssm, rds, ecs, recovery=False)
        self.assertEqual(consumer_parameter, MODULE.PARAMETER)
        self.assertIs(consumer_url, url)
        self.assertIsNone(task_definition)

    def test_validate_rejects_unreviewed_consumer_count(self):
        sts, ssm, rds, ecs = trusted_clients()
        ecs.describe_services.side_effect = None
        ecs.describe_services.return_value = {"services": [{"status": "ACTIVE", "desiredCount": 2, "deployments": []}]}
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_service_validation"):
            MODULE.validate(sts, ssm, rds, ecs, recovery=False)

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
        url, consumer_parameter, consumer_url, task_definition, deployment_id = MODULE.validate(
            *trusted_clients(), recovery=False
        )
        with self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_rds_update"):
            MODULE.rotate(
                ssm, rds, ecs, url, consumer_parameter, consumer_url,
                task_definition, deployment_id, recovery=True,
            )
        ssm.delete_parameter.assert_not_called()

    def test_rotate_updates_all_targets_then_removes_pending(self):
        _, ssm, rds, ecs = trusted_clients()
        url, consumer_parameter, consumer_url, task_definition, deployment_id = MODULE.validate(
            *trusted_clients(), recovery=False
        )
        secret = "generated-safe-password"
        with patch.object(MODULE.secrets, "token_urlsafe", return_value=secret), patch.object(
            MODULE, "verify_admin_login"
        ) as login:
            MODULE.rotate(
                ssm, rds, ecs, url, consumer_parameter, consumer_url,
                task_definition, deployment_id, recovery=False,
            )
        self.assertEqual(rds.modify_db_instance.call_args.kwargs["MasterUserPassword"], secret)
        self.assertIn("generated-safe-password", ssm.put_parameter.call_args_list[-1].kwargs["Value"])
        ecs.update_service.assert_called_once_with(
            cluster=MODULE.CLUSTER,
            service=MODULE.SERVICE,
            taskDefinition=task_definition,
            forceNewDeployment=True,
        )
        login.assert_called_once_with()
        ssm.delete_parameter.assert_called_once_with(Name=MODULE.PENDING_PARAMETER)

    def test_rotate_without_consumer_updates_parameters_and_checks_login_only(self):
        _, ssm, rds, ecs = trusted_clients()
        url = urlsplit(
            f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require"
        )
        with patch.object(MODULE, "load_or_create_pending", return_value="pending-safe-password"), patch.object(
            MODULE, "verify_admin_login"
        ) as login:
            MODULE.rotate(ssm, rds, ecs, url, MODULE.LEGACY_PARAMETER, url, None, None, recovery=False)
        writes = [call.kwargs["Name"] for call in ssm.put_parameter.call_args_list]
        self.assertEqual(writes, [MODULE.PARAMETER, MODULE.LEGACY_PARAMETER])
        ecs.update_service.assert_not_called()
        login.assert_called_once_with()
        ssm.delete_parameter.assert_called_once_with(Name=MODULE.PENDING_PARAMETER)

    def test_rotate_updates_reviewed_legacy_consumer_parameter(self):
        _, ssm, rds, ecs = trusted_clients()
        ssm.get_parameter.side_effect = lambda Name, WithDecryption: {"Parameter": {
            "Name": Name,
            "Type": "SecureString",
            "Value": f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require",
        }}
        url = MODULE.connection_url(ssm, MODULE.PARAMETER)
        legacy_url = MODULE.connection_url(ssm, MODULE.LEGACY_PARAMETER)
        with patch.object(MODULE, "load_or_create_pending", return_value="pending-safe-password"), patch.object(
            MODULE, "verify_admin_login"
        ):
            MODULE.rotate(
                ssm, rds, ecs, url, MODULE.LEGACY_PARAMETER, legacy_url,
                "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-marketplace-backend:89",
                "ecs-svc/old", recovery=True,
            )
        writes = [call.kwargs for call in ssm.put_parameter.call_args_list]
        self.assertEqual([item["Name"] for item in writes], [MODULE.PARAMETER, MODULE.LEGACY_PARAMETER])
        self.assertTrue(all("pending-safe-password" in item["Value"] for item in writes))

    def test_legacy_consumer_write_failure_preserves_recovery_and_skips_restart(self):
        _, ssm, rds, ecs = trusted_clients()
        url = urlsplit(
            f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require"
        )
        ssm.put_parameter.side_effect = [None, RuntimeError("hidden SDK detail")]
        with patch.object(MODULE, "load_or_create_pending", return_value="pending-safe-password"), self.assertRaisesRegex(
            MODULE.RotationError, "rotation_failed_consumer_parameter_write"
        ):
            MODULE.rotate(
                ssm, rds, ecs, url, MODULE.LEGACY_PARAMETER, url,
                "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-marketplace-backend:89",
                "ecs-svc/old", recovery=True,
            )
        ecs.update_service.assert_not_called()
        ssm.delete_parameter.assert_not_called()

    def test_service_rollback_preserves_pending(self):
        _, ssm, rds, ecs = trusted_clients()
        url = urlsplit(
            f"postgresql://{MODULE.MASTER_USER}:legacy@{MODULE.HOST}:5432/postgres?sslmode=require"
        )
        ecs.describe_services.side_effect = None
        ecs.describe_services.return_value = {"services": [{
            "status": "ACTIVE",
            "desiredCount": 1,
            "runningCount": 1,
            "pendingCount": 0,
            "deployments": [{
                "id": "ecs-svc/old",
                "status": "PRIMARY",
                "rolloutState": "COMPLETED",
                "taskDefinition": "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-marketplace-backend:89",
            }],
        }]}
        with patch.object(MODULE, "load_or_create_pending", return_value="pending-safe-password"), self.assertRaisesRegex(
            MODULE.RotationError, "rotation_failed_service_replacement"
        ):
            MODULE.rotate(
                ssm, rds, ecs, url, MODULE.PARAMETER, url,
                "arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-marketplace-backend:89",
                "ecs-svc/old", recovery=True,
            )
        ssm.delete_parameter.assert_not_called()

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
        _, ssm, rds, ecs = trusted_clients()
        url, consumer_parameter, consumer_url, task_definition, deployment_id = MODULE.validate(
            *trusted_clients(), recovery=False
        )
        with patch.object(MODULE, "load_or_create_pending", return_value="generated-safe-password"), patch.object(
            MODULE, "verify_admin_login", side_effect=MODULE.RotationError("rotation_failed_admin_login")
        ), self.assertRaisesRegex(MODULE.RotationError, "rotation_failed_admin_login"):
            MODULE.rotate(
                ssm, rds, ecs, url, consumer_parameter, consumer_url,
                task_definition, deployment_id, recovery=False,
            )
        ssm.delete_parameter.assert_not_called()

    def test_check_logs_in_but_never_rotates_or_prints_password(self):
        clients = trusted_clients()
        output = io.StringIO()
        with patch.object(MODULE, "clients", return_value=clients), patch.object(
            MODULE, "pending_metadata", return_value=False
        ), patch.object(sys, "argv", [str(SCRIPT), "check"]), patch.object(
            MODULE, "rotate"
        ) as rotate, patch.object(MODULE, "verify_admin_login") as login, redirect_stdout(output):
            MODULE.main()
        rotate.assert_not_called()
        login.assert_called_once_with()
        self.assertEqual(json.loads(output.getvalue()), {
            "status": "PASS", "mode": "check", "recovery": False,
            "adminLogin": "PASS", "restarts": MODULE.SERVICE,
        })
        self.assertNotIn("legacy", output.getvalue())


if __name__ == "__main__":
    unittest.main()
