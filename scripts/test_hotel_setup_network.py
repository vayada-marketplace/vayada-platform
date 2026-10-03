"""Plan only the private network offline, using fake credentials and no data sources."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def plan(enabled, service=None):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "infra"
        path.mkdir()
        if service is not None:
            for name in ["hotel_setup_credentials.tf", "hotel_setup_secret_read_policy.json.tftpl", "hotel_setup_service.tf", "hotel_setup_container.json.tftpl"]:
                shutil.copy(ROOT / "infra" / name, path)
            (path.parent / "deployment").mkdir()
            (path.parent / "deployment/hotel-setup-command-images.json").write_text(json.dumps(service.get("inventory", {})))
            (path.parent / "rehearsal").mkdir()
            shutil.copy(ROOT / "rehearsal/rds-ca-rsa2048-g1.pem", path.parent / "rehearsal")
        shutil.copy(ROOT / 'infra/hotel_setup_network.tf', path)
        shutil.copy(ROOT / 'infra/.terraform.lock.hcl', path)
        # Reuse init's providers; do not download another copy on small local disks.
        (path / '.terraform').symlink_to(ROOT / 'infra/.terraform', target_is_directory=True)
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
output "setup_environment" { value = local.hotel_setup_environment }
''')
            (path / 'fixture.auto.tfvars.json').write_text(json.dumps({
                'enable_hotel_setup_service_staging': service.get('enabled', False),
                'enable_hotel_setup_credential_infrastructure': service.get('credentials', False),
                'hotel_setup_image_digests': service.get('digests', {'primary': '', 'rollback': ''})}))
        env = {**os.environ, 'AWS_EC2_METADATA_DISABLED': 'true'}
        env.pop('AWS_PROFILE', None)
        for command in [
            ['init', '-backend=false', '-input=false', '-no-color'],
            ['plan', '-input=false', '-refresh=false', '-no-color', '-out=fixture.plan', f'-var=enable_hotel_setup_private_network={str(enabled).lower()}']]:
            completed = subprocess.run(['terraform', *command], cwd=path, env=env, capture_output=True, text=True)
            if completed.returncode:
                raise AssertionError(completed.stdout + completed.stderr)
        result = subprocess.run(['terraform', 'show', '-json', 'fixture.plan'], cwd=path, env=env, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)


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


if __name__ == '__main__':
    unittest.main()
