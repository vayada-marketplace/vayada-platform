"""Offline gates, fixed receipts and exact-attempt cleanup; no AWS calls."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('approved_runner', ROOT / 'scripts/run-hotel-setup-approved-readiness.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
DIGEST = 'sha256:' + 'a' * 64
IMAGE = runner.release.REPOSITORY + '@' + DIGEST
ATTEMPT = 'e' * 32
ARN = runner.CLUSTER_ARN.replace(':cluster/', ':task/') + '/' + 'f' * 32
PUBLIC = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1'
REGISTERED = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/' + runner.FAMILY + ':1'
PROOF = {'source': 'b' * 40, 'primarySource': 'c' * 40, 'rollbackSource': 'd' * 40}
FROZEN = {'organizations': [{'organizationId': org, 'actorUserId': actor, 'login': login,
    'expectedRoleOid': 100 + index, 'secretVersion': 'a' * 32} for index, (org, actor, login) in enumerate(runner.BINDINGS)],
    'readers': {'expectedCreationReaderOid': 102, 'expectedPropertyReaderOid': 103}}
CAPTURED = {'publicTask': PUBLIC, 'publicTaskArn': 'captured-physical-public',
    'private': {'creation': 'creation:1', 'property': 'property:1'}, 'network': {'awsvpcConfiguration': {'subnets': ['fixture']}}}


def apply_value():
    return {'status': 'PASS', 'mode': 'apply', 'organizations': [{'status': 'ready',
        'organizationId': item['organizationId'], 'login': item['login'], 'roleOid': item['expectedRoleOid'],
        'secretVersion': item['secretVersion']} for item in FROZEN['organizations']],
        'readers': {'status': 'granted', 'readers': [{'login': login, 'relation': relation, 'roleOid': oid,
            'columns': ['credential_role_oid', 'credential_secret_version', 'credential_ready_at']} for login, relation, oid in [
            ('vayada_next_hotel_setup_creation_reader', 'platform.hotel_setup_creation_scopes', 102),
            ('vayada_next_hotel_setup_reader', 'platform.hotel_setup_property_scopes', 103)]]}}


class ApprovedReadinessTest(unittest.TestCase):
    def test_diagnosis_cannot_apply_or_supply_frozen_inspection(self):
        task = runner.definition('diagnose', DIGEST)
        item = task['containerDefinitions'][0]
        env = {entry['name']: entry['value'] for entry in item['environment']}
        self.assertEqual(env['HOTEL_SETUP_APPROVED_READINESS_MODE'], 'inspect')
        self.assertNotIn('HOTEL_SETUP_APPROVED_READINESS_INSPECTION', env)
        self.assertIn('inspectApprovedReadiness(config)', item['command'][0])
        self.assertNotIn('applyApprovedReadiness(', item['command'][0])
        with self.assertRaises(RuntimeError):
            runner.definition('diagnose', DIGEST, FROZEN)
        value = {'status': 'PASS', 'mode': 'diagnose', 'inspectionStatus': 'FAIL',
            'phase': 'query_04', 'rowCount': None, 'sqlState': '42501', 'statementSha256': 'a' * 64}
        runner.diagnostic_receipt(value)
        for key, bad in [('phase', 'secret'), ('sqlState', 'password'), ('rowCount', True),
                ('inspectionStatus', 'ready'), ('statementSha256', 'SQL-with-data')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                runner.diagnostic_receipt({**value, key: bad})
        with patch.object(runner, 'approved_image', return_value=PROOF), \
             patch.object(runner, 'snapshot', return_value=CAPTURED), \
             patch.object(runner, 'run_pass', return_value=(value, {'taskArn': ARN})) as run:
            result = runner.run('diagnose', DIGEST, PUBLIC, '1:1')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], 'diagnose')
        self.assertNotIn('inspectionSha256', result)
        self.assertNotIn('inspection', result)

    def test_empty_inventory_denies_before_aws_and_only_exact_dual_proof_is_admitted(self):
        with patch.object(runner.Path, 'read_text', return_value='{}'), patch.object(runner, 'aws') as aws, self.assertRaises(RuntimeError):
            runner.run('apply', DIGEST, PUBLIC, '1:1')
        aws.assert_not_called()
        for proof in (PROOF, 'old-source', {'source': 'b' * 40}, {**PROOF, 'extra': 'd' * 40}):
            with self.subTest(proof=proof), patch.object(runner.Path, 'read_text', return_value=json.dumps({DIGEST: proof})):
                if proof == PROOF:
                    self.assertEqual(runner.approved_image(DIGEST), PROOF)
                else:
                    with self.assertRaises(RuntimeError):
                        runner.approved_image(DIGEST)

    def test_cli_forces_bounded_no_pagination_single_attempt_calls(self):
        with patch.dict(runner.os.environ, {'AWS_MAX_ATTEMPTS': '9', 'AWS_RETRY_MODE': 'adaptive'}), \
             patch.object(runner.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{}')) as call:
            runner.aws('ecs', 'list-tasks')
        self.assertEqual(call.call_args.kwargs['timeout'], 25)
        self.assertEqual(call.call_args.kwargs['env']['AWS_MAX_ATTEMPTS'], '1')
        self.assertEqual(call.call_args.kwargs['env']['AWS_RETRY_MODE'], 'standard')
        self.assertIn('--no-paginate', call.call_args.args[0])

    def test_fixed_launcher_identity_ca_and_same_job_inspection_only(self):
        for mode in ('inspect', 'apply'):
            task = runner.definition(mode, DIGEST, FROZEN if mode == 'apply' else None)
            self.assertEqual(task['family'], runner.FAMILY)
            self.assertEqual(task['taskRoleArn'], runner.ROLE)
            self.assertEqual(task['executionRoleArn'], runner.EXECUTION)
            item = task['containerDefinitions'][0]
            self.assertEqual(item['command'], runner.COMMAND)
            self.assertTrue(item['readonlyRootFilesystem'])
            self.assertFalse(item['privileged'])
            self.assertEqual(item['image'], IMAGE)
            self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}])
            env = {entry['name']: entry['value'] for entry in item['environment']}
            self.assertEqual(env['HOTEL_SETUP_APPROVED_READINESS_MODE'], mode)
            self.assertEqual(env['NODE_EXTRA_CA_CERTS'], '/runtime/rds-ca.pem')
            self.assertNotIn('HOTEL_SETUP_AUTOMATIC_MODE', env)
            if mode == 'apply':
                self.assertEqual(json.loads(env['HOTEL_SETUP_APPROVED_READINESS_INSPECTION']), FROZEN)
            else:
                self.assertNotIn('HOTEL_SETUP_APPROVED_READINESS_INSPECTION', env)
        with patch.object(runner, 'CA_HASH', 'wrong'), self.assertRaises(RuntimeError):
            runner.definition('inspect', DIGEST)
        with self.assertRaises(RuntimeError):
            runner.definition('apply', DIGEST)

    def test_receipts_reject_wrong_bindings_oid_version_extra_or_secret_fields(self):
        self.assertEqual(runner.inspection(FROZEN), FROZEN)
        mutations = [lambda v: v['organizations'].reverse(),
            lambda v: v['organizations'][0].update(expectedRoleOid=True),
            lambda v: v['organizations'][0].update(secretVersion='latest'),
            lambda v: v['organizations'][0].update(actorUserId=runner.BINDINGS[1][1]),
            lambda v: v['organizations'][0].update(password='secret'),
            lambda v: v['readers'].update(expectedCreationReaderOid=0),
            lambda v: v['readers'].update(expectedPropertyReaderOid=100)]
        for mutate in mutations:
            bad = copy.deepcopy(FROZEN)
            mutate(bad)
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                runner.inspection(bad)
        runner.apply_receipt(apply_value(), FROZEN)
        for mutate in [lambda v: v['organizations'][0].update(secretVersion='b' * 32),
            lambda v: v['organizations'][0].update(roleOid=999),
            lambda v: v['organizations'][0].update(password='secret'),
            lambda v: v['readers']['readers'][0]['columns'].append('actor_user_id'),
            lambda v: v['readers']['readers'][0].update(roleOid=999)]:
            bad = apply_value()
            mutate(bad)
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                runner.apply_receipt(bad, FROZEN)
        with self.assertRaises(RuntimeError):
            json.loads('{"status":"PASS","status":"FAIL"}', object_pairs_hook=runner.unique_object)

    def test_zero_counts_do_not_hide_pending_or_draining_physical_tasks(self):
        arn = runner.gate.CLUSTER_ARN.replace(':cluster/', ':task/') + '/' + 'a' * 32
        for desired, last, override in [('RUNNING', 'RUNNING', {}), ('STOPPED', 'STOPPING', {}),
                ('STOPPED', 'STOPPED', {'taskRoleArn': 'other'}), ('STOPPED', 'STOPPED', {}), ('STOPPED', 'STOPPED', {'inferenceAcceleratorOverrides': []}),
                *[('STOPPED', 'STOPPED', {'inferenceAcceleratorOverrides': value}) for value in ([{'deviceName': 'other'}], None, {}, '')]]:
            def aws(*args):
                if args[1] == 'list-tasks':
                    return {'taskArns': [arn] if args[-1] == desired else []}
                return {'tasks': [{'taskArn': arn, 'clusterArn': runner.gate.CLUSTER_ARN,
                    'group': 'service:private-fixture', 'lastStatus': last, 'overrides': override}]}
            with self.subTest(desired=desired, last=last, override=override), patch.object(runner, 'aws', side_effect=aws):
                if last == 'STOPPED' and override in ({}, {'inferenceAcceleratorOverrides': []}):
                    runner.physically_stopped(runner.release.CLUSTER, '--service-name', 'private-fixture', 'hotel-setup')
                else:
                    with self.assertRaises(RuntimeError):
                        runner.physically_stopped(runner.release.CLUSTER, '--service-name', 'private-fixture', 'hotel-setup')
        with patch.object(runner, 'aws', return_value={'taskArns': [arn], 'nextToken': 'more'}), self.assertRaises(RuntimeError):
            runner.physically_stopped(runner.release.CLUSTER, '--service-name', 'private-fixture')

    def test_both_retained_pairs_stopped_counts_and_exact_public_capture_are_required(self):
        public = {'taskDefinitionArn': PUBLIC, 'family': 'vayada-next-api', 'executionRoleArn': runner.release.EXECUTION,
            'taskRoleArn': runner.gate.ACCOUNT + 'vayada-next-api-media-task-role',
            'containerDefinitions': [{'name': 'vayada-next-api', 'image': IMAGE, 'environment': [
                {'name': 'NODE_ENV', 'value': 'production'}, {'name': 'FINANCE_EXPORT_WORKER_ENABLED', 'value': 'false'}], 'secrets': []}]}
        for purpose in runner.release.PRIVATE:
            token = 'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + runner.release.SECRET[purpose] + '-AbCd12'
            public = runner.release.prepare_public(public, purpose, 'enabled', DIGEST, token)
            public['taskDefinitionArn'] = PUBLIC
            public = runner.release.prepare_public(public, purpose, 'blocked', DIGEST)
            public['taskDefinitionArn'] = PUBLIC
        mutations = [('valid', lambda d: None), ('execution', lambda d: d.update(executionRoleArn='other')),
            ('missing-token', lambda d: d['containerDefinitions'][0]['secrets'].pop()),
            ('missing-origin', lambda d: d['containerDefinitions'][0].update(environment=[e for e in d['containerDefinitions'][0]['environment']
                if e['name'] != 'HOTEL_SETUP_COMMAND_ORIGIN'])),
            ('enabled', lambda d: next(e for e in d['containerDefinitions'][0]['environment']
                if e['name'] == 'HOTEL_SETUP_COMMAND_ADMISSION').update(value='enabled')),
            ('pending', lambda d: None), ('public-replaced', lambda d: None)]
        for case, mutate in mutations:
            definition = copy.deepcopy(public)
            mutate(definition)
            reads = 0
            def service(name):
                nonlocal reads
                if name == runner.release.PUBLIC:
                    reads += 1
                    task = PUBLIC + 'changed' if case == 'public-replaced' and reads > 1 else PUBLIC
                    return {'taskDefinition': task, 'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0,
                        'deployments': [{'status': 'PRIMARY', 'rolloutState': 'COMPLETED'}], 'networkConfiguration': {}}
                return {'taskDefinition': REGISTERED, 'desiredCount': 0, 'runningCount': 0,
                    'pendingCount': 1 if case == 'pending' else 0, 'deployments': [{'status': 'PRIMARY', 'rolloutState': 'COMPLETED'}]}
            with self.subTest(case=case), patch.object(runner.release, 'service', side_effect=service), \
                 patch.object(runner, 'aws', return_value={'taskDefinition': definition}), patch.object(runner.release, 'approved'), \
                 patch.object(runner.release, 'healthy'), patch.object(runner.gate, 'physical_tasks', return_value='fixed-physical'), \
                 patch.object(runner, 'physically_stopped'):
                if case == 'valid':
                    self.assertEqual(runner.snapshot(PUBLIC)['publicTaskArn'], 'fixed-physical')
                else:
                    with self.assertRaises(RuntimeError):
                        runner.snapshot(PUBLIC)

    def test_public_definition_cannot_override_blocked_admission_through_startup(self):
        item = {'name': 'vayada-next-api', 'image': IMAGE, 'environment': [
            {'name': 'NODE_ENV', 'value': 'production'}, {'name': 'FINANCE_EXPORT_WORKER_ENABLED', 'value': 'false'}]}
        source = {'family': 'vayada-next-api', 'taskRoleArn': runner.gate.ACCOUNT + 'vayada-next-api-media-task-role',
            'containerDefinitions': [item]}
        runner.public_startup(source)
        finance = copy.deepcopy(source)
        finance['containerDefinitions'][0].update(command=['sh', '-c', "umask 077; printf '%s' \"$FINANCE_EXPORT_RDS_CA\" > \"$NODE_EXTRA_CA_CERTS\" && exec ./scripts/start-next-api.sh"])
        finance['containerDefinitions'][0]['environment'] = [
            {'name': 'NODE_ENV', 'value': 'production'}, {'name': 'FINANCE_EXPORT_WORKER_ENABLED', 'value': 'true'},
            {'name': 'NODE_EXTRA_CA_CERTS', 'value': '/tmp/finance-export-rds-ca.pem'}, {'name': 'FINANCE_EXPORT_RDS_CA', 'value': runner.CA.read_text()}]
        runner.public_startup(finance)
        mutations = [lambda d: d.update(taskRoleArn=runner.ROLE), lambda d: d.update(volumes=[{'name': 'code'}]),
            lambda d: d['containerDefinitions'].append(copy.deepcopy(item)),
            lambda d: d['containerDefinitions'][0].update(entryPoint=['/bin/sh', '-ec'], command=['export HOTEL_SETUP_COMMAND_ADMISSION=enabled; exec node /app/apps/api/dist/server.js']),
            lambda d: d['containerDefinitions'][0].update(command=['node', '/app/apps/api/dist/server.js']),
            lambda d: d['containerDefinitions'][0].update(environmentFiles=[{'type': 's3', 'value': 'untrusted'}]),
            lambda d: d['containerDefinitions'][0].update(mountPoints=[{'containerPath': '/app'}]),
            lambda d: d['containerDefinitions'][0].update(volumesFrom=[{'sourceContainer': 'code'}]),
            lambda d: d['containerDefinitions'][0].update(workingDirectory='/untrusted'),
            *[lambda d, name=name: d['containerDefinitions'][0]['environment'].append({'name': name, 'value': 'injected'})
                for name in ('NODE_OPTIONS', 'NODE_PATH', 'API_RUNTIME', 'PATH', 'BASH_ENV', 'LD_PRELOAD', 'npm_config_node_options', 'nPm_CoNfIg_NoDe_OpTiOnS', 'CDPATH')],
            *[lambda d, name=name: d['containerDefinitions'][0].update(secrets=[{'name': name, 'valueFrom': 'untrusted'}])
                for name in ('NODE_OPTIONS', 'nPm_CoNfIg_NoDe_OpTiOnS', 'CDPATH')]]
        for mutate in mutations:
            bad = copy.deepcopy(source)
            mutate(bad)
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                runner.public_startup(bad)
        for mutate in [lambda d: d['containerDefinitions'][0]['command'].append('alternate'),
                lambda d: d['containerDefinitions'][0]['environment'][-1].update(value='wrong-ca'),
                lambda d: d['containerDefinitions'][0]['environment'][-2].update(value='/untrusted')]:
            bad = copy.deepcopy(finance)
            mutate(bad)
            with self.subTest(mutation=mutate), self.assertRaises(RuntimeError):
                runner.public_startup(bad)

    def test_same_job_frozen_inspection_and_gate_drift_prevent_apply(self):
        for drift in (False, True):
            reads = 0
            def snapshot(_):
                nonlocal reads
                reads += 1
                return {'changed': True} if drift and reads == 2 else CAPTURED
            def run_pass(mode, digest, expected, captured, attempt, frozen=None):
                self.assertEqual(captured, CAPTURED)
                if mode == 'inspect':
                    self.assertIsNone(frozen)
                    return {'status': 'PASS', 'mode': mode, 'inspection': FROZEN}, {'taskArn': ARN}
                self.assertEqual(frozen, FROZEN)
                return apply_value(), {'taskArn': ARN}
            with self.subTest(drift=drift), patch.object(runner, 'approved_image', return_value=PROOF), \
                 patch.object(runner, 'snapshot', side_effect=snapshot), patch.object(runner, 'run_pass', side_effect=run_pass) as calls:
                if drift:
                    with self.assertRaises(RuntimeError):
                        runner.run('apply', DIGEST, PUBLIC, '1:1')
                    self.assertEqual(calls.call_count, 1)
                else:
                    value = runner.run('apply', DIGEST, PUBLIC, '1:1')
                    self.assertEqual(set(value['tasks']), {'inspect', 'apply'})
                    self.assertNotEqual(calls.call_args_list[0].args[4], calls.call_args_list[1].args[4])

    def test_pass_cleanup_only_exact_task_including_lost_ack_after_desired_stop(self):
        for case in ('success', 'drift', 'bad-exit', 'lost-ack', 'lost-ack-running', 'timeout', 'wrong-tag', 'override', 'cleanup-read-failure'):
            stopped = False
            calls = []
            def aws(*args):
                nonlocal stopped
                calls.append(args)
                if args[1] == 'register-task-definition':
                    return {'taskDefinition': {'taskDefinitionArn': REGISTERED}}
                if args[1] == 'run-task':
                    self.assertNotIn('--overrides', args)
                    if case in ('lost-ack', 'lost-ack-running'):
                        raise RuntimeError('unknown')
                    return {'tasks': [{'taskArn': ARN}]}
                if args[1] == 'list-tasks':
                    candidate_status = 'RUNNING' if case == 'lost-ack-running' else 'STOPPED'
                    return {'taskArns': [ARN] if args[-1] == candidate_status else []}
                if args[1] == 'stop-task':
                    self.assertIn(ARN, args)
                    stopped = True
                    return {}
                if args[1] == 'describe-tasks':
                    if case == 'cleanup-read-failure' and sum(call[1] == 'describe-tasks' for call in calls) > 1:
                        raise RuntimeError('cleanup read failed')
                    return {'tasks': [{'taskArn': ARN, 'taskDefinitionArn': REGISTERED, 'clusterArn': runner.CLUSTER_ARN,
                        'group': 'family:' + runner.FAMILY, 'startedBy': ATTEMPT,
                        'tags': [] if case == 'wrong-tag' else runner.TAGS,
                        'overrides': {'taskRoleArn': 'other'} if case == 'override' else {'inferenceAcceleratorOverrides': [], 'containerOverrides': [{'name': runner.CONTAINER}]},
                        'lastStatus': 'STOPPED' if stopped or case in ('success', 'bad-exit', 'wrong-tag', 'override', 'cleanup-read-failure') else 'RUNNING',
                        'containers': [{'name': runner.CONTAINER, 'image': IMAGE, 'imageDigest': DIGEST,
                            'exitCode': 1 if case == 'bad-exit' else 0}]}]}
                if args[1] == 'get-log-events':
                    return {'events': [{'message': json.dumps({'status': 'PASS', 'mode': 'inspect', 'inspection': FROZEN})}]}
                raise AssertionError(args)
            reads = 0
            def snapshot(_):
                nonlocal reads
                reads += 1
                return {'changed': True} if case == 'drift' and reads == 2 else CAPTURED
            clock = [0, 181] if case == 'timeout' else [0, 1]
            with self.subTest(case=case), patch.object(runner, 'aws', side_effect=aws), patch.object(runner, 'snapshot', side_effect=snapshot), \
                 patch.object(runner, 'physically_stopped'), patch.object(runner.time, 'monotonic', side_effect=clock), patch.object(runner.time, 'sleep'), patch.object(runner, 'print') as output:
                if case == 'success':
                    value, observed = runner.run_pass('inspect', DIGEST, PUBLIC, CAPTURED, ATTEMPT)
                    self.assertEqual(value['inspection'], FROZEN)
                    self.assertEqual(observed['taskArn'], ARN)
                    output.assert_not_called()
                else:
                    with self.assertRaises(RuntimeError):
                        runner.run_pass('inspect', DIGEST, PUBLIC, CAPTURED, ATTEMPT)
                    failure = json.loads(output.call_args.args[0])
                    self.assertEqual(failure['attempt'], ATTEMPT)
                    self.assertEqual(failure['taskDefinition'], REGISTERED)
                    self.assertTrue(failure['inspectionRequired'])
                    self.assertEqual(set(failure), {'status', 'mode', 'attempt', 'inspectionRequired', 'candidateTaskArn', 'taskDefinition'})
                operations = [call[1] for call in calls]
                self.assertEqual(operations.count('run-task'), 1)
                self.assertNotIn('update-service', operations)
                self.assertNotIn('get-secret-value', operations)
                self.assertNotIn('deregister-task-definition', operations)
                if case in ('wrong-tag', 'override', 'cleanup-read-failure'):
                    self.assertNotIn('stop-task', operations)
                if case in ('lost-ack', 'lost-ack-running'):
                    self.assertTrue(stopped)
                    candidate_status = 'RUNNING' if case == 'lost-ack-running' else 'STOPPED'
                    self.assertIn(('ecs', 'list-tasks', '--cluster', runner.CLUSTER, '--family', runner.FAMILY, '--desired-status', candidate_status), calls)
                    self.assertEqual([call for call in calls if call[1] == 'stop-task'], [
                        ('ecs', 'stop-task', '--cluster', runner.CLUSTER, '--task', ARN,
                         '--reason', 'Approved readiness bounded task cleanup')])

    def test_workflow_keeps_manual_main_protection_shared_queue_and_no_owner_inputs(self):
        workflow = (ROOT / '.github/workflows/hotel-setup-approved-readiness.yml').read_text()
        for expected in ["workflow_dispatch:", "if: github.ref == 'refs/heads/main'",
                "environment: platform-mutations-v2", "group: production-ecs-mutations", "queue: max",
                "persist-credentials: false", "role/vayada-github-actions-platform-deploy",
                "python3 scripts/run-hotel-setup-approved-readiness.py"]:
            self.assertIn(expected, workflow)
        for forbidden in ('schedule:', 'organization_id:', 'actor_user_id:', 'property_id:',
                'secretsmanager:', 'ecs update-service', 'HOTEL_SETUP_AUTOMATIC_MODE'):
            self.assertNotIn(forbidden, workflow)
        ci = (ROOT / '.github/workflows/tf-validate.yml').read_text()
        self.assertIn('scripts/test_hotel_setup_approved_readiness.py scripts/test_hotel_setup_credentials.py', ci)

    def test_operational_task_accepts_only_absent_or_empty_inference_overrides(self):
        for overrides in ({}, {'inferenceAcceleratorOverrides': []}, *[{'inferenceAcceleratorOverrides': value}
                for value in ([{'deviceName': 'other'}], None, {}, '')]):
            task = {'taskArn': ARN, 'taskDefinitionArn': REGISTERED, 'clusterArn': runner.CLUSTER_ARN,
                'group': 'family:' + runner.FAMILY, 'startedBy': ATTEMPT, 'tags': runner.TAGS, 'overrides': overrides}
            with self.subTest(overrides=overrides), patch.object(runner, 'aws', return_value={'tasks': [task]}):
                if overrides in ({}, {'inferenceAcceleratorOverrides': []}):
                    self.assertEqual(runner.task_state(ARN, REGISTERED, ATTEMPT), task)
                else:
                    with self.assertRaises(RuntimeError):
                        runner.task_state(ARN, REGISTERED, ATTEMPT)

    def test_receipt_extra_fields_duplicate_events_or_unknown_status_never_pass(self):
        for value in [apply_value(), {'status': 'PASS', 'mode': 'inspect', 'inspection': {**FROZEN, 'password': 'x'}},
                {'status': 'FAIL', 'mode': 'inspect', 'inspection': FROZEN}]:
            with self.subTest(value=value), patch.object(runner, 'aws', return_value={'events': [{'message': json.dumps(value)}]}), self.assertRaises(RuntimeError):
                runner.receipt(ARN, 'inspect', None)
        with patch.object(runner, 'aws', return_value={'events': [{'message': '{}'}] * 2}), self.assertRaises(RuntimeError):
            runner.receipt(ARN, 'inspect', None)


if __name__ == '__main__':
    unittest.main()
