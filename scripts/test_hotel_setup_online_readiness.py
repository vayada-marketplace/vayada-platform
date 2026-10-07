"""No administrative task can start while an incompatible private task exists."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('online', ROOT / 'scripts/assert-hotel-setup-online-readiness.py')
online = importlib.util.module_from_spec(spec)
spec.loader.exec_module(online)
DIGEST = 'sha256:' + 'a' * 64
IMAGE = online.release.REPOSITORY + '@' + DIGEST
INVENTORY = {'creation': {DIGEST: 'b' * 40}, 'property': {DIGEST: 'c' * 40}, 'operational': {}}


def definition(purpose):
    marker = 'property-' if purpose == 'property' else ''
    namespace = 'hotel-setup-command/prod/' if marker else 'hotel-setup-creation/prod/'
    family = 'vayada-hotel-setup-' + marker + 'primary'
    return {'taskDefinitionArn': 'arn:aws:ecs:eu-west-1:269416271598:task-definition/' + family + ':1',
            'family': family, 'executionRoleArn': online.ACCOUNT + 'vayada-hotel-setup-' + marker + 'execution',
            'taskRoleArn': online.ACCOUNT + 'vayada-hotel-setup-' + marker + 'task',
            'volumes': [{'name': 'runtime', 'host': {}}],
            'containerDefinitions': [{'name': 'hotel-setup', 'image': IMAGE,
                'entryPoint': online.ENTRY_POINT, 'command': online.COMMAND, 'workingDirectory': '/app',
                'mountPoints': [{'sourceVolume': 'runtime', 'containerPath': '/runtime', 'readOnly': False}],
                'readonlyRootFilesystem': True, 'privileged': False, 'environment': [
                    {'name': 'HOTEL_SETUP_COMMAND_MODE', 'value': 'property_commands' if marker else 'property_creation'},
                    {'name': 'HOTEL_SETUP_COMMAND_SECRET_PREFIX', 'value': 'hotel-setup-command/prod/' + ('property/' if marker else 'organization/')},
                    {'name': 'HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT', 'value': 'postgresql://vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod'},
                    *[{'name': key, 'value': value} for key, value in {'NODE_ENV': 'production', 'HOST': '0.0.0.0', 'PORT': '8011',
                        'AWS_REGION': 'eu-west-1', 'NODE_EXTRA_CA_CERTS': '/runtime/rds-ca.pem', 'HOTEL_SETUP_RDS_CA': (ROOT / 'rehearsal/rds-ca-rsa2048-g1.pem').read_text(),
                        'HOTEL_SETUP_COMMAND_WORKOS_JWKS_URL': 'https://api.workos.com/jwks/fixture',
                        'HOTEL_SETUP_COMMAND_WORKOS_ISSUER': 'https://api.workos.com', 'HOTEL_SETUP_COMMAND_WORKOS_AUDIENCE': 'fixture'}.items()]],
                'secrets': [{'name': name, 'valueFrom': 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + namespace + leaf + '-AbCd12'}
                    for name, leaf in [('HOTEL_SETUP_COMMAND_READER_DATABASE_URL', 'reader-database-url'),
                                       ('HOTEL_SETUP_COMMAND_INTERNAL_TOKEN', 'internal-token')]]}]}


class OnlineReadinessTest(unittest.TestCase):
    def test_only_proved_immutable_images_in_the_correct_purpose_are_accepted(self):
        self.assertEqual(online.approved(IMAGE, 'creation', INVENTORY), DIGEST)
        for image, purpose, inventory in [(IMAGE, 'creation', {}), (IMAGE, 'operational', INVENTORY),
                (online.release.REPOSITORY + ':latest', 'creation', INVENTORY),
                (IMAGE, 'creation', {'creation': {DIGEST: 'not-a-source'}})]:
            with self.subTest(image=image, purpose=purpose), self.assertRaises(RuntimeError):
                online.approved(image, purpose, inventory)

    def test_exact_serving_identity_credentials_endpoint_and_mode(self):
        for purpose in ('creation', 'property'):
            source = definition(purpose)
            before = copy.deepcopy(source)
            self.assertEqual(online.private_definition(source, purpose, INVENTORY), DIGEST)
            self.assertEqual(source, before)
            mutations = [lambda d: d.update(taskRoleArn=online.ACCOUNT + 'admin'),
                         lambda d: d.update(family='unrelated'),
                         lambda d: d['containerDefinitions'][0].update(entryPoint=['node']),
                         lambda d: d['containerDefinitions'][0].pop('entryPoint'),
                         lambda d: d['containerDefinitions'][0].update(command=['alternate.js']),
                         lambda d: d['containerDefinitions'][0].pop('command'),
                         lambda d: d['containerDefinitions'][0].update(workingDirectory='/proof/rollback'),
                         lambda d: d['containerDefinitions'][0]['mountPoints'][0].update(containerPath='/app/apps/api/dist'),
                         lambda d: d['containerDefinitions'][0].update(volumesFrom=[{'sourceContainer': 'other'}]),
                         lambda d: d['containerDefinitions'][0].update(environmentFiles=[{'type': 's3', 'value': 'arn:aws:s3:::fixture/startup.env'}]),
                         lambda d: next(e for e in d['containerDefinitions'][0]['environment'] if e['name'] == 'HOTEL_SETUP_RDS_CA').update(value='untrusted-ca'),
                         lambda d: d['volumes'][0].update(efsVolumeConfiguration={'fileSystemId': 'other'}),
                         lambda d: d['volumes'][0].update(host={'sourcePath': '/code'}),
                         *[lambda d, key=key: d['containerDefinitions'][0]['environment'].append({'name': key, 'value': 'injected'})
                           for key in ('NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'PATH', 'AWS_ACCESS_KEY_ID')],
                         lambda d: d['containerDefinitions'][0].update(readonlyRootFilesystem=False),
                         lambda d: d['containerDefinitions'][0]['secrets'].append({'name': 'ADMIN_URL', 'valueFrom': 'owner'}),
                         lambda d: d['containerDefinitions'][0]['secrets'][0].update(valueFrom='wrong-namespace'),
                         lambda d: d['containerDefinitions'][0]['environment'][0].update(value='wrong-mode'),
                         lambda d: d['containerDefinitions'][0]['environment'][2].update(value='postgresql://wrong/target')]
            for mutate in mutations:
                bad = copy.deepcopy(source)
                mutate(bad)
                with self.subTest(purpose=purpose, mutation=mutate), self.assertRaises(RuntimeError):
                    online.private_definition(bad, purpose, INVENTORY)

    def test_physical_task_and_draining_history_are_checked(self):
        source = definition('property')
        arn = 'arn:aws:ecs:eu-west-1:269416271598:task/' + online.release.CLUSTER + '/' + 'a' * 32
        stopped_arn = arn[:-32] + 'b' * 32
        base = {'taskArn': arn, 'taskDefinitionArn': source['taskDefinitionArn'], 'clusterArn': online.CLUSTER_ARN,
                'group': 'service:' + online.release.PRIVATE['property'], 'desiredStatus': 'RUNNING', 'lastStatus': 'RUNNING',
                'overrides': {'inferenceAcceleratorOverrides': [], 'containerOverrides': [{'name': 'hotel-setup'}]},
                'containers': [{'name': 'hotel-setup', 'image': IMAGE, 'imageDigest': DIGEST}]}
        variants = [('valid', None), ('valid-absent', lambda task: task['overrides'].pop('inferenceAcceleratorOverrides')), ('wrong-image', lambda task: task['containers'][0].update(imageDigest='sha256:' + 'c' * 64)),
                    ('wrong-service', lambda task: task.update(group='service:other')),
                    ('wrong-definition', lambda task: task.update(taskDefinitionArn='other:1')),
                    ('command-override', lambda task: task.update(overrides={'containerOverrides': [{'name': 'hotel-setup', 'command': ['alternate.js']}]})),
                    ('task-role-override', lambda task: task.update(overrides={'taskRoleArn': online.ACCOUNT + 'admin'})),
                    ('execution-role-override', lambda task: task.update(overrides={'executionRoleArn': online.ACCOUNT + 'admin'})),
                    ('environment-override', lambda task: task.update(overrides={'containerOverrides': [{'name': 'hotel-setup', 'environment': [{'name': 'HOTEL_SETUP_COMMAND_MODE', 'value': 'other'}]}]})),
                    *[('inference-invalid-' + str(index), lambda task, value=value: task.update(overrides={'inferenceAcceleratorOverrides': value}))
                      for index, value in enumerate(([{'deviceName': 'other'}], None, {}, ''))],
                    ('draining', None), ('unbounded-history', None), ('missing-physical', None)]
        for case, mutate in variants:
            task = copy.deepcopy(base)
            if mutate:
                mutate(task)
            def aws(*args):
                if args[1] == 'list-tasks':
                    if args[-1] == 'RUNNING':
                        return {'taskArns': [arn]}
                    return {'taskArns': [stopped_arn], **({'nextToken': 'more'} if case == 'unbounded-history' else {})}
                if args[-1] == arn:
                    return {'tasks': [] if case == 'missing-physical' else [task]}
                return {'tasks': [{'taskArn': stopped_arn, 'clusterArn': online.CLUSTER_ARN,
                    'group': base['group'], 'lastStatus': 'RUNNING' if case == 'draining' else 'STOPPED'}]}
            with self.subTest(case=case), patch.object(online.release, 'aws', side_effect=aws):
                if case in ('valid', 'valid-absent'):
                    self.assertEqual(online.physical_tasks(online.release.PRIVATE['property'], source), arn)
                else:
                    with self.assertRaises(RuntimeError):
                        online.physical_tasks(online.release.PRIVATE['property'], source)

    def test_checked_in_inventory_cannot_admit_the_old_serving_images(self):
        import json
        inventory = json.loads((ROOT / 'deployment/hotel-setup-online-images.json').read_text())
        self.assertEqual(set(inventory), {'creation', 'property', 'operational'})
        for purpose in inventory:
            with self.assertRaises(RuntimeError):
                online.approved(IMAGE, purpose, inventory)
        for purpose, digest in (
            ('creation','sha256:c2fbba1a4d3f8f7bc4c46d0816f125d3598cd1c1a4880dd3b103feb0d3aa67d2'),
            ('property','sha256:b673453b253fac2e94822c24158f6d599696d0fb71a2bc68c7f4a3be0f98f38a'),
        ):
            with self.subTest(purpose=purpose), self.assertRaises(RuntimeError):
                online.approved(online.release.REPOSITORY+'@'+digest,purpose,inventory)


    def test_public_physical_container_image_and_draining_are_checked(self):
        source = definition('creation')
        source['containerDefinitions'][0]['name'] = 'vayada-next-api'
        arn = online.CLUSTER_ARN.replace(':cluster/', ':task/') + '/' + 'd' * 32
        for case in ('valid', 'wrong-image', 'draining'):
            def aws(*args):
                if args[1] == 'list-tasks':
                    return {'taskArns': [arn] if args[-1] == 'RUNNING' else []}
                return {'tasks': [{'taskArn': arn, 'taskDefinitionArn': source['taskDefinitionArn'],
                    'clusterArn': online.CLUSTER_ARN, 'group': 'service:' + online.release.PUBLIC,
                    'desiredStatus': 'STOPPED' if case == 'draining' else 'RUNNING', 'lastStatus': 'RUNNING',
                    'overrides': {'inferenceAcceleratorOverrides': [], 'containerOverrides': [{'name': 'vayada-next-api'}]},
                    'containers': [{'name': 'vayada-next-api', 'image': IMAGE,
                        'imageDigest': 'wrong' if case == 'wrong-image' else DIGEST}]}]}
            with self.subTest(case=case), patch.object(online.release, 'aws', side_effect=aws):
                if case == 'valid':
                    self.assertEqual(online.physical_tasks(online.release.PUBLIC, source, 'vayada-next-api'), arn)
                else:
                    with self.assertRaises(RuntimeError):
                        online.physical_tasks(online.release.PUBLIC, source, 'vayada-next-api')

    def test_snapshot_reads_both_serving_purposes_and_rejects_public_replacement(self):
        public_arn = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1'
        public = {'taskDefinitionArn': public_arn, 'containerDefinitions': [{'name': 'vayada-next-api',
            'image': IMAGE, 'environment': [], 'secrets': []}]}
        for purpose in ('creation', 'property'):
            token = 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + online.release.SECRET[purpose] + '-AbCd12'
            public = online.release.prepare_public(public, purpose, 'enabled', DIGEST, token)
        public['taskDefinitionArn'] = public_arn
        definitions = {public_arn: public, **{definition(p)['taskDefinitionArn']: definition(p) for p in ('creation', 'property')}}
        for changed in (False, True):
            public_reads = 0
            calls = []
            def aws(*args):
                nonlocal public_reads
                calls.append(args[1])
                if args[1] == 'describe-services':
                    name = args[-1]
                    if name == online.release.PUBLIC:
                        public_reads += 1
                        arn = public_arn + 'changed' if changed and public_reads > 1 else public_arn
                    else:
                        purpose = next(p for p, n in online.release.PRIVATE.items() if n == name)
                        arn = definition(purpose)['taskDefinitionArn']
                    return {'services': [{'taskDefinition': arn, 'desiredCount': 1, 'runningCount': 1,
                        'pendingCount': 0, 'deployments': [{'status': 'PRIMARY', 'rolloutState': 'COMPLETED'}]}]}
                if args[1] == 'describe-task-definition':
                    return {'taskDefinition': definitions[args[-1]]}
                raise AssertionError('Unexpected operation: ' + args[1])
            with self.subTest(changed=changed), patch.object(online.release, 'aws', side_effect=aws), \
                 patch.object(online.release, 'approved'), patch.object(online.release, 'healthy'), \
                 patch.object(online, 'physical_tasks', return_value='synthetic-physical-task'):
                if changed:
                    with self.assertRaises(RuntimeError):
                        online.snapshot(INVENTORY)
                else:
                    self.assertEqual(set(online.snapshot(INVENTORY)['private']), {'creation', 'property'})
                self.assertEqual(set(calls), {'describe-services', 'describe-task-definition'})


if __name__ == '__main__':
    unittest.main()
