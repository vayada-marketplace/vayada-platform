#!/usr/bin/env python3
"""Exercise the real operational wrapper without contacting AWS."""
import base64
import gzip
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
if operation=='get-parameter':
 print(os.environ['MOCK_HOLD'])
elif operation=='describe-services' and value('--query')=='services[0]':
 print(json.dumps({'taskDefinition':os.environ.get('MOCK_PUBLIC_TASK',os.environ['EXPECTED_TASK']),'desiredCount':1,'runningCount':1,'pendingCount':0,'deployments':[{'status':'PRIMARY','rolloutState':'COMPLETED'}]*int(os.environ.get('MOCK_PUBLIC_DEPLOYMENTS','1'))}))
elif operation=='describe-services' and value('--services') in ('vayada-hotel-setup-property-service','vayada-hotel-setup-service'):
 print(json.dumps({'services':[{'desiredCount':0,'runningCount':1 if os.environ.get('MOCK_GATE_DRIFT') and (root/'overrides.json').exists() else int(os.environ.get('MOCK_CREATION_RUNNING' if value('--services')=='vayada-hotel-setup-service' else 'MOCK_PROPERTY_RUNNING','0')),'pendingCount':0}], 'failures':[]}))
elif operation=='describe-services':
 print(json.dumps({'awsvpcConfiguration':{'subnets':['fixture'],'securityGroups':['fixture'],'assignPublicIp':'ENABLED'}}) if 'networkConfiguration' in value('--query') else os.environ.get('MOCK_CURRENT_TASK','arn:aws:ecs:eu-west-1:269416271598:task-definition/public:1'))
elif operation=='describe-task-definition':
 print(json.dumps({'family':'public','taskRoleArn':'arn:aws:iam::269416271598:role/broad-serving-role','executionRoleArn':'fixture-execution','containerDefinitions':[{'name':'vayada-next-api','image':os.environ.get('MOCK_PUBLIC_IMAGE','ordinary-serving-image'),'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-group':'/ecs/vayada-next-api','awslogs-region':'eu-west-1','awslogs-stream-prefix':'ecs'}},'environment':[{'name':'HOTEL_SETUP_CREATION_COMMAND_ADMISSION','value':os.environ.get('MOCK_CREATION_ADMISSION','blocked')},{'name':'HOTEL_SETUP_COMMAND_ADMISSION','value':os.environ.get('MOCK_ADMISSION','blocked')},{'name':'HOTEL_SETUP_LOGO_COMMAND_ADMISSION','value':os.environ.get('MOCK_LOGO_ADMISSION','blocked')}],'secrets':[{'name':'UNSAFE','valueFrom':'fixture'}],'portMappings':[{'containerPort':8003}],**({'entryPoint':['unsafe'],'workingDirectory':'/unsafe','mountPoints':[{'sourceVolume':'code','containerPath':'/app'}],'volumesFrom':[{'sourceContainer':'unsafe'}],'environmentFiles':[{'type':'s3','value':'unsafe'}],'privileged':True} if os.environ.get('MOCK_STARTUP') else {})}]}))
elif operation=='register-task-definition':
 (root/'definition.json').write_text(value('--cli-input-json'))
 print('arn:aws:ecs:eu-west-1:269416271598:task-definition/fixture:1')
elif operation=='run-task':
 (root/'overrides.json').write_text(value('--overrides'))
 print('arn:aws:ecs:eu-west-1:269416271598:task/fixture/123')
