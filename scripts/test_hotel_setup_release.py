"""Check release transitions preserve the serving task and refuse fallback."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import json
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

    def test_secret_supplied_admission_cannot_bypass_blocked_environment(self):
        item = {'environment':[{'name':'HOTEL_SETUP_COMMAND_ADMISSION','value':'blocked'}],
                'secrets':[{'name':'HOTEL_SETUP_COMMAND_ADMISSION','valueFrom':'fixture'}]}
        with self.assertRaises(RuntimeError): release.environment(item)

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
            with self.assertRaises(SystemExit):
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
