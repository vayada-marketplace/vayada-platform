"""Render actual caller configuration without providers, state or secret values."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "infra/hotel_setup_public_caller.tf"


def render(creation="off", property="off", logo="off", profile="off"):
    with tempfile.TemporaryDirectory() as directory:
        source = SOURCE.read_text().split('resource "', 1)[0]
        source = source.replace('aws_secretsmanager_secret.hotel_setup_property', 'var.property_secrets').replace('aws_secretsmanager_secret.hotel_setup', 'var.creation_secrets')
        source += '\nvariable "creation_secrets" { default = {internal_token={arn="creation-token-arn"}} }\n'
        source += '\nvariable "property_secrets" { default = {internal_token={arn="property-token-arn"}} }\n'
        Path(directory, "main.tf").write_text(source)
        result = subprocess.run(['terraform', 'console', '-no-color', '-var=hotel_setup_public_caller='+json.dumps({'creation':creation,'property':property,'logo':logo,'profile':profile})],
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

    def test_profile_reuses_property_pair_and_is_off_by_default(self):
        self.assertEqual(render(property='enabled', logo='enabled'), render(property='enabled', logo='enabled', profile='off'))
        hold = render(profile='hold')
        self.assertEqual(hold, {'environment':[{'name':'HOTEL_SETUP_PROFILE_COMMAND_ADMISSION','value':'blocked'}], 'secrets':[]})
        enabled, blocked = (render(property='enabled', logo='enabled', profile=state) for state in ('enabled', 'blocked'))
        self.assertEqual(enabled['secrets'], blocked['secrets'])
        self.assertEqual({item['valueFrom'] for item in enabled['secrets']}, {'property-token-arn'})
        self.assertEqual({item['name'] for item in enabled['secrets']},
                         {'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN', 'HOTEL_SETUP_LOGO_COMMAND_INTERNAL_TOKEN', 'HOTEL_SETUP_PROFILE_COMMAND_INTERNAL_TOKEN'})
        origins = {item['name']: item['value'] for item in enabled['environment'] if item['name'].endswith('_ORIGIN')}
        self.assertEqual(origins['HOTEL_SETUP_PROFILE_COMMAND_ORIGIN'], 'https://hotel-setup-property-command.vayada.com')
        admissions = {item['name']: item['value'] for item in blocked['environment'] if item['name'].endswith('_ADMISSION')}
        self.assertEqual(admissions, {'HOTEL_SETUP_COMMAND_ADMISSION':'enabled', 'HOTEL_SETUP_LOGO_COMMAND_ADMISSION':'enabled',
                                      'HOTEL_SETUP_PROFILE_COMMAND_ADMISSION':'blocked'})
        with self.assertRaises((subprocess.CalledProcessError, ValueError)): render(profile='unknown')

    def test_checked_in_profile_caller_retains_the_released_admission(self):
        # VAY-965: profile was released enabled through hotel-setup-release.yml; ordinary apply must retain it.
        tfvars = (ROOT / 'infra/hotel_setup_staging.auto.tfvars').read_text()
        self.assertIn('hotel_setup_public_caller = { creation = "enabled", property = "enabled", logo = "enabled", profile = "enabled" }', tfvars)
        self.assertIn('enable_hotel_setup_profile_credentials = true', tfvars)
        self.assertIn('enable_hotel_setup_logo_storage    = true', tfvars)
        self.assertIn('hotel_setup_logo_private_admission = "enabled"', tfvars)

    def condition(self, profile, digests, inventory, credentials=True):
        source = SOURCE.read_text()
        expression = source.split('condition = ', 1)[1].split('error_message', 1)[0].strip()
        header = source.split('resource "', 1)[0]
        header = header.replace('aws_secretsmanager_secret.hotel_setup_property', 'var.property_secrets').replace('aws_secretsmanager_secret.hotel_setup', 'var.creation_secrets')
        inventory_block = source.rsplit('locals {', 1)[1]
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'infra').mkdir(); Path(directory, 'deployment').mkdir()
            Path(directory, 'deployment/hotel-setup-profile-images.json').write_text(json.dumps(inventory))
            Path(directory, 'infra/main.tf').write_text(header + 'locals {' + inventory_block + '''
variable "creation_secrets" { default = {internal_token={arn="creation-token-arn"}} }
variable "property_secrets" { default = {internal_token={arn="property-token-arn"}} }
variable "enable_hotel_setup_private_network" { default = true }
variable "enable_hotel_setup_credential_infrastructure" { default = true }
variable "hotel_setup_command_mode" { default = "property_creation" }
variable "enable_hotel_setup_property_credentials" { default = true }
variable "enable_hotel_setup_property_network" { default = true }
variable "enable_hotel_setup_logo_storage" { default = true }
variable "hotel_setup_logo_private_admission" { default = "enabled" }
variable "enable_hotel_setup_profile_credentials" { default = false }
variable "hotel_setup_property_image_digests" {
  type    = object({ primary = string, rollback = string })
  default = { primary = "", rollback = "" }
}
''')
            result = subprocess.run(['terraform', 'console', '-no-color',
                '-var=hotel_setup_public_caller=' + json.dumps({'creation':'enabled','property':'enabled','logo':'enabled','profile':profile}),
                '-var=enable_hotel_setup_profile_credentials=' + str(credentials).lower(),
                '-var=hotel_setup_property_image_digests=' + json.dumps(digests)],
                input=expression.replace('\n', ' ') + '\n', cwd=Path(directory, 'infra'), text=True, capture_output=True, check=True, timeout=30)
            return result.stdout.strip() == 'true'

    def test_configured_profile_caller_requires_profile_credentials_and_proved_property_images(self):
        primary, rollback = 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64
        digests = {'primary': primary, 'rollback': rollback}
        both = {primary: 'c' * 40, rollback: 'd' * 40}
        self.assertTrue(self.condition('off', digests, {}, credentials=False))
        self.assertTrue(self.condition('hold', digests, {}, credentials=False))
        self.assertFalse(self.condition('blocked', digests, {}, credentials=False))
        self.assertTrue(self.condition('blocked', digests, {}))
        self.assertFalse(self.condition('enabled', digests, {}))
        self.assertFalse(self.condition('enabled', digests, {primary: 'c' * 40}))
        self.assertFalse(self.condition('enabled', {'primary': primary, 'rollback': ''}, both))
        self.assertFalse(self.condition('enabled', digests, both, credentials=False))
        self.assertTrue(self.condition('enabled', digests, both))


if __name__ == '__main__': unittest.main()
