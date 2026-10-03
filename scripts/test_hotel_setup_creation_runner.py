#!/usr/bin/env python3
"""Exercise the real operational wrapper without contacting AWS."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DIGEST = 'sha256:' + 'a' * 64
ORG = '11111111-1111-4111-8111-111111111111'
ACTOR = '22222222-2222-4222-8222-222222222222'
MOCK = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
root=Path(os.environ['MOCK_CAPTURE'])
with (root/'calls.jsonl').open('a') as file: file.write(json.dumps(args)+'\\n')
def value(flag): return args[args.index(flag)+1]
operation=args[1]
if operation=='describe-services' and value('--query')=='services[0]':
 print(json.dumps({'taskDefinition':os.environ['EXPECTED_TASK'],'desiredCount':1,'runningCount':1,'pendingCount':0,'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED'}]}))
elif operation=='describe-services' and value('--services')=='vayada-hotel-setup-property-service':
 print(json.dumps({'services':[{'desiredCount':0,'runningCount':0,'pendingCount':0}], 'failures':[]}))
elif operation=='describe-services':
 print(json.dumps({'awsvpcConfiguration':{'subnets':['fixture'],'securityGroups':['fixture'],'assignPublicIp':'ENABLED'}}) if 'networkConfiguration' in value('--query') else 'arn:aws:ecs:eu-west-1:269416271598:task-definition/public:1')
elif operation=='describe-task-definition':
 print(json.dumps({'family':'public','taskRoleArn':'arn:aws:iam::269416271598:role/broad-serving-role','executionRoleArn':'fixture-execution','containerDefinitions':[{'name':'vayada-next-api','image':os.environ.get('MOCK_PUBLIC_IMAGE','ordinary-serving-image'),'environment':[{'name':'HOTEL_SETUP_COMMAND_ADMISSION','value':os.environ.get('MOCK_ADMISSION','blocked')}],'secrets':[{'name':'UNSAFE','valueFrom':'fixture'}],'portMappings':[{'containerPort':8003}]}]}))
elif operation=='register-task-definition':
 (root/'definition.json').write_text(value('--cli-input-json'))
 print('arn:aws:ecs:eu-west-1:269416271598:task-definition/fixture:1')
elif operation=='run-task':
 (root/'overrides.json').write_text(value('--overrides'))
 print('arn:aws:ecs:eu-west-1:269416271598:task/fixture/123')
elif operation=='describe-tasks': print('STOPPED' if value('--query')=='tasks[0].lastStatus' else json.dumps({'exitCode':0,'reason':'fixture'}))
elif operation=='get-log-events': print(json.dumps(['{"status":"PASS"}']))
elif operation in ('stop-task','deregister-task-definition'): print('{}')
else: sys.exit('Unexpected AWS operation: '+operation)
'''


class CreationRunnerTest(unittest.TestCase):
    def test_native_launcher_rejects_unreviewed_database_destination(self):
        valid = 'postgresql://vayada_admin:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require'
        for url in (valid.replace('vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com', 'unreviewed.invalid'),
                    valid.replace(':5432/', ':5433/'), valid + '#fragment',
                    valid.replace('vayada_admin:', 'other:')):
            result = subprocess.run(['node', str(ROOT / 'scripts/run-hotel-setup-property-bootstrap.mjs')],
                                    env={**os.environ, 'VAYADA_DB_RDS_CA_BUNDLE': 'synthetic-ca',
                                         'HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL': url},
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Unexpected production owner URL shape', result.stderr)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ('scripts', 'deployment', 'bin', 'capture'):
            (self.root / directory).mkdir()
        for name in ('run-target-database-runtime-preflight.sh', 'provision-hotel-setup-creation-login.mjs', 'run-hotel-setup-property-bootstrap.mjs'):
            shutil.copy(ROOT / 'scripts' / name, self.root / 'scripts' / name)
        (self.root / 'deployment/hotel-setup-command-images.json').write_text(json.dumps({DIGEST: 'b' * 40}))
        self.executable('aws', MOCK)
        # Stub only the download/checksum; Node still validates the real pinned certificate.
        self.executable('curl', '#!/bin/sh\ncat "$MOCK_CA"\n')
        self.executable('shasum', '#!/bin/sh\ncat >/dev/null\necho 0fdc44d91c5a69ef4efc3f9ede636ccc22b11a890c5a656a134275da26afa812\n')
        self.env = {**os.environ, 'PATH': str(self.root / 'bin') + ':' + os.environ['PATH'],
                    'MOCK_CAPTURE': str(self.root / 'capture'),
                    'EXPECTED_TASK': 'arn:aws:ecs:eu-west-1:269416271598:task-definition/public:1',
                    'MOCK_CA': str(ROOT / 'rehearsal/rds-ca-rsa2048-g1.pem')}

    def executable(self, name, content):
        path = self.root / 'bin' / name
        path.write_text(content)
        path.chmod(0o755)

    def run_wrapper(self, *args):
        return subprocess.run(['bash', str(self.root / 'scripts/run-target-database-runtime-preflight.sh'), *args],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def test_exact_task_credentials_and_bounded_overrides(self):
        for purpose, args, suffix in (
            ('organization', ['--provision-hotel-setup-creation-org', ORG, ACTOR, DIGEST], 'bootstrap'),
            ('creation_reader', ['--provision-hotel-setup-creation-reader', DIGEST], 'reader-bootstrap'),
            ('property_reader', ['--provision-hotel-setup-property-reader', DIGEST], 'reader-bootstrap'),
        ):
            with self.subTest(purpose=purpose):
                result = self.run_wrapper(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                definition = json.loads((self.root / 'capture/definition.json').read_text())
                service = 'property' if purpose == 'property_reader' else 'creation'
                self.assertEqual(definition['taskRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-' + service + '-' + suffix)
                container, = definition['containerDefinitions']
                self.assertEqual(container['image'], '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST)
                self.assertEqual(container['environment'], [])
                self.assertEqual(container['portMappings'], [])
                self.assertEqual(container['secrets'], [{'name': 'TARGET_DATABASE_ADMIN_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}])
                raw = (self.root / 'capture/overrides.json').read_text()
                self.assertLessEqual(len(raw.encode()), 8192)
                override, = json.loads(raw)['containerOverrides']
                env = {entry['name']: entry['value'] for entry in override['environment']}
                self.assertEqual(env['HOTEL_SETUP_BOOTSTRAP_PURPOSE'], purpose)
                if purpose == 'organization':
                    self.assertEqual(env['HOTEL_SETUP_COMMAND_ORGANIZATION_ID'], ORG)
                    self.assertEqual(env['HOTEL_SETUP_COMMAND_ACTOR_USER_ID'], ACTOR)
                else:
                    self.assertNotIn('HOTEL_SETUP_COMMAND_ORGANIZATION_ID', env)
                    self.assertNotIn('HOTEL_SETUP_COMMAND_ACTOR_USER_ID', env)
                operations = [json.loads(line)[1] for line in (self.root / 'capture/calls.jsonl').read_text().splitlines()]
                self.assertNotIn('update-service', operations)
                self.assertEqual(operations[-2:], ['stop-task', 'deregister-task-definition'])

    def test_native_property_runner_is_main_only_and_proved_before_mutations(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        MOCK_PUBLIC_IMAGE='269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST)
        (self.root / 'deployment/hotel-setup-caller-images.json').write_text(json.dumps({DIGEST: 'b' * 40}))
        inventory = self.root / 'deployment/hotel-setup-bootstrap-images.json'
        inventory.write_text('{}')
        args = ['--provision-hotel-setup-property-native', ORG, ORG, ACTOR, 'launch_settings', DIGEST]
        self.assertNotEqual(self.run_wrapper(*args).returncode, 0)
        self.assertFalse((self.root / 'capture/calls.jsonl').exists())
        inventory.write_text(json.dumps({DIGEST: {key: 'b' * 40 for key in ('primarySource', 'rollbackSource', 'publisherSource')}}))
        self.env['GITHUB_REF'] = 'refs/heads/unreviewed'
        self.assertNotEqual(self.run_wrapper(*args).returncode, 0)
        self.assertFalse((self.root / 'capture/calls.jsonl').exists())
        self.env['GITHUB_REF'] = 'refs/heads/main'
        result = self.run_wrapper(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        definition = json.loads((self.root / 'capture/definition.json').read_text())
        self.assertEqual(definition['taskRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap')
        item, = definition['containerDefinitions']
        self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}])
        raw = (self.root / 'capture/overrides.json').read_text()
        self.assertLessEqual(len(raw.encode()), 8192)
        env = {entry['name']: entry['value'] for entry in json.loads(raw)['containerOverrides'][0]['environment']}
        self.assertEqual(env['HOTEL_SETUP_COMMAND_PROPERTY_ID'], ORG)
        self.assertEqual(env['HOTEL_SETUP_COMMAND_OPERATION'], 'launch_settings')
        self.assertNotIn('HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL', env)
        operations = [json.loads(line)[1] for line in (self.root / 'capture/calls.jsonl').read_text().splitlines()]
        self.assertNotIn('update-service', operations)
        self.assertEqual(operations[-2:], ['stop-task', 'deregister-task-definition'])
        for overrides in ({'MOCK_ADMISSION': 'enabled'}, {'MOCK_PUBLIC_IMAGE': 'ordinary-serving-image'}):
            calls = self.root / 'capture/calls.jsonl'
            calls.unlink()
            previous = self.env.copy()
            self.env.update(overrides)
            self.assertNotEqual(self.run_wrapper(*args).returncode, 0)
            operations = [json.loads(line)[1] for line in calls.read_text().splitlines()]
            self.assertNotIn('register-task-definition', operations)
            self.assertNotIn('run-task', operations)
            self.env = previous

    def test_property_reader_requires_admission_hold_before_mutations(self):
        self.env['MOCK_ADMISSION'] = 'enabled'
        self.assertNotEqual(self.run_wrapper('--provision-hotel-setup-property-reader', DIGEST).returncode, 0)
        operations = [json.loads(line)[1] for line in (self.root / 'capture/calls.jsonl').read_text().splitlines()]
        self.assertNotIn('register-task-definition', operations)
        self.assertNotIn('run-task', operations)

    def test_invalid_and_unapproved_inputs_never_contact_aws(self):
        for args in (
            ['--provision-hotel-setup-creation-org', 'invalid', ACTOR, DIGEST],
            ['--provision-hotel-setup-creation-reader', 'latest'],
            ['--provision-hotel-setup-creation-reader', 'sha256:' + 'c' * 64],
            ['--provision-hotel-setup-creation-reader', DIGEST, ORG],
            ['--provision-hotel-setup-property-reader', 'latest'],
            ['--provision-hotel-setup-property-reader', 'sha256:' + 'c' * 64],
            ['--provision-hotel-setup-property-reader', DIGEST, ORG],
        ):
            self.assertNotEqual(self.run_wrapper(*args).returncode, 0)
            self.assertFalse((self.root / 'capture/calls.jsonl').exists())


if __name__ == '__main__':
    unittest.main()
