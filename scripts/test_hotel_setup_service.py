"""Offline staging guard and the exact primary/rollback container contract."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from scripts.test_hotel_setup_network import ROOT, plan

DIGEST = 'sha256:' + 'a' * 64
ROLLBACK = 'sha256:' + 'b' * 64
HARDENED_REVIEWED_PAIR = {
    'sha256:3316fce31bb4382def31ef37a7e6ff9d83d69ee6ea582ac1dcea8722551f827d': 'c2acd36190563e6c589c7d9202059a4b3f2c55be',
    'sha256:bafc5880043ff7019d9921d195a5d5998d8b99f57b95bf3f251e85b0e1e8c698': '7acb01ab601146d50c5c514abf1b23a8bac08c18',
    'sha256:259f22ca5f9d90cfa87239adfff6a396bd3877598372c20a377dc055dfd3df6b': '187eeea3a5d6864283b854815334fe34c7ec752b',
    'sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965': '3efb2195a823f40b7cd5a716db5bf08ac3fe90ad',
}


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
        configuration = {r['address']: r for r in result['configuration']['root_module']['resources']}
        self.assertIn('aws_lb_listener_rule.hotel_setup_creation', configuration['aws_ecs_service.hotel_setup']['depends_on'])
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

    def test_logo_admission_requires_scoped_storage_and_both_full_proof_images(self):
        selected = {'property_credentials': True, 'mode': 'property_creation',
                    'property_enabled': True, 'property_digests': {'primary': DIGEST, 'rollback': ROLLBACK},
                    'property_inventory': {DIGEST: 'c' * 40, ROLLBACK: 'd' * 40},
                    'logo_admission': 'enabled'}
        with self.assertRaisesRegex(AssertionError, 'full lifecycle proof'):
            plan(True, service=selected, property_network=True)
        selected.update(logo_storage=True, logo_inventory={DIGEST: 'c' * 40})
        with self.assertRaisesRegex(AssertionError, 'full lifecycle proof'):
            plan(True, service=selected, property_network=True)
        selected['logo_inventory'][ROLLBACK] = 'd' * 40
        result = plan(True, service=selected, property_network=True)
        env = {entry['name']: entry['value'] for entry in result['planned_values']['outputs']['property_environment']['value']}
        self.assertEqual(env['HOTEL_SETUP_LOGO_COMMAND_ADMISSION'], 'enabled')
        resources = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
        self.assertEqual(resources['aws_ecs_service.hotel_setup_property[0]']['desired_count'], 0)
        self.assertIn('aws_iam_role_policy.hotel_setup_logo_media[0]', resources)

    def test_profile_credentials_extend_only_property_task_and_bootstrap_reads(self):
        prefix = 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/property/vayada_next_hotel_setup_'
        selected = {'credentials': True, 'mode': 'property_creation', 'property_credentials': True, 'logo_storage': True,
                    'extra_files': ['hotel_setup_property_bootstrap.tf']}
        plans = {}
        for profile in (False, True):
            result = plan(False, service={**selected, 'profile_credentials': profile})
            plans[profile] = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
        for profile, resources in plans.items():
            expected = [prefix + kind + '_*' for kind in ('property', 'logo', *(('profile',) if profile else ()))]
            native, = json.loads(resources['aws_iam_role_policy.hotel_setup_property_native_secrets[0]']['policy'])['Statement']
            self.assertEqual((native['Action'], native['Resource']), (['secretsmanager:GetSecretValue'], expected))
            bootstrap, = json.loads(resources['aws_iam_role_policy.hotel_setup_property_bootstrap[0]']['policy'])['Statement']
            self.assertEqual(bootstrap['Action'], ['secretsmanager:CreateSecret', 'secretsmanager:DescribeSecret',
                                                   'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'])
            self.assertEqual(bootstrap['Resource'], expected)
            # Injected reader/token reads stay container-exact (unknown until apply) and never gain native prefixes.
            self.assertNotIn('policy', resources['aws_iam_role_policy.hotel_setup_property_execution_secrets[0]'])
            self.assertFalse(any(address.startswith('aws_ecs_') for address in resources))
        changed = {address for address in plans[True] if plans[True][address] != plans[False].get(address)}
        self.assertEqual(changed, {'aws_iam_role_policy.hotel_setup_property_native_secrets[0]',
                                   'aws_iam_role_policy.hotel_setup_property_bootstrap[0]'})
        self.assertEqual(set(plans[True]), set(plans[False]))

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

    def test_property_staging_is_default_off_and_requires_both_reviewed_images(self):
        selected = {'mode': 'property_creation', 'credentials': True,
                    'property_enabled': True, 'property_credentials': True,
                    'property_digests': {'primary': DIGEST, 'rollback': ROLLBACK}}
        with self.assertRaisesRegex(AssertionError, 'Property setup staging requires'):
            plan(True, service=selected, property_network=True)
        selected['property_inventory'] = {DIGEST: 'c' * 40}
        with self.assertRaisesRegex(AssertionError, 'Property setup staging requires'):
            plan(True, service=selected, property_network=True)
        selected['property_inventory'][ROLLBACK] = 'd' * 40
        for credentials, network in [(False, True), (True, False)]:
            with self.assertRaisesRegex(AssertionError, 'Property setup staging requires'):
                plan(True, service={**selected, 'property_credentials': credentials}, property_network=network)
        result = plan(True, service=selected, property_network=True)
        resources = {r['address']: r['values'] for r in result['planned_values']['root_module']['resources']}
        service = resources['aws_ecs_service.hotel_setup_property[0]']
        self.assertEqual(service['name'], 'vayada-hotel-setup-property-service')
        self.assertEqual(service['desired_count'], 0)
        self.assertFalse(service['enable_execute_command'])
        self.assertNotIn('aws_ecs_service.hotel_setup[0]', resources)
        environment = {e['name']: e['value'] for e in result['planned_values']['outputs']['property_environment']['value']}
        self.assertEqual(environment['HOTEL_SETUP_COMMAND_MODE'], 'property_commands')
        self.assertEqual(environment['HOTEL_SETUP_LOGO_COMMAND_ADMISSION'], 'blocked')
        self.assertEqual(environment['HOTEL_SETUP_COMMAND_SECRET_PREFIX'], 'hotel-setup-command/prod/property/')
        configuration = {r['address']: r for r in result['configuration']['root_module']['resources']}
        self.assertIn('aws_lb_listener_rule.hotel_setup_property', configuration['aws_ecs_service.hotel_setup_property']['depends_on'])
        task = configuration['aws_ecs_task_definition.hotel_setup_property']['expressions']
        self.assertIn('aws_iam_role.hotel_setup_property_execution', task['execution_role_arn']['references'])
        self.assertIn('aws_iam_role.hotel_setup_property_task', task['task_role_arn']['references'])
        for slot in ['primary', 'rollback']:
            self.assertEqual(resources[f'aws_ecs_task_definition.hotel_setup_property["{slot}"]']['family'], 'vayada-hotel-setup-property-' + slot)
        inventory = json.loads((ROOT / 'deployment/hotel-setup-property-images.json').read_text())
        proof = json.loads((ROOT / 'deployment/hotel-setup-property-image-proof.json').read_text())
        self.assertEqual(inventory, {proof[slot]['digest']: proof[slot]['source'] for slot in ('primary', 'rollback')} | HARDENED_REVIEWED_PAIR)
        self.assertNotEqual(proof['primary']['digest'], proof['rollback']['digest'])
        self.assertEqual(proof['verification']['postgresVersions'], [16, 17])
        source = (ROOT / 'infra/hotel_setup_property_service.tf').read_text()
        self.assertIn('prevent_destroy = true', source)
        self.assertIn('ignore_changes = [desired_count, task_definition]', source)

        # Both independently configured services can coexist without changing modes.
        selected.update(enabled=True, digests=selected['property_digests'], inventory=selected['property_inventory'])
        resources = {r['address']: r['values'] for r in plan(True, service=selected, property_network=True)['planned_values']['root_module']['resources']}
        self.assertEqual(len([r for r in resources if r.startswith('aws_ecs_task_definition.')]), 4)
        self.assertEqual(len([r for r in resources if r.startswith('aws_ecs_service.')]), 2)
        self.assertTrue(all(v['desired_count'] == 0 for r, v in resources.items() if r.startswith('aws_ecs_service.')))

    def test_property_restage_preserves_serving_task_count_and_rejects_removal(self):
        selected = {'mode': 'property_creation', 'property_enabled': True,
                    'property_credentials': True, 'existing_service': 'property',
                    'property_digests': {'primary': DIGEST, 'rollback': ROLLBACK},
                    'property_inventory': {DIGEST: 'c' * 40, ROLLBACK: 'd' * 40}}
        result = plan(True, service=selected, property_network=True)
        service = next(r['values'] for r in result['planned_values']['root_module']['resources']
                       if r['address'] == 'aws_ecs_service.hotel_setup_property[0]')
        self.assertEqual(service['desired_count'], 1)
        self.assertTrue(service['task_definition'].endswith(':77'))
        with self.assertRaisesRegex(AssertionError, 'cannot be destroyed'):
            plan(True, service={**selected, 'remove_service': True}, property_network=True)

    def test_creation_restage_preserves_serving_task_count_and_rejects_removal(self):
        selected = {'mode': 'property_creation', 'enabled': True, 'credentials': True,
                    'existing_service': 'creation',
                    'digests': {'primary': DIGEST, 'rollback': ROLLBACK},
                    'inventory': {DIGEST: 'c' * 40, ROLLBACK: 'd' * 40}}
        result = plan(True, service=selected)
        service = next(r['values'] for r in result['planned_values']['root_module']['resources']
                       if r['address'] == 'aws_ecs_service.hotel_setup[0]')
        self.assertEqual(service['desired_count'], 1)
        self.assertTrue(service['task_definition'].endswith(':77'))
        with self.assertRaisesRegex(AssertionError, 'cannot be destroyed'):
            plan(True, service={**selected, 'remove_service': True})

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
        self.assertEqual(inventory, {proof[key]['digest']: proof[key]['source'] for key in ('primary', 'rollback')} | HARDENED_REVIEWED_PAIR)
        for digest, source in inventory.items():
            self.assertRegex(digest, r'^sha256:[a-f0-9]{64}$')
            self.assertRegex(source, r'^[a-f0-9]{40}$')
        self.assertEqual(proof['purpose'], 'property_creation')
        self.assertEqual(proof['verification']['postgresVersions'], [16, 17])
        self.assertTrue(proof['verification']['actualCompiledImage'])


if __name__ == '__main__':
    unittest.main()
