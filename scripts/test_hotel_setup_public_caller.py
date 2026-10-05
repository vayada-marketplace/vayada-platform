"""Render actual caller configuration without providers, state or secret values."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "infra/hotel_setup_public_caller.tf"


def render(creation="off", property="off", logo="off"):
    with tempfile.TemporaryDirectory() as directory:
        source = SOURCE.read_text().split('resource "', 1)[0]
        source = source.replace('aws_secretsmanager_secret.hotel_setup_property', 'var.property_secrets').replace('aws_secretsmanager_secret.hotel_setup', 'var.creation_secrets')
        source += '\nvariable "creation_secrets" { default = {internal_token={arn="creation-token-arn"}} }\n'
        source += '\nvariable "property_secrets" { default = {internal_token={arn="property-token-arn"}} }\n'
        Path(directory, "main.tf").write_text(source)
        result = subprocess.run(['terraform', 'console', '-no-color', '-var=hotel_setup_public_caller='+json.dumps({'creation':creation,'property':property,'logo':logo})],
            input='jsonencode({environment=local.hotel_setup_caller_environment,secrets=local.hotel_setup_caller_secrets})\n',
            cwd=directory, text=True, capture_output=True, check=True, timeout=30)
        return json.loads(json.loads(result.stdout.strip()))


class PublicCallerTest(unittest.TestCase):
    def test_default_off_and_hold_never_inject_tokens(self):
        self.assertEqual(render(), {'environment':[], 'secrets':[]})
        hold = render('hold', 'hold')
        self.assertEqual(hold['secrets'], [])
        self.assertEqual(len(hold['environment']), 2)
        self.assertTrue(all(item['value']=='blocked' for item in hold['environment']))

    def test_enabled_and_blocked_keep_exact_separate_pairs(self):
        enabled, blocked = render('enabled', 'enabled'), render('blocked', 'blocked')
        self.assertEqual(enabled['secrets'], blocked['secrets'])
        self.assertEqual({item['valueFrom'] for item in enabled['secrets']}, {'creation-token-arn', 'property-token-arn'})
        self.assertEqual(len(enabled['environment']), 4)
        self.assertEqual([item for item in enabled['environment'] if item['name'].endswith('_ORIGIN')], [item for item in blocked['environment'] if item['name'].endswith('_ORIGIN')])
        source = SOURCE.read_text()
        self.assertIn('Action = ["secretsmanager:GetSecretValue"]', source)
        self.assertNotIn('reader_database_url', source)
        self.assertNotIn('hotel_setup_native_secret', source)
        self.assertNotIn('aws_secretsmanager_secret_version', source)
        with self.assertRaises((subprocess.CalledProcessError, ValueError)): render('unknown')

    def test_logo_reuses_property_pair_and_hold_never_injects_token(self):
        hold = render(logo="hold")
        self.assertEqual(hold, {'environment':[{'name':'HOTEL_SETUP_LOGO_COMMAND_ADMISSION','value':'blocked'}], 'secrets':[]})
        enabled, blocked = render(property="enabled", logo="enabled"), render(property="enabled", logo="blocked")
        self.assertEqual(enabled['secrets'], blocked['secrets'])
        self.assertEqual({item['valueFrom'] for item in enabled['secrets']}, {'property-token-arn'})
        self.assertEqual({item['name'] for item in enabled['secrets']}, {'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN','HOTEL_SETUP_LOGO_COMMAND_INTERNAL_TOKEN'})
        self.assertEqual([item for item in enabled['environment'] if item['name'].endswith('_ORIGIN')], [item for item in blocked['environment'] if item['name'].endswith('_ORIGIN')])
        with self.assertRaises((subprocess.CalledProcessError, ValueError)): render(logo='unknown')


if __name__ == '__main__': unittest.main()
