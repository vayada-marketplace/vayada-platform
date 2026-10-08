"""Check release transitions preserve the serving task and refuse fallback."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/release-hotel-setup.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
DIGEST = 'sha256:' + 'a' * 64
TOKEN = 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/internal-token-AbCd12'


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.task = {'taskDefinitionArn':'old:1', 'revision':1, 'taskRoleArn':'existing-public-task-role',
            'executionRoleArn':'existing-execution', 'containerDefinitions':[{'name':'vayada-next-api',
            'image':'old-image', 'command':['existing-launcher'], 'environment':[{'name':'FINANCE_EXPORT_WORKER_ENABLED','value':'true'}],
            'secrets':[{'name':'AUTH_DATABASE_URL','valueFrom':'existing-parameter'}]}]}

    def test_hold_preserves_every_unrelated_setting_and_does_not_mutate_source(self):
        old = copy.deepcopy(self.task)
        result = release.prepare_public(self.task, 'property', 'hold', DIGEST)
        self.assertEqual(self.task, old)
        self.assertEqual(result['taskRoleArn'], self.task['taskRoleArn'])
        self.assertEqual(result['executionRoleArn'], self.task['executionRoleArn'])
        item = result['containerDefinitions'][0]
        self.assertEqual(item['command'], ['existing-launcher'])
        self.assertEqual(item['secrets'], self.task['containerDefinitions'][0]['secrets'])
        self.assertEqual(release.environment(item), {'FINANCE_EXPORT_WORKER_ENABLED':'true','HOTEL_SETUP_COMMAND_ADMISSION':'blocked'})

    def test_enable_then_block_retains_pair_and_cannot_return_to_initial_hold(self):
        enabled = release.prepare_public(self.task, 'property', 'enabled', DIGEST, TOKEN)
        blocked = release.prepare_public(enabled, 'property', 'blocked', DIGEST)
        self.assertEqual(blocked['executionRoleArn'], release.EXECUTION)
        self.assertEqual(blocked['containerDefinitions'][0]['secrets'], enabled['containerDefinitions'][0]['secrets'])
        self.assertEqual(release.environment(blocked['containerDefinitions'][0])['HOTEL_SETUP_COMMAND_ORIGIN'], release.ORIGIN['property'])
        with self.assertRaises(RuntimeError): release.prepare_public(blocked, 'property', 'hold', DIGEST)
        with self.assertRaises(RuntimeError): release.prepare_public(self.task, 'property', 'blocked', DIGEST)
        with self.assertRaises(RuntimeError): release.prepare_public(self.task, 'property', 'enabled', DIGEST, 'native-secret')
        creation_hold = release.prepare_public(blocked, 'creation', 'hold', DIGEST)
        self.assertEqual(creation_hold['containerDefinitions'][0]['secrets'], blocked['containerDefinitions'][0]['secrets'])

    def test_logo_admission_preserves_other_callers_and_reuses_exact_private_token(self):
        property_enabled = release.prepare_public(self.task, 'property', 'enabled', DIGEST, TOKEN)
        logo_enabled = release.prepare_public(property_enabled, 'logo', 'enabled', DIGEST, TOKEN)
        blocked = release.prepare_public(logo_enabled, 'logo', 'blocked', DIGEST)
        env = release.environment(blocked['containerDefinitions'][0])
        self.assertEqual(env['HOTEL_SETUP_LOGO_COMMAND_ADMISSION'], 'blocked')
        self.assertEqual(env['HOTEL_SETUP_COMMAND_ADMISSION'], 'enabled')
        self.assertEqual(env['HOTEL_SETUP_LOGO_COMMAND_ORIGIN'], release.ORIGIN['property'])
        self.assertEqual(blocked['containerDefinitions'][0]['secrets'], logo_enabled['containerDefinitions'][0]['secrets'])
        with self.assertRaises(RuntimeError):
            release.prepare_public(self.task, 'logo', 'enabled', DIGEST, TOKEN.replace('internal-token', 'native-login'))
        with self.assertRaises(RuntimeError):
            release.approved(DIGEST, 'hotel-setup-logo-images.json')

    def test_profile_admission_reuses_property_pair_and_preserves_other_callers(self):
        property_enabled = release.prepare_public(self.task, 'property', 'enabled', DIGEST, TOKEN)
        logo_enabled = release.prepare_public(property_enabled, 'logo', 'enabled', DIGEST, TOKEN)
        profile_enabled = release.prepare_public(logo_enabled, 'profile', 'enabled', DIGEST, TOKEN)
        env = release.environment(profile_enabled['containerDefinitions'][0])
        self.assertEqual(env['HOTEL_SETUP_PROFILE_COMMAND_ADMISSION'], 'enabled')
        self.assertEqual(env['HOTEL_SETUP_PROFILE_COMMAND_ORIGIN'], 'https://hotel-setup-property-command.vayada.com')
        self.assertEqual(env['HOTEL_SETUP_LOGO_COMMAND_ADMISSION'], 'enabled')
        self.assertEqual(env['HOTEL_SETUP_COMMAND_ADMISSION'], 'enabled')
        self.assertEqual(env['FINANCE_EXPORT_WORKER_ENABLED'], 'true')
        secrets = {entry['name']: entry['valueFrom'] for entry in profile_enabled['containerDefinitions'][0]['secrets']}
        self.assertEqual(secrets['HOTEL_SETUP_PROFILE_COMMAND_INTERNAL_TOKEN'], TOKEN)
        self.assertEqual(secrets['AUTH_DATABASE_URL'], 'existing-parameter')
        blocked = release.prepare_public(profile_enabled, 'profile', 'blocked', DIGEST)
        env = release.environment(blocked['containerDefinitions'][0])
        self.assertEqual((env['HOTEL_SETUP_PROFILE_COMMAND_ADMISSION'], env['HOTEL_SETUP_LOGO_COMMAND_ADMISSION']), ('blocked', 'enabled'))
        self.assertEqual(blocked['containerDefinitions'][0]['secrets'], profile_enabled['containerDefinitions'][0]['secrets'])
        with self.assertRaises(RuntimeError): release.prepare_public(blocked, 'profile', 'hold', DIGEST)
        # Profile never forwards without the existing exact property pair or with another token.
        with self.assertRaises(RuntimeError): release.prepare_public(self.task, 'profile', 'enabled', DIGEST, TOKEN)
        with self.assertRaises(RuntimeError): release.prepare_public(self.task, 'profile', 'blocked', DIGEST)
        with self.assertRaises(RuntimeError):
            release.prepare_public(property_enabled, 'profile', 'enabled', DIGEST, TOKEN.replace('-AbCd12', '-EfGh34'))
        with self.assertRaises(RuntimeError):
            release.prepare_public(property_enabled, 'profile', 'enabled', DIGEST,
                TOKEN.replace('hotel-setup-command/prod/internal-token', 'hotel-setup-command/prod/property/vayada_next_hotel_setup_profile_x'))
        task = copy.deepcopy(self.task)
        task['containerDefinitions'][0]['image'] = release.REPOSITORY + '@' + DIGEST
        held = release.prepare_public(task, 'profile', 'hold', DIGEST)
        self.assertEqual(release.environment(held['containerDefinitions'][0])['HOTEL_SETUP_PROFILE_COMMAND_ADMISSION'], 'blocked')
        self.assertEqual(held['containerDefinitions'][0]['secrets'], task['containerDefinitions'][0]['secrets'])
        with self.assertRaises(RuntimeError): release.prepare_public(task, 'profile', 'hold', 'sha256:' + 'b' * 64)
        # The checked-in profile inventory starts empty: no image is profile-proved yet.
        self.assertEqual(json.loads((ROOT / 'deployment/hotel-setup-profile-images.json').read_text()),
                         {'sha256:1c5ddf7c26ad738ce55dc360f17e67ed5cbf46a1a8e09505c71b88a59a463a75': '3e78a281a28930d3023de18385c90411a6006625',  # VAY-965 natively proved profile-edit image D
                          'sha256:eacd03ed0c836b1d1e77e1b8fdb0ba5bb3a178b218700a627f6552534f60c846': '480602efd31b71e7997be1c5aae2c23930be3933',  # VAY-2055 connection-scope image
                          'sha256:6d82282ea8ef2dfba3a184e4b4af15f63ed252016379a1eaea133d62ce955c39': '46a34760a7137256a0d8dfd20954c9634899f684',  # VAY-2056 ordinary-login image (forwards nothing)
                          'sha256:VAY2056S1_DIGEST_PENDING': 'VAY2056S1_SOURCE_PENDING'})  # VAY-2056 step-1 image (native code removed)
        with self.assertRaises(RuntimeError): release.approved(DIGEST, 'hotel-setup-profile-images.json')

    def private_definition(self, family, digest):
        return {'family': family, 'executionRoleArn': 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-execution',
            'taskRoleArn': 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-task',
            'containerDefinitions': [{'name': 'hotel-setup', 'image': release.REPOSITORY + '@' + digest,
                'readonlyRootFilesystem': True, 'privileged': False,
                'environment': [{'name': 'HOTEL_SETUP_COMMAND_MODE', 'value': 'property_commands'},
                                {'name': 'HOTEL_SETUP_COMMAND_SECRET_PREFIX', 'value': 'hotel-setup-command/prod/property/'}],
                'secrets': [{'name': 'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN', 'valueFrom': TOKEN},
                            {'name': 'HOTEL_SETUP_COMMAND_READER_DATABASE_URL', 'valueFrom': TOKEN.replace('internal-token', 'reader-database-url')}]}]}

    PROFILE_POLICY = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Action': ['secretsmanager:GetSecretValue'],
        'Resource': ['arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/property/vayada_next_hotel_setup_' + kind + '_*'
                     for kind in ('property', 'logo', 'profile')]}]}

    def run_public_profile(self, state, private_profile=True, public_profile=True, private_running=True,
                           rollback_profile=True, policy=None, installed_profile=None):
        public_task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1200'
        private_task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-hotel-setup-property-primary:5'
        private_digest, rollback_digest = 'sha256:' + 'c' * 64, 'sha256:' + 'd' * 64
        public = release.prepare_public(self.task, 'property', 'enabled', DIGEST, TOKEN)
        if installed_profile:
            public = release.prepare_public(public, 'profile', installed_profile, DIGEST, TOKEN)
        public['taskDefinitionArn'] = public_task
        private = self.private_definition('vayada-hotel-setup-property-primary', private_digest)
        rollback = self.private_definition('vayada-hotel-setup-property-rollback', rollback_digest)
        live_policy = policy or self.PROFILE_POLICY
        registered, guarded, updated = [], [], []
        def mocked_aws(*args):
            operation = args[1]
            if operation == 'describe-services':
                name = args[args.index('--services') + 1]
                task = (public_task[:-4] + '1201' if updated else public_task) if name == release.PUBLIC else private_task
                running = int(name == release.PUBLIC or private_running)
                return {'services': [{'taskDefinition': task, 'desiredCount': running, 'runningCount': running, 'pendingCount': 0,
                    'loadBalancers': [{'targetGroupArn': 'target'}], 'deployments': [{'status': 'PRIMARY', 'rolloutState': 'COMPLETED'}]}]}
            if operation == 'describe-task-definition':
                return {'taskDefinition': {public_task: public, private_task: private,
                                           'vayada-hotel-setup-property-rollback': rollback}[args[-1]]}
            if operation == 'get-role-policy':
                self.assertEqual(args[2:], ('--role-name', 'vayada-hotel-setup-property-task',
                                            '--policy-name', 'hotel-setup-property-native-secret-read'))
                return {'PolicyDocument': copy.deepcopy(live_policy)}
            if operation == 'describe-images': return {'imageDetails': []}
            if operation == 'describe-target-health': return {'TargetHealthDescriptions': [{'TargetHealth': {'State': 'healthy'}}]}
            if operation == 'describe-secret': return {'ARN': TOKEN}
            if operation == 'register-task-definition':
                registered.append(json.loads(Path(args[-1][len('file://'):]).read_text()))
                return {'taskDefinition': {'taskDefinitionArn': public_task[:-4] + '1201'}}
            if operation == 'update-service':
                updated.append(args); return {}
            raise AssertionError(operation)
        def mocked_run(command, **kwargs):
            guarded.append(Path(command[1]).name)
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'deployment').mkdir()
            inventories = {'hotel-setup-caller-images.json': {DIGEST: 'a' * 40},
                'hotel-setup-property-images.json': {private_digest: 'c' * 40, rollback_digest: 'd' * 40},
                'hotel-setup-profile-images.json': {**({DIGEST: 'a' * 40} if public_profile else {}),
                                                    **({private_digest: 'c' * 40} if private_profile else {}),
                                                    **({rollback_digest: 'd' * 40} if rollback_profile else {})}}
            for name, value in inventories.items():
                Path(directory, 'deployment', name).write_text(json.dumps(value))
            argv = ['release', '--service', 'public', '--purpose', 'profile', '--state', state,
                    '--image-digest', DIGEST, '--expected-public-task', public_task]
            with patch.object(release, 'ROOT', Path(directory)), patch.object(release, 'aws', side_effect=mocked_aws), \
                    patch.object(release.subprocess, 'run', side_effect=mocked_run), patch('sys.argv', argv), \
                    patch.dict(release.os.environ, {'GITHUB_ACTIONS': 'true', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_RUN_ID': '7'}):
                release.main()
        self.assertIn('assert-next-api-split-compatible-image.py', guarded)
        self.assertIn('coordinated_release.py', guarded)
        self.assertEqual([args[args.index('--service') + 1] for args in updated], [release.PUBLIC])
        return registered

    def test_public_profile_enable_requires_profile_proved_public_and_serving_private_images(self):
        registered, = self.run_public_profile('enabled')
        item = registered['containerDefinitions'][0]
        env = release.environment(item)
        self.assertEqual((env['HOTEL_SETUP_PROFILE_COMMAND_ADMISSION'], env['HOTEL_SETUP_PROFILE_COMMAND_ORIGIN']),
                         ('enabled', 'https://hotel-setup-property-command.vayada.com'))
        self.assertEqual(registered['executionRoleArn'], release.EXECUTION)
        self.assertEqual(registered['taskRoleArn'], 'existing-public-task-role')
        self.assertEqual(item['image'], release.REPOSITORY + '@' + DIGEST)
        broad = copy.deepcopy(self.PROFILE_POLICY)
        broad['Statement'][0]['Resource'] = ['arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/property/*']
        missing = copy.deepcopy(self.PROFILE_POLICY)
        missing['Statement'][0]['Resource'] = missing['Statement'][0]['Resource'][:2]
        writes = copy.deepcopy(self.PROFILE_POLICY)
        writes['Statement'][0]['Action'] = ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']
        for options in ({'private_profile': False}, {'public_profile': False}, {'private_running': False},
                        {'rollback_profile': False}, {'policy': broad}, {'policy': missing}, {'policy': writes}):
            with self.subTest(options=list(options)), self.assertRaises(RuntimeError):
                self.run_public_profile('enabled', **options)
        with self.assertRaises(RuntimeError): self.run_public_profile('start')

    def test_public_profile_hold_and_blocked_follow_initial_and_retained_pair_rules(self):
        # hold only adds blocked admission to the installed image; it needs no profile-proved image.
        held, = self.run_public_profile('hold', public_profile=False, private_profile=False, rollback_profile=False)
        env = release.environment(held['containerDefinitions'][0])
        self.assertEqual(env['HOTEL_SETUP_PROFILE_COMMAND_ADMISSION'], 'blocked')
        self.assertNotIn('HOTEL_SETUP_PROFILE_COMMAND_ORIGIN', env)
        with self.assertRaises(RuntimeError): self.run_public_profile('hold', installed_profile='enabled')
        # blocked keeps the installed pair and requires the profile-proved public image.
        blocked, = self.run_public_profile('blocked', installed_profile='enabled', private_profile=False, rollback_profile=False)
        env = release.environment(blocked['containerDefinitions'][0])
        self.assertEqual((env['HOTEL_SETUP_PROFILE_COMMAND_ADMISSION'], env['HOTEL_SETUP_PROFILE_COMMAND_ORIGIN']),
                         ('blocked', 'https://hotel-setup-property-command.vayada.com'))
        with self.assertRaises(RuntimeError): self.run_public_profile('blocked', installed_profile='enabled', public_profile=False)
        with self.assertRaises(RuntimeError): self.run_public_profile('blocked')

    def test_unreleased_caller_requires_no_leftover_pair(self):
        api = {'environment': [{'name': 'HOTEL_SETUP_COMMAND_ADMISSION', 'value': 'blocked'}], 'secrets': []}
        self.assertTrue(release.caller_blocked(api, 'profile', optional=True))
        self.assertFalse(release.caller_blocked(api, 'profile'))
        self.assertFalse(release.caller_blocked(api, 'logo'))
        for extra in ({'environment': [{'name': 'HOTEL_SETUP_PROFILE_COMMAND_ORIGIN', 'value': release.ORIGIN['profile']}]},
                      {'secrets': [{'name': 'HOTEL_SETUP_PROFILE_COMMAND_INTERNAL_TOKEN', 'valueFrom': TOKEN}]},
                      {'environment': [{'name': 'HOTEL_SETUP_PROFILE_COMMAND_INTERNAL_TOKEN', 'value': 'inline'}]}):
            item = {key: api[key] + extra.get(key, []) for key in ('environment', 'secrets')}
            self.assertFalse(release.caller_blocked(item, 'profile', optional=True), extra)
        for value, expected in (('blocked', True), ('enabled', False)):
            item = {'environment': api['environment'] + [{'name': 'HOTEL_SETUP_PROFILE_COMMAND_ADMISSION', 'value': value},
                {'name': 'HOTEL_SETUP_PROFILE_COMMAND_ORIGIN', 'value': release.ORIGIN['profile']}], 'secrets': []}
            self.assertEqual(release.caller_blocked(item, 'profile', optional=True), expected)

    def test_initial_logo_hold_retains_the_installed_image_and_absent_pair(self):
        task = copy.deepcopy(self.task)
        task['containerDefinitions'][0]['image'] = release.REPOSITORY + '@' + DIGEST
        held = release.prepare_public(task, 'logo', 'hold', DIGEST)
        self.assertEqual(held['containerDefinitions'][0]['image'], task['containerDefinitions'][0]['image'])
        self.assertEqual(held['containerDefinitions'][0]['secrets'], task['containerDefinitions'][0]['secrets'])
        self.assertEqual(release.environment(held['containerDefinitions'][0])['HOTEL_SETUP_LOGO_COMMAND_ADMISSION'], 'blocked')
        with self.assertRaises(RuntimeError):
            release.prepare_public(task, 'logo', 'hold', 'sha256:' + 'b'*64)
        paired = release.prepare_public(task, 'property', 'enabled', DIGEST, TOKEN)
        paired = release.prepare_public(paired, 'logo', 'enabled', DIGEST, TOKEN)
        with self.assertRaises(RuntimeError):
            release.prepare_public(paired, 'logo', 'hold', DIGEST)

    def test_logo_admission_requires_the_live_exact_media_policy(self):
        task = {'taskRoleArn': 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-task'}
        policy = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow',
            'Action': ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
            'Resource': ['arn:aws:s3:::vayada-media-production/' + prefix
                         for prefix in ('staging/*', 'private/media/*', 'public/media/*')]}]}
        with patch.object(release, 'aws', return_value={'PolicyDocument': policy}) as call:
            release.require_logo_media_policy(task)
            call.assert_called_once_with('iam', 'get-role-policy', '--role-name',
                'vayada-hotel-setup-property-task', '--policy-name',
                'hotel-setup-logo-exact-media-object-access')
        for changed in ('missing', 'broad', 'read_only'):
            invalid = copy.deepcopy(policy)
            if changed == 'missing': invalid['Statement'] = []
            elif changed == 'broad': invalid['Statement'][0]['Resource'] = ['arn:aws:s3:::vayada-media-production/*']
            else: invalid['Statement'][0]['Action'] = ['s3:GetObject']
            with patch.object(release, 'aws', return_value={'PolicyDocument': invalid}):
                with self.assertRaises(RuntimeError): release.require_logo_media_policy(task)
        with patch.object(release, 'aws') as call:
            with self.assertRaises(RuntimeError): release.require_logo_media_policy({'taskRoleArn': 'broad-role'})
            call.assert_not_called()

    def test_private_start_uses_only_pinned_safe_definition_and_refuses_wrong_role(self):
        public_task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/public:1'
        private_task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-hotel-setup-property-primary:1'
        self.task['containerDefinitions'][0]['image'] = release.REPOSITORY + '@' + DIGEST
        self.task['containerDefinitions'][0]['environment'].append({'name':'HOTEL_SETUP_COMMAND_ADMISSION','value':'blocked'})
        definition = {'family':'vayada-hotel-setup-property-primary','executionRoleArn':'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-execution','taskRoleArn':'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-task','containerDefinitions':[{'name':'hotel-setup','image':release.REPOSITORY+'@'+DIGEST,'readonlyRootFilesystem':True,'privileged':False,'environment':[{'name':'HOTEL_SETUP_COMMAND_MODE','value':'property_commands'},{'name':'HOTEL_SETUP_COMMAND_SECRET_PREFIX','value':'hotel-setup-command/prod/property/'}],'secrets':[{'name':'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN','valueFrom':TOKEN},{'name':'HOTEL_SETUP_COMMAND_READER_DATABASE_URL','valueFrom':TOKEN.replace('internal-token','reader-database-url')}]}]}
        for wrong_role in (False, True):
            mutated = []
            def mocked_aws(*args):
                operation = args[1]
                if operation == 'describe-services':
                    public = args[args.index('--services')+1] == release.PUBLIC
                    running = public or bool(mutated)
                    return {'services':[{'taskDefinition':public_task if public else private_task,'desiredCount':int(running),'runningCount':int(running),'pendingCount':0,'loadBalancers':[{'targetGroupArn':'synthetic-target-group'}],'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED'}]}]}
                if operation == 'describe-task-definition':
                    if args[-1] == public_task: return {'taskDefinition':self.task}
                    value = copy.deepcopy(definition)
                    if wrong_role: value['taskRoleArn']='broad-role'
                    return {'taskDefinition':value}
                if operation == 'describe-target-health': return {'TargetHealthDescriptions':[{'TargetHealth':{'State':'healthy'}}]}
                if operation == 'update-service': mutated.append(args); return {}
                raise AssertionError(operation)
            with tempfile.TemporaryDirectory() as directory:
                Path(directory,'deployment').mkdir()
                for name in ('hotel-setup-caller-images.json','hotel-setup-property-images.json'):
                    Path(directory,'deployment',name).write_text(json.dumps({DIGEST:'a'*40}))
                argv=['release','--service','property','--purpose','property','--state','start','--image-digest',DIGEST,'--expected-public-task',public_task,'--private-task',private_task]
                with patch.object(release,'ROOT',Path(directory)), patch.object(release,'aws',side_effect=mocked_aws), patch.object(release.subprocess,'run'), patch('sys.argv',argv), patch.dict(release.os.environ,{'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/main'}):
                    if wrong_role:
                        with self.assertRaises(RuntimeError): release.main()
                        self.assertEqual(mutated,[])
                    else:
                        release.main()
                        self.assertEqual(len(mutated),1)
                        self.assertIn(private_task,mutated[0])

    def test_unhealthy_target_blocks_release_confirmation(self):
        state = {'loadBalancers':[{'targetGroupArn':'synthetic-target-group'}]}
        with patch.object(release,'aws',return_value={'TargetHealthDescriptions':[{'TargetHealth':{'State':'unhealthy'}}]}):
            with self.assertRaises(RuntimeError): release.healthy(state)

    def run_private_stop(self, purpose='property', denial=None):
        public_task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/public:1'
        marker = 'property-' if purpose == 'property' else ''
        family = 'vayada-hotel-setup-' + marker + 'primary'
        private_task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/' + family + ':1'
        public = copy.deepcopy(self.task)
        public['containerDefinitions'][0]['image'] = release.REPOSITORY + '@' + DIGEST
        public['containerDefinitions'][0]['environment'] += [
            {'name': prefix + '_ADMISSION', 'value': 'blocked' if key in (purpose, 'logo', 'profile') else 'enabled'}
            for key, prefix in release.PREFIX.items() if not (key == 'profile' and denial == 'profile_absent')]
        prefix = 'hotel-setup-command/prod/' if purpose == 'property' else 'hotel-setup-creation/prod/'
        public = release.prepare_public(public, purpose, 'enabled', DIGEST,
            'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + prefix + 'internal-token-AbCd12')
        public = release.prepare_public(public, purpose, 'blocked', DIGEST)
        definition = {'family':family,
            'executionRoleArn':'arn:aws:iam::269416271598:role/vayada-hotel-setup-' + marker + 'execution',
            'taskRoleArn':'arn:aws:iam::269416271598:role/vayada-hotel-setup-' + marker + 'task',
            'containerDefinitions':[{'name':'hotel-setup','image':release.REPOSITORY+'@'+DIGEST,
            'readonlyRootFilesystem':True,'privileged':False,
            'environment':[{'name':'HOTEL_SETUP_COMMAND_MODE','value':'property_commands' if purpose == 'property' else 'property_creation'},
                {'name':'HOTEL_SETUP_COMMAND_SECRET_PREFIX','value':'hotel-setup-command/prod/' + ('property/' if purpose == 'property' else 'organization/')}],
            'secrets':[{'name':'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN','valueFrom':'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + prefix + 'internal-token-AbCd12'},
                {'name':'HOTEL_SETUP_COMMAND_READER_DATABASE_URL','valueFrom':'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + prefix + 'reader-database-url-AbCd12'}]}]}
        item = definition['containerDefinitions'][0]
        caller = public['containerDefinitions'][0]
        selected_prefix = release.PREFIX[purpose]
        if denial == 'admission':
            next(entry for entry in caller['environment'] if entry['name'] == selected_prefix + '_ADMISSION')['value'] = 'enabled'
        if denial in ('profile_enabled', 'logo_enabled'):
            name = release.PREFIX[denial.split('_')[0]] + '_ADMISSION'
            next(entry for entry in caller['environment'] if entry['name'] == name)['value'] = 'enabled'
        if denial == 'profile_leftover_pair':
            caller['environment'] = [entry for entry in caller['environment'] if entry['name'] != 'HOTEL_SETUP_PROFILE_COMMAND_ADMISSION']
            caller['environment'].append({'name': 'HOTEL_SETUP_PROFILE_COMMAND_ORIGIN', 'value': release.ORIGIN['profile']})
            caller['secrets'].append({'name': 'HOTEL_SETUP_PROFILE_COMMAND_INTERNAL_TOKEN',
                'valueFrom': 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/internal-token-AbCd12'})
        if denial in ('hold','origin_missing'):
            caller['environment'] = [entry for entry in caller['environment'] if entry['name'] != selected_prefix + '_ORIGIN']
        if denial in ('hold','token_missing'):
            caller['secrets'] = [entry for entry in caller['secrets'] if entry['name'] != selected_prefix + '_INTERNAL_TOKEN']
        if denial == 'origin':
            next(entry for entry in caller['environment'] if entry['name'] == selected_prefix + '_ORIGIN')['value'] = release.ORIGIN['creation']
        if denial == 'token':
            next(entry for entry in caller['secrets'] if entry['name'] == selected_prefix + '_INTERNAL_TOKEN')['valueFrom'] = 'wrong-token'
        if denial == 'execution': public['executionRoleArn'] = 'broad-execution-role'
        if denial == 'role': definition['taskRoleArn'] = 'broad-role'
        if denial == 'image': item['image'] = release.REPOSITORY + '@sha256:' + 'b' * 64
        if denial == 'mode': item['environment'][0]['value'] = 'ordinary_api'
        if denial == 'namespace': item['secrets'][0]['valueFrom'] = 'ordinary-api-secret'
        if denial == 'native_prefix': item['environment'][1]['value'] = 'broad/native/'
        if denial == 'family': definition['family'] = 'ordinary-api'
        if denial == 'credentials': item['secrets'].append({'name':'OWNER_DATABASE_URL','valueFrom':'broad-secret'})
        serving = 'arn:aws:ecs:eu-west-1:269416271598:task/' + release.CLUSTER + '/' + 'a'*32
        old = serving[:-32] + 'b'*32
        replacement = serving[:-32] + 'c'*32
        physical = {'taskArn':serving,'taskDefinitionArn':private_task,
            'clusterArn':'arn:aws:ecs:eu-west-1:269416271598:cluster/' + release.CLUSTER,
            'group':'service:' + release.PRIVATE[purpose],'desiredStatus':'RUNNING','lastStatus':'RUNNING'}
        if denial == 'capture_definition': physical['taskDefinitionArn'] = private_task[:-1] + '2'
        if denial == 'capture_arn': physical['taskArn'] = old
        if denial == 'capture_cluster': physical['clusterArn'] = 'wrong-cluster'
        if denial == 'capture_service': physical['group'] = 'service:wrong-private-service'
        if denial == 'capture_status': physical['lastStatus'] = 'DEACTIVATING'
        mutated, reads = [], {release.PUBLIC:0, release.PRIVATE[purpose]:0}
        def mocked_aws(*args):
            operation = args[1]
            if operation == 'describe-services':
                name = args[args.index('--services')+1]
                reads[name] += 1
                is_public = name == release.PUBLIC
                task = public_task if is_public else private_task
                if (denial == 'public_changed' and is_public and reads[name] == 2 or
                        denial == 'private_changed' and not is_public and reads[name] == 2):
                    task = task[:-1] + '2'
                if denial == 'task_arn' and not is_public: task = 'unreviewed-task'
                count = 1 if is_public or not mutated or denial == 'final_running' else 0
                pending = int(denial == 'pending' and not is_public)
                return {'services':[{'taskDefinition':task,'desiredCount':count,'runningCount':count,
                    'pendingCount':pending,'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED'}]}]}
            if operation == 'describe-task-definition':
                return {'taskDefinition':public if args[-1] == public_task else definition}
            if operation == 'list-tasks':
                if args[-1] == 'STOPPED':
                    return {'taskArns':[replacement] if mutated and denial in ('replacement_draining','history_missing') else [old]}
                if mutated: return {'taskArns':[replacement] if denial == 'replacement_running' else []}
                return {'taskArns':[] if denial == 'capture_empty' else [serving]}
            if operation == 'describe-tasks':
                if args[-1] == replacement:
                    return {'tasks':[],'failures':[{'arn':replacement,'reason':'MISSING'}]} if denial == 'history_missing' else {'tasks':[{'taskArn':replacement,'lastStatus':'DEACTIVATING'}]}
                if args[-1] == old:
                    return {'tasks':[{'taskArn':old,'lastStatus':'DEACTIVATING' if denial == 'draining' else 'STOPPED'}]}
                if denial == 'capture_missing' or mutated and denial == 'stopped_missing':
                    return {'tasks':[], 'failures':[{'arn':serving,'reason':'MISSING'}]}
                task = copy.deepcopy(physical)
                if mutated: task['lastStatus'] = 'DEACTIVATING' if denial == 'final_draining' else 'STOPPED'
                return {'tasks':[task]}
            if operation == 'update-service': mutated.append(args); return {}
            raise AssertionError(operation)
        def mocked_wait(*args, **kwargs):
            if denial == 'wait_failure' and 'tasks-stopped' in args[0]:
                raise subprocess.CalledProcessError(255, args[0])
        argv = ['release','--service','public' if denial == 'public_stop' else purpose,
            '--purpose','creation' if denial == 'wrong_purpose' else purpose,'--state','stop',
            '--image-digest','sha256:' + 'b'*64 if denial == 'unapproved' else DIGEST,
            '--expected-public-task',public_task]
        if denial == 'task_input': argv += ['--private-task', private_task]
        before = copy.deepcopy((public, definition))
        with tempfile.TemporaryDirectory() as directory:
            Path(directory,'deployment').mkdir()
            for name in ('hotel-setup-caller-images.json','hotel-setup-property-images.json','hotel-setup-command-images.json'):
                Path(directory,'deployment',name).write_text(json.dumps({DIGEST:'a'*40}))
            with patch.object(release,'ROOT',Path(directory)), patch.object(release,'aws',side_effect=mocked_aws), patch.object(release.subprocess,'run',side_effect=mocked_wait) as wait, patch('sys.argv',argv), patch.dict(release.os.environ,{'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/main'}):
                if denial and denial != 'profile_absent' and not (denial == 'profile_enabled' and purpose == 'creation'):
                    with self.assertRaises((RuntimeError, subprocess.CalledProcessError)): release.main()
                    self.assertEqual(len(mutated), int(denial in ('final_running','wait_failure','final_draining',
                        'stopped_missing','replacement_draining','replacement_running','history_missing')))
                else:
                    release.main()
                    self.assertEqual(mutated, [('ecs','update-service','--cluster',release.CLUSTER,
                        '--service',release.PRIVATE[purpose],'--desired-count','0')])
                    self.assertEqual(wait.call_args_list, [
                        unittest.mock.call(['aws','ecs','wait','services-stable','--cluster',
                            release.CLUSTER,'--services',release.PRIVATE[purpose],'--region',release.REGION], check=True),
                        unittest.mock.call(['aws','ecs','wait','tasks-stopped','--cluster',
                            release.CLUSTER,'--tasks',serving,'--region',release.REGION], check=True)])
        self.assertEqual((public, definition), before)

    def test_private_stop_retains_each_serving_task_and_only_sets_zero_count(self):
        for purpose in ('creation', 'property'):
            with self.subTest(purpose=purpose): self.run_private_stop(purpose)

    def test_private_stop_rejects_unsafe_configuration_or_state_before_mutation(self):
        for denial in ('public_stop','wrong_purpose','task_input','unapproved','admission','pending',
                       'task_arn','role','image','mode','namespace','native_prefix','family',
                       'credentials','public_changed','private_changed'):
            with self.subTest(denial=denial): self.run_private_stop(denial=denial)

    def test_property_stop_requires_actor_callers_blocked_and_accepts_unreleased_profile(self):
        self.run_private_stop('property', denial='profile_absent')
        for denial in ('profile_enabled', 'logo_enabled', 'profile_leftover_pair'):
            with self.subTest(denial=denial): self.run_private_stop('property', denial=denial)
        self.run_private_stop('creation', denial='profile_enabled')  # Creation does not use the property service.

    def test_private_stop_requires_retained_public_pair_and_execution_identity(self):
        for denial in ('hold','origin_missing','token_missing','origin','token','execution'):
            with self.subTest(denial=denial): self.run_private_stop(denial=denial)

    def test_private_stop_requires_exact_serving_task_and_no_already_draining_task(self):
        for denial in ('capture_empty','capture_missing','capture_definition','capture_arn',
                       'capture_cluster','capture_service','capture_status','draining'):
            with self.subTest(denial=denial): self.run_private_stop(denial=denial)

    def test_private_stop_requires_physical_stop_confirmation_after_zero_count(self):
        for denial in ('wait_failure','final_draining','stopped_missing','replacement_draining',
                       'replacement_running','history_missing'):
            with self.subTest(denial=denial): self.run_private_stop(denial=denial)

    def test_private_stop_refuses_confirmation_while_a_task_remains_running(self):
        self.run_private_stop(denial='final_running')

    def run_failed_start_stop(self, denial=None, history_count=0):
        public_task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1197'
        family = 'vayada-hotel-setup-property-primary'
        target = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/' + family + ':3'
        old = target[:-1] + '5'  # Circuit breaker has returned to the approved older revision.
        old_digest = 'sha256:' + 'b' * 64
        private_digest = 'sha256:' + 'c' * 64
        public = copy.deepcopy(self.task)
        public['containerDefinitions'][0]['image'] = release.REPOSITORY + '@' + DIGEST
        public['containerDefinitions'][0]['environment'] += [
            {'name': prefix + '_ADMISSION', 'value': 'enabled' if denial == 'unblocked_' + purpose else 'blocked'}
            for purpose, prefix in release.PREFIX.items() if not (purpose == 'profile' and denial in ('profile_absent', 'profile_leftover_pair'))
            and not (purpose == 'logo' and denial == 'logo_absent')]
        if denial == 'profile_leftover_pair':
            public['containerDefinitions'][0]['environment'].append({'name': 'HOTEL_SETUP_PROFILE_COMMAND_ORIGIN', 'value': release.ORIGIN['profile']})
        definition = {'taskDefinitionArn':target, 'family':family,
            'executionRoleArn':'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-execution',
            'taskRoleArn':'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-task',
            'containerDefinitions':[{'name':'hotel-setup','image':release.REPOSITORY+'@'+private_digest,
                'readonlyRootFilesystem':True,'privileged':False,
                'environment':[{'name':'HOTEL_SETUP_COMMAND_MODE','value':'property_commands'},
                    {'name':'HOTEL_SETUP_COMMAND_SECRET_PREFIX','value':'hotel-setup-command/prod/property/'}],
                'secrets':[{'name':'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN','valueFrom':TOKEN},
                    {'name':'HOTEL_SETUP_COMMAND_READER_DATABASE_URL','valueFrom':TOKEN.replace('internal-token','reader-database-url')}]}]}
        hold = {'schemaVersion':1,'status':'active','service':'next-target-backend',
            'physicalIdentity':{'accountId':'269416271598','region':release.REGION,'cluster':release.CLUSTER,'ecsService':release.PUBLIC},
            'reason':'failed property start inspection','operationId':'control-123','manifestId':None,
            'capturedTaskDefinitionArn':public_task,'capturedImage':release.REPOSITORY+'@'+DIGEST,
            'dependentFrontendsCompatible':False,'createdAt':'2026-10-06T09:00:00.000Z'}
        prefix = 'arn:aws:ecs:eu-west-1:269416271598:task/' + release.CLUSTER + '/'
        live, failed, historical, replacement = (prefix + c * 32 for c in 'abcd')
        history = [prefix + f'{int("e" * 32, 16) + index:032x}' for index in range(history_count)]
        described, wait_clock = [], {'elapsed': 0}
        writes, reads = [], {'public':0,'private':0,'health':0,'hold':0,'physical':0}
        def mocked_aws(*args, **kwargs):
            operation = args[1]
            if operation == 'describe-services':
                is_public = args[-1] == release.PUBLIC
                key = 'public' if is_public else 'private'; reads[key] += 1
                task = public_task if is_public else target
                if denial == key + '_changed' and reads[key] > 2: task = old
                if is_public:
                    return {'services':[{'taskDefinition':task,'desiredCount':1,'runningCount':1,'pendingCount':0,
                        'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED'}]}]}
                stable = denial == 'stable'
                counts = [0, int(denial == 'final_running'), 0] if writes else [1, int(stable), int(not stable)]
                return {'services':[{'taskDefinition':task,'desiredCount':counts[0],'runningCount':counts[1],'pendingCount':counts[2],
                    'loadBalancers':[{'targetGroupArn':'property-target'}], 'deployments':[
                        {'status':'PRIMARY','rolloutState':'COMPLETED' if stable else 'IN_PROGRESS','taskDefinition':target,
                            'desiredCount':counts[0],'runningCount':counts[1],'pendingCount':counts[2]},
                        {'status':'ACTIVE','rolloutState':'COMPLETED','taskDefinition':old,
                            'desiredCount':0,'runningCount':int(denial == 'mixed_deployment'),'pendingCount':0}]}]}
            if operation == 'describe-task-definition':
                if args[-1] == public_task: return {'taskDefinition':public}
                value = copy.deepcopy(definition); value['taskDefinitionArn'] = args[-1]
                if args[-1] == old: value['containerDefinitions'][0]['image'] = release.REPOSITORY+'@'+old_digest
                if denial == 'role': value['taskRoleArn'] = 'broad-role'
                if denial == 'definition': value['taskDefinitionArn'] = old
                return {'taskDefinition':value}
            if operation == 'get-parameter':
                reads['hold'] += 1; value = copy.deepcopy(hold)
                if denial == 'hold_image': value['capturedImage'] = release.REPOSITORY+'@'+old_digest
                if denial == 'hold_changed' and reads['hold'] > 1: value['operationId'] = 'control-456'
                return {'Parameter':{'Value':json.dumps(value)}}
            if operation == 'describe-target-health':
                reads['health'] += 1
                healthy = denial == 'healthy' or denial == 'became_healthy' and reads['health'] > 1
                return {'TargetHealthDescriptions':[{'TargetHealth':{'State':'healthy' if healthy else 'unhealthy'}}]}
            if operation == 'list-tasks':
                return {'taskArns': ([] if writes else [live]) if args[-1] == 'RUNNING' else
                        [failed,historical] + history + ([live] if writes else []) + ([replacement] if writes and denial == 'replacement_draining' else [])}
            if operation == 'describe-tasks':
                reads['physical'] += 1
                batch = args[args.index('--tasks')+1:]
                self.assertLessEqual(len(batch), 100)
                described.append(set(batch))
                if denial == 'missing' or denial == 'stopped_missing' and writes or denial == 'late_missing' and history[-1] in batch:
                    return {'tasks':[],'failures':[{'reason':'MISSING'}]}
                tasks = []
                for arn in batch:
                    state = 'PROVISIONING' if arn == live and not writes else 'STOPPED'
                    desired = 'RUNNING' if state == 'PROVISIONING' else 'STOPPED'
                    if arn == historical and (denial in ('mixed_live','mixed_draining') or
                            denial == 'physical_changed' and reads['physical'] > 1):
                        state = 'RUNNING' if denial == 'mixed_live' else 'DEACTIVATING'
                        desired = 'RUNNING' if denial == 'mixed_live' else 'STOPPED'
                    if writes and (denial == 'final_draining' and arn == live or arn == replacement): state = 'DEACTIVATING'
                    if writes and denial == 'late_draining' and arn == history[-1]: state = 'DEACTIVATING'
                    if denial == 'unknown_status' and arn == live: state = 'UNKNOWN'
                    tasks.append({'taskArn':arn,'taskDefinitionArn':old if arn == historical else target,
                        'clusterArn':'arn:aws:ecs:eu-west-1:269416271598:cluster/'+release.CLUSTER,
                        'group':'service:'+release.PRIVATE['property'],'desiredStatus':desired,'lastStatus':state,
                        'containers':[{'name':'hotel-setup','exitCode':0 if denial == 'no_failure' else 1}]})
                    if denial == 'late_foreign' and arn == history[-1]: tasks[-1]['group'] = 'service:other'
                if denial == 'late_incomplete' and history[-1] in batch: tasks.pop()
                return {'tasks':tasks}
            if operation == 'update-service':
                writes.append((args,kwargs))
                if denial == 'unknown_mutation': raise subprocess.TimeoutExpired('aws',60)
                return {}
            raise AssertionError(operation)
        def mocked_wait(*args, **kwargs):
            if denial == 'wait_timeout': raise subprocess.TimeoutExpired('aws',300)
            if args[0][3] == 'tasks-stopped':
                self.assertLessEqual(args[0].index('--region') - args[0].index('--tasks') - 1, 100)
                wait_clock['elapsed'] += 300 if denial == 'wait_deadline' else 1
        argv = ['release','--service','creation' if denial == 'wrong_service' else 'property','--purpose','property',
                '--state','stop_failed_start','--image-digest',private_digest,'--expected-public-task',public_task,'--private-task',target]
        with tempfile.TemporaryDirectory() as directory:
            Path(directory,'deployment').mkdir()
            for name in ('hotel-setup-caller-images.json','hotel-setup-property-images.json'):
                Path(directory,'deployment',name).write_text(json.dumps({DIGEST:'a'*40, private_digest:'c'*40,
                    **({} if denial == 'unapproved_history' else {old_digest:'b'*40})}))
            with patch.object(release,'ROOT',Path(directory)), patch.object(release,'aws',side_effect=mocked_aws), \
                    patch.object(release.subprocess,'run',side_effect=mocked_wait) as wait, patch('sys.argv',argv), \
                    patch.object(release.time,'monotonic',side_effect=lambda: wait_clock['elapsed']), \
                    patch.dict(release.os.environ,{'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/main'}):
                if denial and denial != 'profile_absent':
                    with self.assertRaises((RuntimeError,subprocess.SubprocessError)): release.main()
                    self.assertEqual(len(writes), int(denial in ('unknown_mutation','wait_timeout','final_running',
                        'final_draining','replacement_draining','stopped_missing','late_draining','wait_deadline')))
                    if denial == 'wait_deadline': self.assertEqual(len(wait.call_args_list), 2)
                else:
                    release.main()
                    self.assertEqual(writes, [(('ecs','update-service','--cluster',release.CLUSTER,'--service',
                        release.PRIVATE['property'],'--desired-count','0'),{'single_attempt':True})])
                    expected = {live,failed,historical,*history}
                    batch_count = (len(expected) + 99) // 100
                    self.assertEqual(len(described), 4 * batch_count)
                    for offset in range(0, len(described), batch_count):
                        self.assertEqual(set().union(*described[offset:offset + batch_count]), expected)
                    self.assertEqual(len(wait.call_args_list), 1 + batch_count)
                    self.assertEqual(wait.call_args_list[0].kwargs, {'check':True,'timeout':300})
                    waited = set()
                    for index, call in enumerate(wait.call_args_list[1:]):
                        self.assertEqual(call.kwargs, {'check':True,'timeout':300 - index})
                        command = call.args[0]
                        waited.update(command[command.index('--tasks') + 1:command.index('--region')])
                    self.assertEqual(waited, expected)

    def test_failed_start_stop_retains_reviewed_rollback_task_and_physically_stops_all_tasks(self):
        self.run_failed_start_stop()

    def test_failed_start_stop_accepts_only_an_unreleased_profile_caller_as_blocked(self):
        self.run_failed_start_stop('profile_absent')
        for denial in ('unblocked_profile', 'logo_absent', 'profile_leftover_pair'):
            with self.subTest(denial=denial): self.run_failed_start_stop(denial)

    def test_failed_start_stop_batches_all_201_tasks_for_inspection_and_waits(self):
        self.run_failed_start_stop(history_count=198)

    def test_failed_start_stop_refuses_incomplete_foreign_or_draining_later_batches(self):
        for denial in ('late_missing','late_incomplete','late_foreign','late_draining'):
            with self.subTest(denial=denial): self.run_failed_start_stop(denial, history_count=198)

    def test_failed_start_stop_preserves_total_task_wait_deadline_across_batches(self):
        self.run_failed_start_stop('wait_deadline', history_count=198)

    def test_failed_start_stop_refuses_healthy_changed_unheld_or_mixed_attempts(self):
        for denial in ('wrong_service','stable','healthy','became_healthy','public_changed','private_changed',
                'unblocked_creation','unblocked_property','unblocked_logo','hold_image','hold_changed','role','definition',
                'mixed_deployment','mixed_live','mixed_draining','physical_changed','missing','unknown_status','no_failure','unapproved_history'):
            with self.subTest(denial=denial): self.run_failed_start_stop(denial)

    def test_failed_start_stop_never_retries_unknown_mutation_or_confirms_uncertain_drain(self):
        for denial in ('unknown_mutation','wait_timeout','final_running','final_draining','replacement_draining','stopped_missing'):
            with self.subTest(denial=denial): self.run_failed_start_stop(denial)

    def test_failed_start_mutation_disables_sdk_retries_and_has_a_timeout(self):
        with patch.object(release.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='{}')) as run:
            release.aws('ecs','update-service',single_attempt=True)
            self.assertEqual(run.call_args.kwargs['env']['AWS_MAX_ATTEMPTS'], '1')
            self.assertEqual(run.call_args.kwargs['timeout'], 60)

    def test_secret_supplied_admission_cannot_bypass_blocked_environment(self):
        item = {'environment':[{'name':'HOTEL_SETUP_COMMAND_ADMISSION','value':'blocked'}],
                'secrets':[{'name':'HOTEL_SETUP_COMMAND_ADMISSION','valueFrom':'fixture'}]}
        with self.assertRaises(RuntimeError): release.environment(item)

    def test_checked_in_primary_is_admitted_for_public_and_both_private_releases(self):
        proof = json.loads((ROOT / 'deployment/hotel-setup-helper-owner-image-proof.json').read_text())
        primary = proof['primary']
        for name in ('hotel-setup-caller-images.json', 'hotel-setup-command-images.json',
                     'hotel-setup-property-images.json'):
            inventory = json.loads((ROOT / 'deployment' / name).read_text())
            self.assertEqual(inventory[primary['digest']], primary['source'])
            release.approved(primary['digest'], name)

    def test_empty_caller_inventory_blocks_unproved_images(self):
        with self.assertRaises(RuntimeError): release.approved(DIGEST, 'hotel-setup-caller-images.json')

    def test_initial_recovery_binds_hold_candidate_and_retained_task(self):
        old = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1'
        new = old[:-1] + '2'
        captured = copy.deepcopy(self.task)
        captured['taskDefinitionArn'] = old
        captured['containerDefinitions'][0]['image'] = release.REPOSITORY + '@sha256:' + 'b' * 64
        candidate = release.prepare_public(captured, 'creation', 'hold', DIGEST)
        public = {'taskDefinition': new, 'desiredCount': 1, 'deployments': [
            {'taskDefinition': old, 'runningCount': 1, 'rolloutState': 'COMPLETED'}]}
        hold = {'schemaVersion': 1, 'manifestId': None, 'dependentFrontendsCompatible': False,
            'createdAt': '2026-10-03T17:19:28.000Z', 'status': 'active', 'service': 'next-target-backend', 'operationId': 'setup-123',
            'reason': 'reviewed hotel setup caller release',
            'physicalIdentity': {'accountId': '269416271598', 'region': release.REGION,
                'cluster': release.CLUSTER, 'ecsService': release.PUBLIC},
            'capturedTaskDefinitionArn': old, 'capturedImage': captured['containerDefinitions'][0]['image']}
        self.assertEqual(release.initial_restore_target(public, new, DIGEST, hold, captured, candidate), old)
        for key, value in [('status', 'cleared'), ('operationId', 'unrelated-123'),
                           ('capturedTaskDefinitionArn', new), ('capturedImage', 'wrong-image'),
                           ('physicalIdentity', {'accountId': 'other-account'})]:
            with self.subTest(key=key), self.assertRaises((RuntimeError, SystemExit)):
                release.initial_restore_target(public, new, DIGEST, {**hold, key: value}, captured, candidate)
        for patch in ({'schemaVersion': 2}, {'createdAt': 'invalid'},
                      {'clearedAt': '2026-10-03T18:00:00.000Z'}, {'dependentFrontendsCompatible': 'false'}):
            with self.assertRaises(release.coordinated.ReleaseError):
                release.initial_restore_target(public, new, DIGEST, {**hold, **patch}, captured, candidate)
        for state in ({**public, 'taskDefinition': old}, {**public, 'desiredCount': 0},
                      {**public, 'deployments': []}):
            with self.assertRaises(RuntimeError):
                release.initial_restore_target(state, new, DIGEST, hold, captured, candidate)
        for definition in (captured, candidate):
            for pair in ('origin', 'token'):
                altered = copy.deepcopy(definition)
                item = altered['containerDefinitions'][0]
                if pair == 'origin':
                    item['environment'].append({'name': 'HOTEL_SETUP_COMMAND_ORIGIN', 'value': release.ORIGIN['property']})
                else:
                    item['secrets'].append({'name': 'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN', 'valueFrom': TOKEN})
                args = (altered, candidate) if definition is captured else (captured, altered)
                with self.assertRaises(RuntimeError):
                    release.initial_restore_target(public, new, DIGEST, hold, *args)


if __name__ == '__main__': unittest.main()
