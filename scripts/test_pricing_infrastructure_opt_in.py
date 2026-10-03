"""Native offline plans for dormant pricing prerequisites and installed-state safety."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ROLE = 'vayada-pricing-command-execution'
ACCOUNT = '269416271598'


class PricingInfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='vay965-pricing-opt-in-')
        cls.path = Path(cls.directory.name)
        for name in ('pricing_command_secrets.tf', 'pricing_command_metadata_policy.json.tftpl', '.terraform.lock.hcl'):
            shutil.copy(ROOT / 'infra' / name, cls.path)
        (cls.path / '.terraform').mkdir()
        (cls.path / '.terraform/providers').symlink_to(ROOT / 'infra/.terraform/providers', target_is_directory=True)
        (cls.path / 'fixture.tf').write_text('''
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
  }
}
provider "aws" {
  region = "eu-west-1"
  access_key = "offline-fixture"
  secret_key = "offline-fixture"
  skip_credentials_validation = true
  skip_requesting_account_id = true
  skip_metadata_api_check = true
}
variable "aws_account_id" { default = "269416271598" }
variable "aws_region" { default = "eu-west-1" }
output "metadata" { value = local.pricing_command_metadata_statements }
''')
        cls.environment = {k: v for k, v in os.environ.items() if not k.startswith(('AWS_', 'TF_'))}
        cls.environment.update(AWS_EC2_METADATA_DISABLED='true', TF_IN_AUTOMATION='true')
        cls.run_tf('init', '-backend=false', '-lockfile=readonly', '-input=false', '-no-color')

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    @classmethod
    def run_tf(cls, *args, success=True):
        result = subprocess.run(['terraform', *args], cwd=cls.path, env=cls.environment,
                                capture_output=True, text=True, timeout=90)
        if success and result.returncode:
            raise AssertionError(result.stderr)
        return result

    def plan(self, enabled=None, metadata=False, state=None, success=True):
        state_path = self.path / 'terraform.tfstate'
        if state is None:
            state_path.unlink(missing_ok=True)
        else:
            state_path.write_text(json.dumps(state))
        arguments = ['plan', '-refresh=false', '-input=false', '-no-color', '-out=fixture.plan',
                     '-var=enable_pricing_command_metadata_refresh=' + str(metadata).lower()]
        if enabled is not None:
            arguments.append('-var=enable_pricing_command_credential_infrastructure=' + str(enabled).lower())
        result = self.run_tf(*arguments, success=success)
        if not success:
            return result
        return json.loads(self.run_tf('show', '-json', 'fixture.plan').stdout)

    def legacy_state(self):
        values = self.plan(True)['planned_values']['root_module']['resources']
        resources = []
        secret_arns = []
        for resource in values:
            if resource['type'] == 'aws_secretsmanager_secret':
                secret_arns.append('arn:aws:secretsmanager:eu-west-1:' + ACCOUNT + ':secret:' + resource['values']['name'] + '-AbCd12')
        for resource in values:
            attributes = copy.deepcopy(resource['values'])
            if resource['type'] == 'aws_secretsmanager_secret':
                arn = 'arn:aws:secretsmanager:eu-west-1:' + ACCOUNT + ':secret:' + attributes['name'] + '-AbCd12'
                attributes.update(id=arn, arn=arn)
            elif resource['type'] == 'aws_iam_role':
                attributes.update(id=ROLE, arn='arn:aws:iam::' + ACCOUNT + ':role/' + ROLE,
                                  unique_id='AROASYNTHETICPRICING', create_date='2026-10-03T00:00:00Z',
                                  inline_policy=[], managed_policy_arns=[], tags={}, tags_all={})
            else:
                policy = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow',
                          'Action': ['secretsmanager:GetSecretValue'], 'Resource': secret_arns}]}
                attributes.update(id=ROLE + ':pricing-command-exact-secret-read', role=ROLE,
                                  policy=json.dumps(policy, sort_keys=True, separators=(',', ':')))
            instance = {'schema_version': 0, 'attributes': attributes, 'sensitive_attributes': []}
            # Preserve the old unindexed IAM addresses. Secret keys never change.
            if resource['type'] == 'aws_secretsmanager_secret':
                instance['index_key'] = resource['index']
            resources.append({'mode': 'managed', 'type': resource['type'], 'name': resource['name'],
                              'provider': 'provider["registry.terraform.io/hashicorp/aws"]', 'instances': [instance]})
        return {'version': 4, 'terraform_version': '1.5.7', 'serial': 1,
                'lineage': '00000000-0000-4000-8000-000000000965', 'outputs': {}, 'resources': resources}

    def test_default_and_explicit_off_are_no_op(self):
        for enabled in (None, False):
            self.assertEqual(self.plan(enabled).get('resource_changes', []), [])

    def test_explicit_opt_in_proposes_exact_seven_creates(self):
        changes = self.plan(True)['resource_changes']
        self.assertEqual(len(changes), 7)
        self.assertTrue(all(r['change']['actions'] == ['create'] for r in changes))
        self.assertEqual({r['address'] for r in changes if r['type'].startswith('aws_iam_')},
                         {'aws_iam_role.pricing_command_execution[0]', 'aws_iam_role_policy.pricing_command_secrets[0]'})
        self.assertEqual({r['index'] for r in changes if r['type'] == 'aws_secretsmanager_secret'},
                         {'identity_read', 'owner_read', 'owner_manage', 'public', 'internal_token'})

    def test_legacy_installed_state_moves_without_replacement(self):
        changes = self.plan(True, state=self.legacy_state())['resource_changes']
        self.assertTrue(all(r['change']['actions'] == ['no-op'] for r in changes), changes)
        moved = {r['previous_address']: r['address'] for r in changes if 'previous_address' in r}
        self.assertEqual(moved, {'aws_iam_role.pricing_command_execution': 'aws_iam_role.pricing_command_execution[0]',
                                 'aws_iam_role_policy.pricing_command_secrets': 'aws_iam_role_policy.pricing_command_secrets[0]'})

    def test_installed_and_partial_state_cannot_be_disabled(self):
        state = self.legacy_state()
        for resources in [state['resources'], *[[r] for r in state['resources']]]:
            partial = dict(state, resources=resources)
            result = self.plan(False, state=partial, success=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('prevent_destroy', result.stderr)

    def test_metadata_stage_requires_resources(self):
        result = self.plan(False, metadata=True, success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid index', result.stderr)
        installed = self.plan(True, metadata=True, state=self.legacy_state())
        statements = installed['planned_values']['outputs']['metadata']['value']
        self.assertEqual(len(statements), 2)
        self.assertEqual(statements[1]['Resource'], 'arn:aws:iam::' + ACCOUNT + ':role/' + ROLE)
