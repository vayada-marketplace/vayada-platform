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
            {'name': prefix + '_ADMISSION', 'value': 'blocked' if key in (purpose, 'logo') else 'enabled'}
            for key, prefix in release.PREFIX.items()]
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
                if denial:
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
