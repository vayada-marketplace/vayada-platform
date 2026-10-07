"""Plan only the private network offline, using fake credentials and no data sources."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def plan(enabled, service=None, property_network=False):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "infra"
        path.mkdir()
        if service is not None:
            for name in ["hotel_setup_creation_bootstrap.tf", "hotel_setup_credentials.tf", "hotel_setup_property_credentials.tf", "hotel_setup_logo.tf", "hotel_setup_secret_read_policy.json.tftpl", "hotel_setup_service.tf", "hotel_setup_property_service.tf", "hotel_setup_container.json.tftpl", *service.get("extra_files", [])]:
                shutil.copy(ROOT / "infra" / name, path)
            for name in ("hotel_setup_property_service.tf", "hotel_setup_logo.tf"):
                copied = path / name
                copied.write_text(copied.read_text().replace("aws_s3_bucket.private_profile_media", "local.fixture_media_bucket"))
            (path.parent / "deployment").mkdir()
            (path.parent / "deployment/hotel-setup-command-images.json").write_text(json.dumps(service.get("inventory", {})))
            (path.parent / "deployment/hotel-setup-logo-images.json").write_text(json.dumps(service.get("logo_inventory", {})))
            (path.parent / "deployment/hotel-setup-property-images.json").write_text(json.dumps(service.get("property_inventory", {})))
            (path.parent / "rehearsal").mkdir()
            shutil.copy(ROOT / "rehearsal/rds-ca-rsa2048-g1.pem", path.parent / "rehearsal")
        shutil.copy(ROOT / 'infra/hotel_setup_network.tf', path)
        shutil.copy(ROOT / 'infra/hotel_setup_property_network.tf', path)
        shutil.copy(ROOT / 'infra/.terraform.lock.hcl', path)
        # Reuse init's providers; do not download another copy on small local disks.
        (path / '.terraform').mkdir()
        (path / '.terraform/providers').symlink_to(ROOT / 'infra/.terraform/providers', target_is_directory=True)
        (path / 'fixture.tf').write_text('''
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
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
variable "vpc_id" { default = "vpc-0123456789abcdef0" }
variable "rds_sg_id" { default = "sg-0123456789abcdef0" }
variable "subnet_ids" { default = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"] }
resource "aws_acm_certificate_validation" "wildcard_vayada" {
  certificate_arn = "arn:aws:acm:eu-west-1:269416271598:certificate/00000000-0000-4000-8000-000000000000"
}
output "rules" { value = local.hotel_setup_network_rules }
''')
        if service is not None:
            with (path / 'fixture.tf').open('a') as fixture:
                fixture.write('''
variable "aws_region" { default = "eu-west-1" }
variable "aws_account_id" { default = "269416271598" }
variable "ecs_cluster_name" { default = "offline-cluster" }
variable "rds_endpoint" { default = "db.internal" }
variable "workos_jwks_url" { default = "https://api.workos.com/jwks/client_fixture" }
variable "workos_issuer" { default = "https://api.workos.com/" }
variable "workos_audience" { default = "client_fixture" }
resource "aws_iam_role_policy_attachment" "hotel_setup_platform_deploy" {
  count = 0
  role = "offline-deploy-role"
  policy_arn = "arn:aws:iam::269416271598:policy/offline"
}
locals {
  private_profile_media_cdn_base_url = "https://images.vayada.com"
  fixture_media_bucket = { id = "vayada-media-production", arn = "arn:aws:s3:::vayada-media-production", bucket_regional_domain_name = "vayada-media-production.s3.eu-west-1.amazonaws.com" }
}
output "setup_environment" { value = local.hotel_setup_environment }
output "property_environment" { value = local.hotel_setup_property_environment }
''')
            (path / 'fixture.auto.tfvars.json').write_text(json.dumps({
                'enable_hotel_setup_service_staging': service.get('enabled', False),
                'enable_hotel_setup_credential_infrastructure': service.get('credentials', False),
                'hotel_setup_command_mode': service.get('mode', 'property_commands'),
                'enable_hotel_setup_property_credentials': service.get('property_credentials', False),
                'enable_hotel_setup_logo_storage': service.get('logo_storage', False),
                'enable_hotel_setup_profile_credentials': service.get('profile_credentials', False),
                'hotel_setup_logo_private_admission': service.get('logo_admission', 'blocked'),
                'enable_hotel_setup_property_service_staging': service.get('property_enabled', False),
                'hotel_setup_property_image_digests': service.get('property_digests', {'primary': '', 'rollback': ''}),
                'hotel_setup_image_digests': service.get('digests', {'primary': '', 'rollback': ''})}))
        env = {**os.environ, 'AWS_EC2_METADATA_DISABLED': 'true'}
        env.pop('AWS_PROFILE', None)
        for command in [
            ['init', '-backend=false', '-input=false', '-no-color'],
            ['plan', '-input=false', '-refresh=false', '-no-color', '-out=fixture.plan', f'-var=enable_hotel_setup_private_network={str(enabled).lower()}', f'-var=enable_hotel_setup_property_network={str(property_network).lower()}']]:
            completed = subprocess.run(['terraform', *command], cwd=path, env=env, capture_output=True, text=True)
            if completed.returncode:
                raise AssertionError(completed.stdout + completed.stderr)
        result = subprocess.run(['terraform', 'show', '-json', 'fixture.plan'], cwd=path, env=env, capture_output=True, text=True, check=True)
        rendered = json.loads(result.stdout)
        if service and service.get('existing_service'):
            property_service = service['existing_service'] == 'property'
            resource_name = 'hotel_setup_property' if property_service else 'hotel_setup'
            service_name = 'vayada-hotel-setup-property-service' if property_service else 'vayada-hotel-setup-service'
            task_family = 'vayada-hotel-setup-property-primary' if property_service else 'vayada-hotel-setup-primary'
            resource = next(r for r in rendered['planned_values']['root_module']['resources']
                            if r['address'] == f'aws_ecs_service.{resource_name}[0]')
            values = resource['values']
            values.update(id=f'arn:aws:ecs:eu-west-1:269416271598:service/offline-cluster/{service_name}',
                          desired_count=1, task_definition=f'arn:aws:ecs:eu-west-1:269416271598:task-definition/{task_family}:77')
            (path / 'terraform.tfstate').write_text(json.dumps({
                'version': 4, 'serial': 1, 'lineage': str(uuid4()), 'outputs': {},
                'resources': [{'mode': 'managed', 'type': 'aws_ecs_service', 'name': resource_name,
                               'provider': 'provider["registry.terraform.io/hashicorp/aws"]',
                               'instances': [{'index_key': 0, 'schema_version': resource['schema_version'], 'attributes': values}]}]}))
            flag = 'enable_hotel_setup_property_service_staging' if property_service else 'enable_hotel_setup_service_staging'
            overrides = [f'-var={flag}=false'] if service.get('remove_service') else []
            resumed = subprocess.run(['terraform', 'plan', '-input=false', '-refresh=false', '-no-color',
                                      '-out=resumed.plan', f'-var=enable_hotel_setup_private_network={str(enabled).lower()}',
                                      f'-var=enable_hotel_setup_property_network={str(property_network).lower()}', *overrides],
                                     cwd=path, env=env, capture_output=True, text=True)
            if resumed.returncode:
                raise AssertionError(resumed.stdout + resumed.stderr)
            result = subprocess.run(['terraform', 'show', '-json', 'resumed.plan'], cwd=path, env=env,
                                    capture_output=True, text=True, check=True)
            rendered = json.loads(result.stdout)
        return rendered


class HotelSetupNetworkTests(unittest.TestCase):
    def test_no_network_by_default(self):
        resources = plan(False)['planned_values']['root_module']['resources']
        self.assertEqual([r for r in resources if 'hotel_setup' in r['address']], [])

    def test_internal_tls_and_no_shared_or_internet_ingress(self):
        result = plan(True)
        resources = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
        self.assertTrue(resources['aws_lb.hotel_setup[0]']['internal'])
        listener = resources['aws_lb_listener.hotel_setup[0]']
        self.assertEqual((listener['port'], listener['protocol']), (443, 'HTTPS'))
        self.assertEqual(listener['ssl_policy'], 'ELBSecurityPolicy-TLS13-1-2-2021-06')
        self.assertEqual(listener['default_action'][0]['type'], 'fixed-response')
        self.assertEqual(listener['default_action'][0]['fixed_response'][0]['status_code'], '403')
        self.assertEqual(resources['aws_lb_listener_rule.hotel_setup_creation[0]']['condition'][0]['host_header'][0]['values'], ['hotel-setup-command.vayada.com'])
        self.assertEqual(resources['aws_route53_zone.hotel_setup[0]']['name'], 'hotel-setup-command.vayada.com')
        self.assertEqual(len(resources['aws_route53_zone.hotel_setup[0]']['vpc']), 1)
        rules = result['planned_values']['outputs']['rules']['value']
        ingress = [r for r in rules.values() if r['type'] == 'ingress']
        self.assertCountEqual(ingress, [
            {'type': 'ingress', 'port': 443, 'owner': 'alb', 'peer': 'caller'},
            {'type': 'ingress', 'port': 8011, 'owner': 'task', 'peer': 'alb'}])
        for address, values in resources.items():
            if values.get('type') == 'ingress':
                self.assertFalse(values.get('cidr_blocks'), address)
                self.assertFalse(values.get('ipv6_cidr_blocks'), address)
            self.assertNotIn('aws_ecs_', address)
        internal = next(r for r in result['configuration']['root_module']['resources']
                        if r['address'] == 'aws_security_group_rule.hotel_setup_internal')
        self.assertEqual(set(internal['expressions']['source_security_group_id']['references']),
                         {'aws_security_group.hotel_setup', 'each.value.peer', 'each.value'})
        self.assertEqual(set(internal['expressions']['security_group_id']['references']),
                         {'aws_security_group.hotel_setup', 'each.value.owner', 'each.value'})
        self.assertEqual(resources['aws_security_group_rule.hotel_setup_database["ingress"]']['security_group_id'], 'sg-0123456789abcdef0')
        self.assertEqual(resources['aws_security_group_rule.hotel_setup_database["egress"]']['source_security_group_id'], 'sg-0123456789abcdef0')
        egress = resources['aws_security_group_rule.hotel_setup_https[0]']
        self.assertEqual((egress['type'], egress['from_port'], egress['to_port']), ('egress', 443, 443))
        self.assertEqual(egress['cidr_blocks'], ['0.0.0.0/0'])
        self.assertEqual(resources['aws_lb_target_group.hotel_setup[0]']['health_check'][0]['matcher'], '401')

    def test_property_host_and_task_are_isolated_on_shared_tls(self):
        with self.assertRaisesRegex(AssertionError, 'requires the shared private'):
            plan(False, property_network=True)
        result = plan(True, property_network=True)
        resources = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
        self.assertEqual(len([r for r in resources if r.startswith('aws_lb.')]), 1)
        self.assertEqual(resources['aws_route53_zone.hotel_setup_property[0]']['name'], 'hotel-setup-property-command.vayada.com')
        self.assertEqual(resources['aws_security_group.hotel_setup_property_task[0]']['name'], 'vayada-hotel-setup-property-task')
        rule = resources['aws_lb_listener_rule.hotel_setup_property[0]']
        self.assertEqual(rule['condition'][0]['host_header'][0]['values'], ['hotel-setup-property-command.vayada.com'])
        configuration = {r['address']: r for r in result['configuration']['root_module']['resources']}
        self.assertIn('aws_lb_target_group.hotel_setup_property', configuration['aws_lb_listener_rule.hotel_setup_property']['expressions']['action'][0]['target_group_arn']['references'])
        self.assertEqual(resources['aws_security_group_rule.hotel_setup_property_database["ingress"]']['security_group_id'], 'sg-0123456789abcdef0')
        self.assertEqual(resources['aws_security_group_rule.hotel_setup_property_database["egress"]']['source_security_group_id'], 'sg-0123456789abcdef0')
        for address, value in resources.items():
            if value.get('type') == 'ingress':
                self.assertFalse(value.get('cidr_blocks'), address)
                self.assertFalse(value.get('ipv6_cidr_blocks'), address)
            self.assertFalse(address.startswith('aws_ecs_'))


if __name__ == '__main__':
    unittest.main()