elif operation=='list-tasks': print(json.dumps(['arn:aws:ecs:eu-west-1:269416271598:task/vayada-backend-cluster/'+'a'*32] if os.environ.get('MOCK_DRAINING') and value('--desired-status')=='STOPPED' else []))
elif operation=='describe-tasks' and '--query' not in args: print(json.dumps({'failures':[],'tasks':[{'group':'service:vayada-hotel-setup-property-service','desiredStatus':'STOPPED','lastStatus':'RUNNING'}]}))
elif operation=='describe-tasks': print('STOPPED' if value('--query')=='tasks[0].lastStatus' else json.dumps({'exitCode':int(os.environ.get('MOCK_EXIT_CODE','0')),'reason':'fixture'}))
elif operation=='get-log-events': print(json.dumps([os.environ.get('MOCK_RECEIPT','{"status":"PASS"}')]))
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

    def test_manual_child_preserves_owner_secret_and_uses_fixed_ca(self):
        script = r"""
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const env={VAYADA_DB_RDS_CA_BUNDLE:'synthetic-ca',
  HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL:'postgresql://vayada_admin:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require',
  HOTEL_SETUP_HELPER_OWNER_DATABASE_URL:'postgresql://vayada_target_prod_user:synthetic@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod?sslmode=require'};
let writes=0,spawns=0,exit;
const context=vm.createContext({URL,process:{env,execPath:'node',exit:value=>{exit=value;}}});
const fs=new vm.SyntheticModule(['writeFileSync'],function(){this.setExport('writeFileSync',(path,ca,options)=>{
  assert.equal(path,'/tmp/hotel-setup-rds.pem');assert.equal(ca,'synthetic-ca');assert.equal(options.mode,0o600);writes++;
});},{context});
const child=new vm.SyntheticModule(['spawnSync'],function(){this.setExport('spawnSync',(exe,args,options)=>{
  assert.equal(exe,'node');assert.equal(args[0],'/app/apps/api/dist/cli/hotelSetupPropertyBootstrap.js');
  assert.equal(options.env.NODE_EXTRA_CA_CERTS,'/tmp/hotel-setup-rds.pem');
  assert.equal(new URL(options.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL).search,'?sslmode=verify-full');
  assert.equal(new URL(options.env.HOTEL_SETUP_HELPER_OWNER_DATABASE_URL).pathname,'/vayada_target_prod');
  assert.equal(new URL(options.env.HOTEL_SETUP_HELPER_OWNER_DATABASE_URL).search,'?sslmode=require');
  spawns++;return {status:0};
});},{context});
const source=new vm.SourceTextModule(readFileSync(process.argv[1],'utf8'),{context,
  importModuleDynamically:async name=>{assert.equal(name,'node:child_process');await child.link(()=>{});await child.evaluate();return child;}});
await source.link(name=>{assert.equal(name,'node:fs');return fs;});await source.evaluate();
assert.equal(writes,1);assert.equal(spawns,1);assert.equal(exit,0);
"""
        result=subprocess.run(['node','--experimental-vm-modules','--input-type=module','-e',script,
            str(ROOT/'scripts/run-hotel-setup-property-bootstrap.mjs')],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ('scripts', 'deployment', 'bin', 'capture'):
            (self.root / directory).mkdir()
        for name in ('run-target-database-runtime-preflight.sh', 'provision-hotel-setup-creation-login.mjs', 'run-hotel-setup-property-bootstrap.mjs', 'run-hotel-setup-logo-cleanup.mjs', 'audit-hotel-setup-owner.mjs', 'audit-hotel-setup-migration.mjs', 'audit-hotel-setup-readiness-migrations.mjs', 'stage-hotel-setup-migration-scope.mjs', 'stage-hotel-setup-logo-migration-scope.mjs', 'hotel-setup-reader-rls-permissions.mjs', 'hotel-setup-reader-rls-native-preflight.mjs', 'hotel-setup-legacy-helper-inspection.mjs', 'hotel-setup-approved-legacy-helper-repair.mjs', 'hotel-setup-tenant-helper-repair.mjs', 'coordinated_release.py'):
            shutil.copy(ROOT / 'scripts' / name, self.root / 'scripts' / name)
        shutil.copy(ROOT / 'deployment/coordinated-release-v1.json', self.root / 'deployment/coordinated-release-v1.json')
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

    def test_existing_reader_repair_is_fixed_main_only_and_execution_injected(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                        EXPECTED_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186',
                        MOCK_CURRENT_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186')
        for mode, args in [('inspect', []), ('apply', ['b' * 64])]:
            result = self.run_wrapper('--inspect-hotel-setup-reader-rls' if mode == 'inspect' else
                                      '--repair-hotel-setup-reader-rls', *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            definition = json.loads((self.root / 'capture/definition.json').read_text())
            self.assertNotIn('taskRoleArn', definition)
            self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-next-api-setup-caller-execution')
            item, = definition['containerDefinitions']
            self.assertEqual(item['image'], '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@sha256:c2fbba1a4d3f8f7bc4c46d0816f125d3598cd1c1a4880dd3b103feb0d3aa67d2')
            self.assertEqual(item['secrets'], [{'name': 'TARGET_DATABASE_MIGRATION_URL', 'valueFrom': '/vayada/prod/target-database-url'}])
            raw = (self.root / 'capture/overrides.json').read_text()
            self.assertLessEqual(len(raw.encode()), 8192)
            env = {entry['name']: entry['value'] for entry in json.loads(raw)['containerOverrides'][0]['environment']}
            code = base64.b64decode(env['VAYADA_DB_RUNTIME_PREFLIGHT_CODE'])
            decoded = subprocess.run(['node', '-e', "process.stdout.write(require('node:zlib').brotliDecompressSync(require('node:fs').readFileSync(0)))"],
                                     input=code, capture_output=True, check=True).stdout
            self.assertEqual(decoded, (ROOT / 'scripts/hotel-setup-reader-rls-permissions.mjs').read_bytes())
            self.assertEqual(env['HOTEL_SETUP_READER_RLS_MODE'], mode)
            self.assertEqual(env.get('HOTEL_SETUP_READER_RLS_FROZEN'), None if mode == 'inspect' else 'b' * 64)
        for purpose, mode, suffix in [('creation', 'property_creation', 'creation/prod/reader-database-url-EDME10'),
                                      ('property', 'property_commands', 'command/prod/reader-database-url-WqoWDT')]:
            result = self.run_wrapper(f'--verify-hotel-setup-{purpose}-reader-rls')
            self.assertEqual(result.returncode, 0, result.stderr)
            definition = json.loads((self.root / 'capture/definition.json').read_text())
            self.assertNotIn('taskRoleArn', definition)
            item, = definition['containerDefinitions']
            self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_COMMAND_READER_DATABASE_URL',
                              'valueFrom': 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-' + suffix}])
            env = {entry['name']: entry['value'] for entry in json.loads((self.root / 'capture/overrides.json').read_text())['containerOverrides'][0]['environment']}
            expected_group = '/ecs/vayada-hotel-setup' + ('-property' if purpose == 'property' else '')
            self.assertEqual(item['logConfiguration']['options']['awslogs-group'], expected_group)
            self.assertEqual(item['logConfiguration']['logDriver'], 'awslogs')
            self.assertEqual(item['logConfiguration']['options']['awslogs-region'], 'eu-west-1')
            self.assertEqual(item['logConfiguration']['options']['awslogs-stream-prefix'], 'ecs')
            calls_for_mode = [json.loads(line) for line in (self.root / 'capture/calls.jsonl').read_text().splitlines()]
            log_call = next(call for call in reversed(calls_for_mode) if call[1] == 'get-log-events')
            self.assertEqual(log_call[log_call.index('--log-group-name') + 1], expected_group)
            self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup' + ('-property' if purpose == 'property' else '') + '-execution')
            self.assertEqual(env['HOTEL_SETUP_COMMAND_MODE'], mode)
            self.assertNotIn('TARGET_DATABASE_ADMIN_URL', env)
        calls = self.root / 'capture/calls.jsonl'
        for overrides in [{'GITHUB_REF': 'refs/heads/other'}, {'GITHUB_EVENT_NAME': 'push'}, {'GITHUB_REPOSITORY': 'other/repo'}]:
            calls.unlink(missing_ok=True)
            previous = self.env.copy()
            self.env.update(overrides)
            self.assertEqual(self.run_wrapper('--inspect-hotel-setup-reader-rls').returncode, 2)
            self.assertFalse(calls.exists())
            self.env = previous

    def test_approved_legacy_repair_is_fixed_owner_injected_and_frozen(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                        EXPECTED_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186',
                        MOCK_CURRENT_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186')
        for mode, args in [('inspect', []), ('apply', ['b' * 64])]:
            self.env['MOCK_RECEIPT'] = json.dumps({'status':'PASS','scope':'hotel_setup_approved_legacy_helper_repair','mode':mode})
            result = self.run_wrapper('--inspect-approved-hotel-setup-legacy-helpers' if mode == 'inspect' else '--repair-approved-hotel-setup-legacy-helpers', *args)
            self.assertEqual(result.returncode,0,result.stderr)
            definition = json.loads((self.root / 'capture/definition.json').read_text())
            self.assertEqual(definition['executionRoleArn'],'arn:aws:iam::269416271598:role/vayada-next-api-setup-caller-execution')
            self.assertEqual(definition['taskRoleArn'],'arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-bootstrap')
            item, = definition['containerDefinitions']
            self.assertEqual(item['secrets'],[{'name':'TARGET_DATABASE_MIGRATION_URL','valueFrom':'/vayada/prod/target-database-url'}])
            raw = (self.root / 'capture/overrides.json').read_text()
            self.assertLessEqual(len(raw.encode()),8192)
            env = {e['name']:e['value'] for e in json.loads(raw)['containerOverrides'][0]['environment']}
            self.assertEqual(env['HOTEL_SETUP_LEGACY_HELPER_MODE'],mode)
            self.assertEqual(env.get('HOTEL_SETUP_LEGACY_HELPER_FROZEN'),None if mode == 'inspect' else 'b' * 64)
            self.assertNotIn('HOTEL_SETUP_READER_RLS_MODE',env)
            env.update({e['name']:e['value'] for e in item['environment']})
            self.assertEqual({e['name'] for e in item['environment']},{'VAYADA_DB_RUNTIME_PREFLIGHT_CODE','VAYADA_DB_RDS_CA_BUNDLE_GZIP'})
            decoded = subprocess.run(['node','-e',"process.stdout.write(require('node:zlib').brotliDecompressSync(require('node:fs').readFileSync(0)))"],input=base64.b64decode(env['VAYADA_DB_RUNTIME_PREFLIGHT_CODE']),capture_output=True,check=True).stdout
            self.assertEqual(decoded,(ROOT / 'scripts/hotel-setup-approved-legacy-helper-repair.mjs').read_bytes())
        for status in ['UNCERTAIN','COMMITTED_UNVERIFIED']:
            self.env.update(MOCK_EXIT_CODE='2',MOCK_RECEIPT=json.dumps({'status':status,'scope':'hotel_setup_approved_legacy_helper_repair','catalog':'exact_granted','secret':'DO_NOT_RELAY'}))
            result = self.run_wrapper('--repair-approved-hotel-setup-legacy-helpers','b' * 64)
            self.assertEqual(result.returncode,2)
            self.assertEqual(json.loads(result.stderr)['status'],status)
            if status == 'UNCERTAIN': self.assertNotIn('committed',json.loads(result.stderr))
            else: self.assertIs(json.loads(result.stderr)['committed'],True)
            self.assertNotIn('DO_NOT_RELAY',result.stderr)
        self.assertEqual(self.run_wrapper('--repair-approved-hotel-setup-legacy-helpers').returncode,2)
        self.assertEqual(self.run_wrapper('--repair-approved-hotel-setup-legacy-helpers','bad').returncode,2)
        self.env['GITHUB_REF']='refs/heads/unreviewed'
        self.assertEqual(self.run_wrapper('--inspect-approved-hotel-setup-legacy-helpers').returncode,2)

    def test_tenant_helper_repair_is_fixed_owner_injected_and_frozen(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                        EXPECTED_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1192',
                        MOCK_CURRENT_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1192')
        for mode, args in [('inspect', []), ('apply', ['b' * 64])]:
            self.env['MOCK_RECEIPT'] = json.dumps({'status':'PASS','scope':'hotel_setup_tenant_helpers','mode':mode})
            result = self.run_wrapper('--inspect-hotel-setup-tenant-helpers' if mode == 'inspect' else '--repair-hotel-setup-tenant-helpers', *args)
            self.assertEqual(result.returncode,0,result.stderr)
            definition = json.loads((self.root / 'capture/definition.json').read_text())
            self.assertEqual(definition['executionRoleArn'],'arn:aws:iam::269416271598:role/vayada-next-api-setup-caller-execution')
            self.assertEqual(definition['taskRoleArn'],'arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-bootstrap')
            item, = definition['containerDefinitions']
            self.assertEqual(item['secrets'],[{'name':'TARGET_DATABASE_MIGRATION_URL','valueFrom':'/vayada/prod/target-database-url'}])
            raw = (self.root / 'capture/overrides.json').read_text()
            self.assertLessEqual(len(raw.encode()),8192)
            env = {e['name']:e['value'] for e in json.loads(raw)['containerOverrides'][0]['environment']}
            self.assertEqual(env['HOTEL_SETUP_LEGACY_HELPER_MODE'],mode)
            self.assertEqual(env.get('HOTEL_SETUP_LEGACY_HELPER_FROZEN'),None if mode == 'inspect' else 'b' * 64)
            self.assertNotIn('HOTEL_SETUP_READER_RLS_MODE',env)
            env.update({e['name']:e['value'] for e in item['environment']})
            self.assertEqual({e['name'] for e in item['environment']},{'VAYADA_DB_RUNTIME_PREFLIGHT_CODE','VAYADA_DB_RDS_CA_BUNDLE_GZIP'})
            decoded = subprocess.run(['node','-e',"process.stdout.write(require('node:zlib').brotliDecompressSync(require('node:fs').readFileSync(0)))"],input=base64.b64decode(env['VAYADA_DB_RUNTIME_PREFLIGHT_CODE']),capture_output=True,check=True).stdout
            self.assertEqual(decoded,(ROOT / 'scripts/hotel-setup-tenant-helper-repair.mjs').read_bytes())
        for status in ['UNCERTAIN','COMMITTED_UNVERIFIED']:
            self.env.update(MOCK_EXIT_CODE='2',MOCK_RECEIPT=json.dumps({'status':status,'scope':'hotel_setup_tenant_helpers','catalog':'exact_granted','secret':'DO_NOT_RELAY'}))
            result = self.run_wrapper('--repair-hotel-setup-tenant-helpers','b' * 64)
            self.assertEqual(result.returncode,2)
            self.assertEqual(json.loads(result.stderr)['status'],status)
            if status == 'UNCERTAIN': self.assertNotIn('committed',json.loads(result.stderr))
            else: self.assertIs(json.loads(result.stderr)['committed'],True)
            self.assertNotIn('DO_NOT_RELAY',result.stderr)
        self.assertEqual(self.run_wrapper('--repair-hotel-setup-tenant-helpers').returncode,2)
        self.assertEqual(self.run_wrapper('--repair-hotel-setup-tenant-helpers','bad').returncode,2)
        self.env['GITHUB_REF']='refs/heads/unreviewed'
        self.assertEqual(self.run_wrapper('--inspect-hotel-setup-tenant-helpers').returncode,2)

    def test_generated_eval_executes_reader_repair_entrypoint(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                        EXPECTED_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186',
                        MOCK_CURRENT_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186')
        result = self.run_wrapper('--inspect-hotel-setup-reader-rls')
        self.assertEqual(result.returncode, 0, result.stderr)
        override, = json.loads((self.root / 'capture/overrides.json').read_text())['containerOverrides']
        command = override['command']
        self.assertEqual(command[:2], ['node', '--eval'])
        # Use the actual generated eval and compressed real module; only relocate its owned file.
        command[2] = command[2].replace("p='/app/.vayada-db-runtime-preflight.mjs'",
                                        'p=' + json.dumps(str((self.root / 'injected-preflight.mjs').resolve())))
        env = {'PATH': os.environ['PATH'], **{entry['name']: entry['value'] for entry in override['environment']}}
        env['TARGET_DATABASE_MIGRATION_URL'] = 'invalid-destination'
        actual = subprocess.run(command, env=env, cwd=self.root, capture_output=True, text=True, timeout=20)
        self.assertEqual(actual.returncode, 1, actual.stdout + actual.stderr)
        self.assertEqual(actual.stdout, '')
        report = json.loads(actual.stderr)
        self.assertEqual(report['code'], 'hotel_setup_reader_rls_permission_unavailable')
        self.assertEqual(report['scope'], 'hotel_setup_reader_rls_permissions')
        self.assertEqual(report['mode'], 'inspect')
        self.assertEqual(report['diagnostic']['predicate'], 'urlParsed')
        self.assertFalse(report['diagnostic']['checks']['urlParsed'])
        self.assertFalse(report['diagnostic']['checks']['passwordPresent'])
        self.assertNotIn('invalid-destination', actual.stderr)
        env['HOTEL_SETUP_READER_RLS_MODE'] = 'apply'
        apply = subprocess.run(command, env=env, cwd=self.root, capture_output=True, text=True, timeout=20)
        self.assertEqual(apply.returncode, 1)
        self.assertEqual(json.loads(apply.stderr), {'status': 'FAIL', 'code': report['code']})
        # Other operational modes retain eval's original argv; their entrypoint ABI is unchanged.
        env.pop('HOTEL_SETUP_READER_RLS_MODE')
        unrelated = subprocess.run(command, env=env, cwd=self.root, capture_output=True, text=True, timeout=20)
        self.assertEqual((unrelated.returncode, unrelated.stdout, unrelated.stderr), (0, '', ''))

    def legacy_environment(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                        EXPECTED_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186',
                        MOCK_CURRENT_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186')

    def test_legacy_inspection_is_fixed_and_cannot_supply_other_scope(self):
        self.legacy_environment()
        self.env['MOCK_STARTUP'] = 'true'
        for mode, args in [('inspect', []), ('verify', ['b' * 64])]:
            receipt = {'status': 'PASS', 'scope': 'hotel_setup_legacy_helper_inspection', 'mode': mode}
            self.env['MOCK_RECEIPT'] = json.dumps(receipt)
            result = self.run_wrapper('--' + mode + '-hotel-setup-legacy-helpers', *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), receipt)
            definition = json.loads((self.root / 'capture/definition.json').read_text())
            self.assertEqual(definition['family'], 'vayada-next-api-db-runtime-preflight')
            self.assertEqual(definition['taskRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-creation-bootstrap')
            self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution')
            item, = definition['containerDefinitions']
            self.assertEqual(item['image'], '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@sha256:c2fbba1a4d3f8f7bc4c46d0816f125d3598cd1c1a4880dd3b103feb0d3aa67d2')
            self.assertEqual(item['secrets'], [{'name': 'TARGET_DATABASE_ADMIN_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}])
            self.assertEqual(item['environment'], [])
            self.assertEqual(item['portMappings'], [])
            self.assertEqual(item['workingDirectory'], '/app')
            self.assertFalse(item['privileged'])
            for key in ('entryPoint', 'mountPoints', 'volumesFrom', 'environmentFiles'):
                self.assertNotIn(key, item)
            self.assertNotIn('volumes', definition)
            raw = (self.root / 'capture/overrides.json').read_text()
            self.assertLessEqual(len(raw.encode()), 8192)
            override, = json.loads(raw)['containerOverrides']
            env = {entry['name']: entry['value'] for entry in override['environment']}
            self.assertEqual(env['HOTEL_SETUP_LEGACY_HELPER_MODE'], mode)
            self.assertEqual(env.get('HOTEL_SETUP_LEGACY_HELPER_FROZEN'), None if mode == 'inspect' else 'b' * 64)
            self.assertNotIn('HOTEL_SETUP_READER_RLS_MODE', env)
            self.assertNotIn('TARGET_DATABASE_ADMIN_URL', env)
        calls = self.root / 'capture/calls.jsonl'
        for overrides, args in [({'GITHUB_REF': 'refs/heads/other'}, ['--inspect-hotel-setup-legacy-helpers']),
                                ({'GITHUB_EVENT_NAME': 'push'}, ['--inspect-hotel-setup-legacy-helpers']),
                                ({'GITHUB_REPOSITORY': 'other/repo'}, ['--inspect-hotel-setup-legacy-helpers']),
                                ({'EXPECTED_TASK': 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1187'}, ['--inspect-hotel-setup-legacy-helpers']),
                                ({}, ['--inspect-hotel-setup-legacy-helpers', ORG]),
                                ({}, ['--verify-hotel-setup-legacy-helpers', 'not-a-fingerprint'])]:
            calls.unlink(missing_ok=True)
            previous = self.env.copy()
            self.env.update(overrides)
            self.assertEqual(self.run_wrapper(*args).returncode, 2)
            self.assertFalse(calls.exists())
            self.env = previous

    def test_generated_eval_executes_actual_legacy_cli_before_dependency_load(self):
        self.legacy_environment()
        for mode, args in [('inspect', []), ('verify', ['b' * 64])]:
            self.env['MOCK_RECEIPT'] = json.dumps({'status': 'PASS', 'scope': 'hotel_setup_legacy_helper_inspection', 'mode': mode})
            result = self.run_wrapper('--' + mode + '-hotel-setup-legacy-helpers', *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            override, = json.loads((self.root / 'capture/overrides.json').read_text())['containerOverrides']
            command = override['command']
            self.assertEqual(command[:2], ['node', '--eval'])
            path = (self.root / 'injected-legacy.mjs').resolve()
            command[2] = command[2].replace("p='/app/.vayada-db-runtime-preflight.mjs'", 'p=' + json.dumps(str(path)))
            env = {'PATH': os.environ['PATH'], **{entry['name']: entry['value'] for entry in override['environment']}}
            env['TARGET_DATABASE_ADMIN_URL'] = 'invalid-destination'
            actual = subprocess.run(command, env=env, cwd=self.root, capture_output=True, text=True, timeout=20)
            self.assertEqual(actual.returncode, 1, actual.stdout + actual.stderr)
            self.assertEqual(actual.stdout, '')
            self.assertEqual(json.loads(actual.stderr), {'status': 'FAIL', 'code': 'hotel_setup_legacy_helper_inspection_unavailable'})
            # The exported fixture import remains inert even with invalid production inputs.
            imported = subprocess.run(['node', '--input-type=module', '--eval', 'await import(' + json.dumps(path.as_uri()) + ')'],
                                      env=env, cwd=self.root, capture_output=True, text=True, timeout=20)
            self.assertEqual((imported.returncode, imported.stdout, imported.stderr), (0, '', ''))

    def test_legacy_blocked_receipt_is_sanitized_and_wrong_scope_cannot_pass(self):
        self.legacy_environment()
        receipt = {'status': 'BLOCKED', 'scope': 'hotel_setup_legacy_helper_inspection', 'mode': 'inspect'}
        self.env.update(MOCK_EXIT_CODE='2', MOCK_RECEIPT=json.dumps(receipt))
        blocked = self.run_wrapper('--inspect-hotel-setup-legacy-helpers')
        self.assertEqual(blocked.returncode, 2, blocked.stderr)
        self.assertEqual(json.loads(blocked.stdout), receipt)
        for status, code in [('PASS', '0'), ('BLOCKED', '2')]:
            self.env.update(MOCK_EXIT_CODE=code, MOCK_RECEIPT=json.dumps({**receipt, 'status': status, 'scope': 'wrong_scope'}))
            self.assertEqual(self.run_wrapper('--inspect-hotel-setup-legacy-helpers').returncode, 1)
        for status, code in [('PASS', '0'), ('BLOCKED', '2')]:
            self.env.update(MOCK_EXIT_CODE=code, MOCK_RECEIPT=json.dumps({**receipt, 'status': status, 'mode': 'verify'}))
            self.assertEqual(self.run_wrapper('--inspect-hotel-setup-legacy-helpers').returncode, 1)

    def test_inspect_failure_diagnostic_has_exact_safe_schema(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                        EXPECTED_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186',
                        MOCK_CURRENT_TASK='arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1186',
                        MOCK_EXIT_CODE='1')
        diagnostic = {'stage': 'helper', 'predicate': 'grantAuthority', 'checks': {'grantAuthority': False},
                      'subject': 'platform.channex_management_worker_source(text,text,uuid)', 'oid': 123,
                      'bodyHash': 'a' * 64, 'definitionHash': 'b' * 64, 'lockAcquired': True, 'sqlState': None}
        report = {'status': 'FAIL', 'code': 'hotel_setup_reader_rls_permission_unavailable',
                  'scope': 'hotel_setup_reader_rls_permissions', 'mode': 'inspect', 'diagnostic': diagnostic}
        self.env['MOCK_RECEIPT'] = json.dumps(report)
        result = self.run_wrapper('--inspect-hotel-setup-reader-rls')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), report)
        for mutation in ({'extra': 'fixture-sensitive'}, {'mode': 'apply'}, {'scope': 'wrong'},
                         {'code': 'fixture-sensitive'},
                         {'diagnostic': {**diagnostic, 'subject': 'fixture-sensitive'}},
                         {'diagnostic': {**diagnostic, 'sqlState': 'fixture-sensitive'}},
                         {'diagnostic': {**diagnostic, 'checks': {'fixture-sensitive': False}}},
                         {'diagnostic': {**diagnostic, 'bodyHash': 'fixture-sensitive'}},
                         {'diagnostic': {**diagnostic, 'extra': 'fixture-sensitive'}},
                         {'diagnostic': 'fixture-sensitive'},
                         {'diagnostic': {**diagnostic, 'checks': 'fixture-sensitive'}},
                         {'diagnostic': {**diagnostic, 'oid': 'fixture-sensitive'}},
                         {'diagnostic': {**diagnostic, 'bodyHash': {'fixture-sensitive': True}}}):
            self.env['MOCK_RECEIPT'] = json.dumps({**report, **mutation})
            denied = self.run_wrapper('--inspect-hotel-setup-reader-rls')
            self.assertEqual(denied.returncode, 1)
            self.assertEqual(denied.stderr.strip(), report['code'])
            self.assertEqual(denied.stdout, '')
        for scalar in ('fixture-sensitive', 123, None, ['fixture-sensitive']):
            self.env['MOCK_RECEIPT'] = json.dumps(scalar)
            denied = self.run_wrapper('--inspect-hotel-setup-reader-rls')
            self.assertEqual(denied.returncode, 1)
            self.assertEqual(denied.stderr.strip(), report['code'])
            self.assertEqual(denied.stdout, '')

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
                code = base64.b64decode(env['VAYADA_DB_RUNTIME_PREFLIGHT_CODE'])
                self.assertEqual(gzip.decompress(code), (ROOT / 'scripts/provision-hotel-setup-creation-login.mjs').read_bytes())
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

    def test_logo_cleanup_exact_manifest_separate_identity_and_physical_gate(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY='vayada-marketplace/vayada-platform',
                        MOCK_PUBLIC_IMAGE='269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST)
        (self.root / 'deployment/hotel-setup-caller-images.json').write_text(json.dumps({DIGEST: 'b' * 40}))
        inventory = self.root / 'deployment/hotel-setup-logo-images.json'
        inventory.write_text('{}')
        args = ['--cleanup-hotel-setup-logo', ORG, ORG, ACTOR, 'upload_session', ACTOR, 'plan', '', DIGEST]
        self.assertNotEqual(self.run_wrapper(*args).returncode, 0)
        self.assertFalse((self.root / 'capture/calls.jsonl').exists())
        inventory.write_text(json.dumps({DIGEST: 'b' * 40}))
        for phase in ('plan', 'apply'):
            args[6:8] = [phase, '' if phase == 'plan' else 'a' * 64]
            receipt = {'status': 'PLAN' if phase == 'plan' else 'PASS', 'kind': 'upload_session',
                       'targetId': ACTOR, 'manifestSha256': 'a' * 64, 'keyCount': 4}
            self.env['MOCK_RECEIPT'] = json.dumps(receipt)
            result = self.run_wrapper(*args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), receipt)
            definition = json.loads((self.root / 'capture/definition.json').read_text())
            self.assertEqual(definition['taskRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-logo-cleanup')
            item, = definition['containerDefinitions']
            self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_HELPER_OWNER_DATABASE_URL', 'valueFrom': '/vayada/prod/target-database-url'}])
            overrides = json.loads((self.root / 'capture/overrides.json').read_text())
            env = {entry['name']: entry['value'] for entry in overrides['containerOverrides'][0]['environment']}
            self.assertEqual(env['HOTEL_SETUP_LOGO_CLEANUP_APPLY'], 'enabled' if phase == 'apply' else 'blocked')
            self.assertEqual(env['HOTEL_SETUP_LOGO_CLEANUP_TARGET_ID'], ACTOR)
            self.assertLessEqual(len(json.dumps(overrides).encode()), 8192)
        for changes in ({'MOCK_LOGO_ADMISSION': 'enabled'}, {'MOCK_PROPERTY_RUNNING': '1'},
                        {'MOCK_DRAINING': '1'}, {'MOCK_GATE_DRIFT': '1'}):
            previous = self.env.copy()
            (self.root / 'capture/calls.jsonl').unlink()
            (self.root / 'capture/overrides.json').unlink(missing_ok=True)
            self.env.update(changes)
            self.assertNotEqual(self.run_wrapper(*args).returncode, 0)
            operations = [json.loads(line)[1] for line in (self.root / 'capture/calls.jsonl').read_text().splitlines()]
            if 'MOCK_GATE_DRIFT' in changes:
                self.assertIn('stop-task', operations)
            else:
                self.assertNotIn('register-task-definition', operations)
            self.env = previous
        self.assertNotIn('update-service', operations)

    def test_logo_property_runner_retains_proof_and_blocked_service_guards(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        MOCK_PUBLIC_IMAGE='269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST)
        (self.root / 'deployment/hotel-setup-caller-images.json').write_text(json.dumps({DIGEST: 'b' * 40}))
        inventory = self.root / 'deployment/hotel-setup-bootstrap-images.json'
        args = ['--provision-hotel-setup-property-native', ORG, ORG, ACTOR, 'property_logo', DIGEST]
        inventory.write_text('{}')
        self.assertNotEqual(self.run_wrapper(*args).returncode, 0)
        self.assertFalse((self.root / 'capture/calls.jsonl').exists())
        inventory.write_text(json.dumps({DIGEST: {key: 'b' * 40 for key in ('primarySource', 'rollbackSource', 'publisherSource')}}))
        result = self.run_wrapper(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        overrides = json.loads((self.root / 'capture/overrides.json').read_text())
        env = {entry['name']: entry['value'] for entry in overrides['containerOverrides'][0]['environment']}
        self.assertEqual(env['HOTEL_SETUP_COMMAND_OPERATION'], 'property_logo')
        operations = [json.loads(line)[1] for line in (self.root / 'capture/calls.jsonl').read_text().splitlines()]
        self.assertNotIn('update-service', operations)

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
        self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution')
        item, = definition['containerDefinitions']
        self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'},
            {'name': 'HOTEL_SETUP_HELPER_OWNER_DATABASE_URL', 'valueFrom': '/vayada/prod/target-database-url'}])
        raw = (self.root / 'capture/overrides.json').read_text()
        self.assertLessEqual(len(raw.encode()), 8192)
        env = {entry['name']: entry['value'] for entry in json.loads(raw)['containerOverrides'][0]['environment']}
        self.assertEqual(env['HOTEL_SETUP_COMMAND_PROPERTY_ID'], ORG)
        self.assertEqual(env['HOTEL_SETUP_COMMAND_OPERATION'], 'launch_settings')
        self.assertNotIn('HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL', env)
        self.assertNotIn('HOTEL_SETUP_HELPER_OWNER_DATABASE_URL', env)
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

    def test_readiness_migration_audit_is_fixed_read_only_and_canonical(self):
        task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1'
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main', EXPECTED_TASK=task,
                        MOCK_CURRENT_TASK=task, MOCK_STARTUP='true')
        inventory = self.root / 'deployment/hotel-setup-bootstrap-images.json'
        inventory.write_text(json.dumps({DIGEST: {key: 'b' * 40 for key in ('primarySource', 'rollbackSource', 'publisherSource')}}))
        result = self.run_wrapper('--audit-hotel-setup-readiness-migrations', DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        definition = json.loads((self.root / 'capture/definition.json').read_text())
        self.assertNotIn('taskRoleArn', definition)
        item, = definition['containerDefinitions']
        self.assertEqual(item['image'], '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST)
        self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}])
        self.assertEqual(item['environment'], [])
        self.assertEqual(item['workingDirectory'], '/app')
        self.assertFalse(item['privileged'])
        for key in ('entryPoint', 'mountPoints', 'volumesFrom', 'environmentFiles'):
            self.assertNotIn(key, item)
        overrides = json.loads((self.root / 'capture/overrides.json').read_text())
        self.assertLessEqual(len(json.dumps(overrides)), 8192)
        inventory.write_text('{}')
        (self.root / 'capture/calls.jsonl').unlink()
        self.assertNotEqual(self.run_wrapper('--audit-hotel-setup-readiness-migrations', DIGEST).returncode, 0)
        self.assertFalse((self.root / 'capture/calls.jsonl').exists())

    def test_migration_audit_uses_fixed_owner_injection_and_rejects_changed_task(self):
        task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1'
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main', EXPECTED_TASK=task, MOCK_CURRENT_TASK=task)
        (self.root / 'deployment/hotel-setup-bootstrap-images.json').write_text(json.dumps(
            {DIGEST: {key: 'b' * 40 for key in ('primarySource', 'rollbackSource', 'publisherSource')}}))
        result = self.run_wrapper('--audit-hotel-setup-migration', DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        definition = json.loads((self.root / 'capture/definition.json').read_text())
        self.assertNotIn('taskRoleArn', definition)
        self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution')
        item, = definition['containerDefinitions']
        self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}])
        self.assertEqual(item['environment'], [])
        self.assertEqual(item['portMappings'], [])
        self.assertLessEqual(len((self.root / 'capture/overrides.json').read_bytes()), 8192)
        calls = self.root / 'capture/calls.jsonl'
        for overrides in ({'GITHUB_REF': 'refs/heads/unreviewed'}, {'MOCK_PUBLIC_TASK': task[:-1] + '2'},
                          {'MOCK_PUBLIC_DEPLOYMENTS': '2'}):
            calls.unlink(missing_ok=True)
            previous = self.env.copy()
            self.env.update(overrides)
            self.assertNotEqual(self.run_wrapper('--audit-hotel-setup-migration', DIGEST).returncode, 0)
            if calls.exists():
                operations = [json.loads(line)[1] for line in calls.read_text().splitlines()]
                self.assertNotIn('register-task-definition', operations)
                self.assertNotIn('run-task', operations)
            self.env = previous

    def test_scope_group_stage_requires_stable_captured_hold_and_stopped_property_service(self):
        task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1'
        hold = {'schemaVersion': 1, 'status': 'active', 'service': 'next-target-backend',
            'physicalIdentity': {'accountId': '269416271598', 'region': 'eu-west-1',
                'cluster': 'vayada-backend-cluster', 'ecsService': 'vayada-next-api-service'},
            'reason': 'reviewed initial setup', 'operationId': 'setup-123', 'manifestId': None,
            'capturedTaskDefinitionArn': task, 'capturedImage': '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST,
            'dependentFrontendsCompatible': False, 'createdAt': '2026-10-03T17:00:00.000Z'}
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main', EXPECTED_TASK=task,
                        MOCK_CURRENT_TASK=task, MOCK_HOLD=json.dumps(hold))
        (self.root / 'deployment/hotel-setup-bootstrap-images.json').write_text(json.dumps(
            {DIGEST: {key: 'b' * 40 for key in ('primarySource', 'rollbackSource', 'publisherSource')}}))
        result = self.run_wrapper('--stage-hotel-setup-migration-scope', DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        definition = json.loads((self.root / 'capture/definition.json').read_text())
        self.assertNotIn('taskRoleArn', definition)
        self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution')
        self.assertLessEqual(len((self.root / 'capture/overrides.json').read_bytes()), 8192)
        calls = self.root / 'capture/calls.jsonl'
        for overrides in ({'MOCK_HOLD': json.dumps({**hold, 'schemaVersion': 2})},
                          {'MOCK_HOLD': json.dumps({**hold, 'capturedTaskDefinitionArn': task[:-1]+'2'})},
                          {'MOCK_PROPERTY_RUNNING': '1'}):
            calls.unlink(missing_ok=True)
            previous = self.env.copy()
            self.env.update(overrides)
            self.assertNotEqual(self.run_wrapper('--stage-hotel-setup-migration-scope', DIGEST).returncode, 0)
            operations = [json.loads(line)[1] for line in calls.read_text().splitlines()]
            self.assertNotIn('register-task-definition', operations)
            self.assertNotIn('run-task', operations)
            self.env = previous

    def test_logo_scope_requires_all_callers_and_both_private_services_stopped(self):
        task = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1'
        hold = {'schemaVersion': 1, 'status': 'active', 'service': 'next-target-backend',
            'physicalIdentity': {'accountId': '269416271598', 'region': 'eu-west-1',
                'cluster': 'vayada-backend-cluster', 'ecsService': 'vayada-next-api-service'},
            'reason': 'reviewed initial setup', 'operationId': 'setup-123', 'manifestId': None,
            'capturedTaskDefinitionArn': task, 'capturedImage': '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST,
            'dependentFrontendsCompatible': False, 'createdAt': '2026-10-03T17:00:00.000Z'}
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main', EXPECTED_TASK=task,
                        MOCK_CURRENT_TASK=task, MOCK_HOLD=json.dumps(hold), MOCK_RECEIPT=json.dumps({"status":"PASS","migration":"0466","scopeRole":"vayada_next_hotel_setup_logo_scope","login":False,"businessGrantsAdded":False,"migrationOwner":"vayada_target_prod_user","migrationOwnerCanCreateRole":False,"creatorAdminOnlyMembership":True}))
        (self.root / 'deployment/hotel-setup-bootstrap-images.json').write_text(json.dumps(
            {DIGEST: {key: 'b' * 40 for key in ('primarySource', 'rollbackSource', 'publisherSource')}}))
        result = self.run_wrapper('--stage-hotel-setup-logo-migration-scope', DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        definition = json.loads((self.root / 'capture/definition.json').read_text())
        self.assertNotIn('taskRoleArn', definition)
        self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution')
        self.assertLessEqual(len((self.root / 'capture/overrides.json').read_bytes()), 8192)
        calls = self.root / 'capture/calls.jsonl'
        for overrides in ({'MOCK_HOLD': json.dumps({**hold, 'schemaVersion': 2})},
                          {'MOCK_HOLD': json.dumps({**hold, 'capturedTaskDefinitionArn': task[:-1]+'2'})},
                          {'MOCK_PROPERTY_RUNNING': '1'}, {'MOCK_CREATION_RUNNING': '1'}, {'MOCK_CREATION_ADMISSION': 'enabled'}, {'MOCK_LOGO_ADMISSION': 'enabled'}, {'MOCK_DRAINING': '1'}, {'MOCK_GATE_DRIFT': '1'}):
            calls.unlink(missing_ok=True)
            (self.root / "capture/overrides.json").unlink(missing_ok=True)
            previous = self.env.copy()
            self.env.update(overrides)
            self.assertNotEqual(self.run_wrapper('--stage-hotel-setup-logo-migration-scope', DIGEST).returncode, 0)
            operations = [json.loads(line)[1] for line in calls.read_text().splitlines()]
            if 'MOCK_GATE_DRIFT' in overrides:
                self.assertIn('stop-task', operations)
            else:
                self.assertNotIn('register-task-definition', operations)
                self.assertNotIn('run-task', operations)
            self.env = previous

    def test_logo_scope_rejects_generic_pass_receipt(self):
        self.test_logo_scope_requires_all_callers_and_both_private_services_stopped()
        self.env['MOCK_RECEIPT']='{"status":"PASS"}'
        self.assertNotEqual(self.run_wrapper('--stage-hotel-setup-logo-migration-scope',DIGEST).returncode,0)

    def test_owner_lookup_receives_no_sdk_role_and_only_owner_secret(self):
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REF='refs/heads/main',
                        MOCK_PUBLIC_IMAGE='269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@' + DIGEST)
        for name, content in [('hotel-setup-caller-images.json', {DIGEST: 'b' * 40}),
                              ('hotel-setup-bootstrap-images.json', {DIGEST: {key: 'b' * 40 for key in ('primarySource', 'rollbackSource', 'publisherSource')}})]:
            (self.root / 'deployment' / name).write_text(json.dumps(content))
        self.assertNotEqual(self.run_wrapper('--audit-hotel-setup-owner', 'invalid', DIGEST).returncode, 0)
        self.assertFalse((self.root / 'capture/calls.jsonl').exists())
        result = self.run_wrapper('--audit-hotel-setup-owner', 'owner@example.test', DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        definition = json.loads((self.root / 'capture/definition.json').read_text())
        self.assertNotIn('taskRoleArn', definition)
        self.assertEqual(definition['executionRoleArn'], 'arn:aws:iam::269416271598:role/vayada-hotel-setup-property-bootstrap-execution')
        item, = definition['containerDefinitions']
        self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}])
        raw = (self.root / 'capture/overrides.json').read_text()
        self.assertLessEqual(len(raw.encode()), 8192)
        env = {entry['name']: entry['value'] for entry in json.loads(raw)['containerOverrides'][0]['environment']}
        self.assertEqual(env['HOTEL_SETUP_OWNER_EMAIL'], 'owner@example.test')
        operations = [json.loads(line)[1] for line in (self.root / 'capture/calls.jsonl').read_text().splitlines()]
        self.assertNotIn('update-service', operations)

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
