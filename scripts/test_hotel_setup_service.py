"""Offline staging guard and the exact primary/rollback container contract."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from scripts.test_hotel_setup_network import ROOT, plan

DIGEST = 'sha256:' + 'a' * 64
ROLLBACK = 'sha256:' + 'b' * 64


class HotelSetupServiceTests(unittest.TestCase):
    def test_default_off_and_unreviewed_images_fail_closed(self):
        result = plan(False, service={})
        resources = result['planned_values']['root_module']['resources']
        self.assertFalse(any('hotel_setup' in r['address'] for r in resources))
        selected = {'enabled': True, 'credentials': True,
                    'digests': {'primary': DIGEST, 'rollback': ROLLBACK}}
        with self.assertRaisesRegex(AssertionError, 'reviewed private-executable image inventory'):
            plan(True, service=selected)
        selected['inventory'] = {DIGEST: 'c' * 40}
        with self.assertRaisesRegex(AssertionError, 'reviewed private-executable image inventory'):
            plan(True, service=selected)
        selected['inventory'][ROLLBACK] = 'd' * 40
        result = plan(True, service=selected)
        resources = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
        environment = {entry['name']: entry['value'] for entry in result['planned_values']['outputs']['setup_environment']['value']}
        self.assertEqual(set(environment), {'NODE_ENV', 'HOST', 'PORT', 'AWS_REGION', 'HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT', 'HOTEL_SETUP_COMMAND_MODE', 'HOTEL_SETUP_COMMAND_SECRET_PREFIX', 'HOTEL_SETUP_COMMAND_WORKOS_JWKS_URL', 'HOTEL_SETUP_COMMAND_WORKOS_ISSUER', 'HOTEL_SETUP_COMMAND_WORKOS_AUDIENCE', 'HOTEL_SETUP_RDS_CA', 'NODE_EXTRA_CA_CERTS'})
        self.assertEqual(environment['HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT'], 'postgresql://db.internal:5432/vayada_target_prod')
        self.assertEqual(environment['HOTEL_SETUP_COMMAND_MODE'], 'property_commands')
        self.assertEqual(environment['HOTEL_SETUP_COMMAND_SECRET_PREFIX'], 'hotel-setup-command/prod/property/')
        self.assertEqual(environment['NODE_EXTRA_CA_CERTS'], '/runtime/rds-ca.pem')
        service = resources['aws_ecs_service.hotel_setup[0]']
        self.assertEqual(service['desired_count'], 0)
        self.assertFalse(service['enable_execute_command'])
        self.assertTrue(service['network_configuration'][0]['assign_public_ip'])
        self.assertEqual(set(r for r in resources if r.startswith('aws_ecs_task_definition.')), {
            'aws_ecs_task_definition.hotel_setup["primary"]', 'aws_ecs_task_definition.hotel_setup["rollback"]'})
        task = next(r for r in result['configuration']['root_module']['resources']
                    if r['address'] == 'aws_ecs_task_definition.hotel_setup')
        self.assertIn('aws_iam_role.hotel_setup_execution', task['expressions']['execution_role_arn']['references'])
        self.assertIn('aws_iam_role.hotel_setup_task', task['expressions']['task_role_arn']['references'])
        selected['credentials'] = False
        with self.assertRaisesRegex(AssertionError, 'Hotel setup staging requires'):
            plan(True, service=selected)

    def test_creation_mode_isolated_and_still_not_started(self):
        selected = {'enabled': True, 'credentials': True, 'mode': 'property_creation',
                    'digests': {'primary': DIGEST, 'rollback': ROLLBACK},
                    'inventory': {DIGEST: 'c' * 40, ROLLBACK: 'd' * 40}}
        result = plan(True, service=selected)
        environment = {entry['name']: entry['value'] for entry in result['planned_values']['outputs']['setup_environment']['value']}
        self.assertEqual(environment['HOTEL_SETUP_COMMAND_MODE'], 'property_creation')
        self.assertEqual(environment['HOTEL_SETUP_COMMAND_SECRET_PREFIX'], 'hotel-setup-command/prod/organization/')
        resources = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
        self.assertEqual(resources['aws_ecs_service.hotel_setup[0]']['desired_count'], 0)
        configuration = {r['address']: r for r in result['configuration']['root_module']['resources']}
        reader_policy = configuration['aws_iam_role_policy.hotel_setup_creation_reader_bootstrap']
        self.assertIn('aws_secretsmanager_secret.hotel_setup', reader_policy['expressions']['policy']['references'])
        self.assertNotIn('local.hotel_setup_creation_secret_arn', reader_policy['expressions']['policy']['references'])
        self.assertEqual(resources['aws_iam_role.hotel_setup_creation_reader_bootstrap[0]']['name'], 'vayada-hotel-setup-creation-reader-bootstrap')
        policy = json.loads(resources['aws_iam_role_policy.hotel_setup_property_secrets[0]']['policy'])
        self.assertIn('/organization/vayada_next_hotel_setup_org_', policy['Statement'][0]['Resource'][0])
        for key in ['internal_token', 'reader_database_url']:
            self.assertTrue(resources[f'aws_secretsmanager_secret.hotel_setup["{key}"]']['name'].startswith('hotel-setup-creation/'))

    def test_separate_property_credentials_do_not_adopt_creation_or_start_tasks(self):
        with self.assertRaisesRegex(AssertionError, 'off or reserved for property_creation'):
            plan(False, service={'credentials': True, 'property_credentials': True})
        for original_enabled in [False, True]:
            result = plan(False, service={'credentials': original_enabled,
                                         'property_credentials': True, 'mode': 'property_creation'})
            resources = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
            self.assertFalse(any(r.startswith('aws_ecs_') for r in resources))
            self.assertEqual(resources['aws_iam_role.hotel_setup_property_task[0]']['name'], 'vayada-hotel-setup-property-task')
            self.assertEqual(resources['aws_iam_role.hotel_setup_property_execution[0]']['name'], 'vayada-hotel-setup-property-execution')
            native = json.loads(resources['aws_iam_role_policy.hotel_setup_property_native_secrets[0]']['policy'])
            statement, = native['Statement']
            self.assertEqual(statement['Action'], ['secretsmanager:GetSecretValue'])
            self.assertEqual(statement['Resource'], ['arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/property/vayada_next_hotel_setup_property_*'])
            for key in ['reader_database_url', 'internal_token']:
                self.assertEqual(resources[f'aws_secretsmanager_secret.hotel_setup_property["{key}"]']['name'], 'hotel-setup-command/prod/' + key.replace('_', '-'))
            configuration = {r['address']: r for r in result['configuration']['root_module']['resources']}
            references = configuration['aws_iam_role_policy.hotel_setup_property_execution_secrets']['expressions']['policy']['references']
            self.assertIn('aws_secretsmanager_secret.hotel_setup_property', references)
            self.assertNotIn('aws_secretsmanager_secret.hotel_setup', references)

    def test_exact_container_and_verified_rds_trust(self):
        values = {
            'image_json': json.dumps('fixture@' + DIGEST),
            'environment_json': json.dumps([{'name': 'NODE_EXTRA_CA_CERTS', 'value': '/runtime/rds-ca.pem'}]),
            'reader_arn_json': json.dumps('reader-arn'), 'token_arn_json': json.dumps('token-arn'),
            'log_group_json': json.dumps('/ecs/vayada-hotel-setup'), 'region_json': json.dumps('eu-west-1')}
        template = (ROOT / 'infra/hotel_setup_container.json.tftpl').read_text()
        for name, value in values.items():
            template = template.replace('${' + name + '}', value)
        container, = json.loads(template)
        self.assertTrue(container['readonlyRootFilesystem'])
        self.assertFalse(container['privileged'])
        self.assertEqual(container['workingDirectory'], '/app')
        self.assertEqual(container['entryPoint'], ['/bin/sh', '-ec'])
        self.assertEqual([s['name'] for s in container['secrets']], [
            'HOTEL_SETUP_COMMAND_READER_DATABASE_URL', 'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN'])
        command, = container['command']
        self.assertTrue(command.endswith('exec node apps/api/dist/hotelSetupCommandServer.js'))
        # Exercise the actual CA-writing shell prefix; no app, network or credentials.
        ca = (ROOT / 'rehearsal/rds-ca-rsa2048-g1.pem').read_text()
        with tempfile.TemporaryDirectory() as directory:
            prefix = command.split('; exec node', 1)[0].replace('/runtime/rds-ca.pem', directory + '/rds-ca.pem')
            subprocess.run(['/bin/sh', '-ec', prefix], env={'HOTEL_SETUP_RDS_CA': ca}, check=True)
            target = Path(directory, 'rds-ca.pem')
            self.assertEqual(target.read_text(), ca)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        inventory = json.loads((ROOT / 'deployment/hotel-setup-command-images.json').read_text())
        proof = json.loads((ROOT / 'deployment/hotel-setup-creation-image-proof.json').read_text())
        self.assertEqual(inventory, {proof[key]['digest']: proof[key]['source'] for key in ('primary', 'rollback')})
        for digest, source in inventory.items():
            self.assertRegex(digest, r'^sha256:[a-f0-9]{64}$')
            self.assertRegex(source, r'^[a-f0-9]{40}$')
        self.assertEqual(proof['purpose'], 'property_creation')
        self.assertEqual(proof['verification']['postgresVersions'], [16, 17])
        self.assertTrue(proof['verification']['actualCompiledImage'])


if __name__ == '__main__':
    unittest.main()
