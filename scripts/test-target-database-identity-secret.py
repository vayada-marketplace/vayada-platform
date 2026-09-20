#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


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
    def test_aws_passes_secret_on_stdin_only(self):
        with patch.object(secret.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "{}"
            secret.aws("ssm", "put-parameter", "--cli-input-json", "file:///dev/stdin",
                       payload='{"Value":"private"}')
            command = run.call_args.args[0]
            self.assertNotIn("private", " ".join(command))
            self.assertEqual(run.call_args.kwargs["input"], '{"Value":"private"}')

    def test_create_is_absent_only_and_does_not_print_url(self):
        calls = []

        def fake_aws(*args, payload=None):
            calls.append((args, payload))
            if args[:2] == ("sts", "get-caller-identity"):
                return {"Account": secret.ACCOUNT}
            if args[:2] == ("ssm", "get-parameter"):
                return {"Parameter": {"Value": owner_url}}
            if args[:2] == ("ssm", "describe-parameters"):
                return {"Parameters": []}
            if args[:2] == ("ssm", "put-parameter"):
                return {"Version": 1}
            self.fail("unexpected AWS call")

        output = io.StringIO()
        with patch.object(secret, "aws", side_effect=fake_aws), \
             patch.object(secret.secrets, "token_urlsafe", return_value="private-token"), \
             patch.object(sys, "argv", [str(script), "--create"]), \
             contextlib.redirect_stdout(output):
            secret.main()
        payload = json.loads(calls[-1][1])
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
