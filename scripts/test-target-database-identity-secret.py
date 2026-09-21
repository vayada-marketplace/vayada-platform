#!/usr/bin/env python3
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


script = Path(__file__).with_name("create-target-database-identity-secret.py")
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("identity_secret", script)
secret = importlib.util.module_from_spec(spec)
spec.loader.exec_module(secret)
owner_url = (
    "postgresql://vayada_admin:owner-secret@"
    "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require"
)


class IdentitySecretTest(unittest.TestCase):
    def test_secret_write_uses_sdk_without_a_command_argument(self):
        client = Mock()
        session = Mock()
        session.client.side_effect = lambda service: (
            Mock(get_caller_identity=Mock(return_value={"Account": secret.ACCOUNT}))
            if service == "sts" else client
        )
        boto3 = SimpleNamespace(Session=Mock(return_value=session))
        with patch.dict(sys.modules, {"boto3": boto3}), \
             patch.object(secret.subprocess, "run") as run:
            secret.put_identity_parameter({"Value": "private"})
        client.put_parameter.assert_called_once_with(Value="private")
        run.assert_not_called()

    def test_secret_write_failure_does_not_expose_sdk_error(self):
        client = Mock()
        client.put_parameter.side_effect = ValueError("private credential")
        session = Mock()
        session.client.side_effect = lambda service: (
            Mock(get_caller_identity=Mock(return_value={"Account": secret.ACCOUNT}))
            if service == "sts" else client
        )
        boto3 = SimpleNamespace(Session=Mock(return_value=session))
        with patch.dict(sys.modules, {"boto3": boto3}):
            with self.assertRaisesRegex(RuntimeError, "^identity_secret_write_failed$"):
                secret.put_identity_parameter({"Value": "private"})

    def test_sdk_account_mismatch_never_writes(self):
        session = Mock()
        session.client.return_value.get_caller_identity.return_value = {"Account": "other"}
        boto3 = SimpleNamespace(Session=Mock(return_value=session))
        with patch.dict(sys.modules, {"boto3": boto3}):
            with self.assertRaisesRegex(RuntimeError, "^identity_secret_write_failed$"):
                secret.put_identity_parameter({"Value": "private"})
        session.client.assert_called_once_with("sts")

    def test_create_is_absent_only_and_does_not_print_url(self):
        calls = []
        writes = []

        def fake_aws(*args):
            calls.append(args)
            if args[:2] == ("sts", "get-caller-identity"):
                return {"Account": secret.ACCOUNT}
            if args[:2] == ("ssm", "get-parameter"):
                return {"Parameter": {"Value": owner_url}}
            if args[:2] == ("ssm", "describe-parameters"):
                return {"Parameters": []}
            self.fail("unexpected AWS call")

        output = io.StringIO()
        with patch.object(secret, "aws", side_effect=fake_aws), \
             patch.object(secret, "put_identity_parameter", side_effect=writes.append), \
             patch.object(secret.secrets, "token_urlsafe", return_value="private-token"), \
             patch.object(sys, "argv", [str(script), "--create"]), \
             contextlib.redirect_stdout(output):
            secret.main()
        payload = writes[0]
        self.assertFalse(payload["Overwrite"])
        self.assertEqual(payload["Name"], secret.IDENTITY_PARAMETER)
        self.assertIn("vayada_next_identity_runtime:private-token@", payload["Value"])
        self.assertNotIn("private-token", output.getvalue())
        self.assertNotIn("owner-secret", output.getvalue())

    def test_existing_parameter_blocks_creation(self):
        responses = [
            {"Account": secret.ACCOUNT},
            {"Parameter": {"Value": owner_url}},
            {"Parameters": [{"Name": secret.IDENTITY_PARAMETER}]},
        ]
        with patch.object(secret, "aws", side_effect=responses) as aws, \
             patch.object(sys, "argv", [str(script), "--create"]):
            with self.assertRaisesRegex(RuntimeError, "identity_parameter_already_exists"):
                secret.main()
        self.assertEqual(aws.call_count, 3)


if __name__ == "__main__":
    unittest.main()
