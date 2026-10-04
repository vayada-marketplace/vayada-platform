"""Operational isolation, release drift and unknown-response cleanup, without AWS."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('online_runner', ROOT / 'scripts/run-hotel-setup-online.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
DIGEST = 'sha256:' + 'a' * 64
INVENTORY = {'operational': {DIGEST: {'source': 'b' * 40, 'primarySource': 'c' * 40, 'rollbackSource': 'd' * 40}}}
ATTEMPT = 'e' * 32
ARN = runner.gate.CLUSTER_ARN.replace(':cluster/', ':task/') + '/' + 'f' * 32
SNAPSHOT = {'publicTask': 'fixed-public', 'private': {'creation': 'fixed-creation', 'property': 'fixed-property'}}


class OnlineRunnerTest(unittest.TestCase):
    def test_subprocess_forces_a_single_aws_attempt_even_with_inherited_retries(self):
        with patch.dict(runner.os.environ, {'AWS_MAX_ATTEMPTS': '9', 'AWS_RETRY_MODE': 'adaptive'}), \
             patch.object(runner.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{}')) as call:
            runner.aws('ecs', 'run-task', '--client-token', ATTEMPT)
            self.assertEqual(call.call_args.kwargs['env']['AWS_MAX_ATTEMPTS'], '1')
            self.assertEqual(call.call_args.kwargs['env']['AWS_RETRY_MODE'], 'standard')
            self.assertEqual(call.call_args.kwargs['timeout'], 25)

    def test_only_reviewed_dual_proof_operational_artifact_is_admitted(self):
        self.assertEqual(runner.operational_image(INVENTORY), DIGEST)
        invalid = [{}, {'operational': {}}, {'operational': {DIGEST: 'b' * 40}},
                   {'operational': {DIGEST: {'source': 'b' * 40, 'primarySource': 'c' * 40}}}]
        bad = copy.deepcopy(INVENTORY)
        bad['operational'][DIGEST]['rollbackSource'] = 'not-a-source'
        invalid.append(bad)
        ambiguous = copy.deepcopy(INVENTORY)
        ambiguous['operational']['sha256:' + 'f' * 64] = copy.deepcopy(ambiguous['operational'][DIGEST])
        invalid.append(ambiguous)
        for inventory in invalid:
            with self.subTest(inventory=inventory), self.assertRaises((RuntimeError, TypeError)):
                runner.operational_image(inventory)

    def test_checked_in_inventory_selects_one_exact_proved_bundle(self):
        inventory = json.loads((ROOT / 'deployment/hotel-setup-online-images.json').read_text())
        proof = json.loads((ROOT / 'deployment/hotel-setup-helper-owner-image-proof.json').read_text())
        digest = runner.operational_image(inventory)
        self.assertEqual(digest, proof['bundle']['digest'])
        self.assertEqual(inventory['operational'][digest], {
            'source': proof['bundle']['publisherSource'],
            'primarySource': proof['primary']['source'],
            'rollbackSource': proof['rollback']['source'],
        })
        for mode in ('creation', 'property'):
            for slot in ('primary', 'rollback'):
                self.assertEqual(inventory[mode][proof[slot]['digest']], proof[slot]['source'])

    def test_task_identity_secrets_launcher_and_certificate_are_disjoint(self):
        for mode in ('organization', 'property'):
            source = runner.definition(mode, DIGEST)
            self.assertEqual(source['tags'], runner.TAGS)
            self.assertEqual(source['taskRoleArn'], runner.ROLES[mode])
            self.assertEqual(source['executionRoleArn'], runner.EXECUTION)
            item = source['containerDefinitions'][0]
            self.assertEqual(item['image'], runner.release.REPOSITORY + '@' + DIGEST)
            self.assertEqual(item['command'], runner.COMMAND)
            self.assertTrue(item['readonlyRootFilesystem'])
            self.assertFalse(item['privileged'])
            self.assertEqual(item['secrets'], [{'name': 'HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'},
                {'name': 'HOTEL_SETUP_HELPER_OWNER_DATABASE_URL', 'valueFrom': '/vayada/prod/target-database-url'}])
            self.assertNotIn('HOTEL_SETUP_HELPER_OWNER_DATABASE_URL', {entry['name'] for entry in item['environment']})
            env = {entry['name']: entry['value'] for entry in item['environment']}
            self.assertEqual(env['HOTEL_SETUP_AUTOMATIC_MODE'], mode)
            self.assertEqual(env['NODE_EXTRA_CA_CERTS'], '/runtime/rds-ca.pem')
            self.assertNotIn('DATABASE_URL', env)
        self.assertNotEqual(runner.ROLES['organization'], runner.ROLES['property'])
        with patch.object(runner, 'CA_HASH', 'wrong'), self.assertRaises(RuntimeError):
            runner.definition('property', DIGEST)

    def test_incompatible_serving_tasks_prevent_any_operational_mutation(self):
        with patch.object(runner.gate, 'snapshot', side_effect=RuntimeError('incompatible')), \
             patch.object(runner, 'aws') as aws:
            with self.assertRaises(RuntimeError):
                runner.run('organization', INVENTORY, ATTEMPT)
            aws.assert_not_called()

    def test_stale_or_draining_operational_tasks_deny_next_pass(self):
        for last in ('PENDING', 'RUNNING', 'STOPPED'):
            def aws(*args):
                if args[1] == 'list-tasks':
                    return {'taskArns': [ARN]}
                return {'tasks': [{'taskArn': ARN, 'clusterArn': runner.gate.CLUSTER_ARN,
                    'group': 'family:' + runner.FAMILIES['organization'], 'lastStatus': last}]}
            with self.subTest(last=last), patch.object(runner, 'aws', side_effect=aws):
                # Different-mode history is deliberately ambiguous in this fixture.
                with self.assertRaises(RuntimeError):
                    runner.quiet()

    def test_completed_family_history_is_safe_but_inexact_stop_identity_is_denied(self):
        def aws(*args):
            if args[1] == 'list-tasks':
                return {'taskArns': []}
            return {'tasks': [{'taskArn': ARN, 'clusterArn': runner.gate.CLUSTER_ARN,
                'taskDefinitionArn': 'expected', 'startedBy': 'other-attempt',
                'group': 'family:' + runner.FAMILIES['property'], 'lastStatus': 'RUNNING'}]}
        with patch.object(runner, 'aws', side_effect=aws) as calls:
            runner.quiet()
            with self.assertRaises(RuntimeError):
                runner.stop_exact(ARN, 'expected', ATTEMPT, 'property')
            self.assertNotIn('stop-task', [call.args[1] for call in calls.call_args_list])

    def test_timeout_stops_only_the_known_operational_task(self):
        registered = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/' + runner.FAMILIES['property'] + ':1'
        stopped = False
        calls = []
        def aws(*args):
            nonlocal stopped
            calls.append(args)
            if args[1] == 'register-task-definition':
                return {'taskDefinition': {'taskDefinitionArn': registered}}
            if args[1] == 'run-task':
                return {'tasks': [{'taskArn': ARN}]}
            if args[1] == 'describe-tasks':
                return {'tasks': [{'taskArn': ARN, 'taskDefinitionArn': registered,
                    'clusterArn': runner.gate.CLUSTER_ARN, 'startedBy': ATTEMPT,
                    'group': 'family:' + runner.FAMILIES['property'], 'tags': runner.TAGS,
                    'lastStatus': 'STOPPED' if stopped else 'RUNNING'}]}
            if args[1] == 'stop-task':
                self.assertIn(ARN, args)
                stopped = True
            return {}
        with patch.object(runner.gate, 'snapshot', return_value=SNAPSHOT), patch.object(runner, 'quiet'), \
             patch.object(runner.release, 'service', return_value={'networkConfiguration': {}}), \
             patch.object(runner, 'aws', side_effect=aws), patch.object(runner.time, 'monotonic', side_effect=[0, 181]):
            with self.assertRaisesRegex(RuntimeError, 'deadline'):
                runner.run('property', INVENTORY, ATTEMPT)
        self.assertTrue(stopped)
        self.assertEqual([call[1] for call in calls].count('stop-task'), 1)

    def test_missing_changed_or_duplicated_marker_cannot_stop_a_task(self):
        for tags in ([], [{'key': 'vayada:hotel-setup-online', 'value': 'false'}], runner.TAGS * 2):
            with self.subTest(tags=tags), patch.object(runner, 'aws', return_value={'tasks': [{
                'taskArn': ARN, 'taskDefinitionArn': 'expected', 'startedBy': ATTEMPT,
                'clusterArn': runner.gate.CLUSTER_ARN, 'group': 'family:' + runner.FAMILIES['property'],
                'lastStatus': 'RUNNING', 'tags': tags}]}) as calls:
                with self.assertRaises(RuntimeError):
                    runner.stop_exact(ARN, 'expected', ATTEMPT, 'property')
                self.assertNotIn('stop-task', [call.args[1] for call in calls.call_args_list])
                self.assertEqual(calls.call_args.args[-2:], ('--include', 'TAGS'))

    def test_pass_drift_failure_and_lost_run_ack_cleanup_only_exact_task(self):
        mode = 'property'
        registered = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/' + runner.FAMILIES[mode] + ':1'
        for case in ('success', 'before-run-drift', 'during-run-drift', 'exit-failure', 'lost-run-ack'):
            calls = []
            snapshot_reads = 0
            def snapshot(_):
                nonlocal snapshot_reads
                snapshot_reads += 1
                return {'changed': True} if (case == 'before-run-drift' and snapshot_reads == 2) or (case == 'during-run-drift' and snapshot_reads == 3) else SNAPSHOT
            def aws(*args):
                calls.append(args)
                if args[1] == 'register-task-definition':
                    return {'taskDefinition': {'taskDefinitionArn': registered}}
                if args[1] == 'run-task':
                    self.assertEqual(args[-2], '--tags')
                    self.assertEqual(runner.json.loads(args[-1]), runner.TAGS)
                    if case == 'lost-run-ack':
                        raise RuntimeError('response lost')
                    return {'tasks': [{'taskArn': ARN}]}
                if args[1] == 'describe-tasks':
                    return {'tasks': [{'taskArn': ARN, 'taskDefinitionArn': registered,
                        'clusterArn': runner.gate.CLUSTER_ARN, 'startedBy': ATTEMPT,
                        'group': 'family:' + runner.FAMILIES[mode], 'lastStatus': 'STOPPED', 'tags': runner.TAGS,
                        'containers': [{'name': 'hotel-setup-online', 'exitCode': 1 if case == 'exit-failure' else 0}]}]}
                if args[1] == 'list-tasks':
                    self.assertIn(ATTEMPT, args)
                    return {'taskArns': [ARN]}
                raise AssertionError(args[1])
            with self.subTest(case=case), patch.object(runner.gate, 'snapshot', side_effect=snapshot), \
                 patch.object(runner, 'quiet'), patch.object(runner.release, 'service', return_value={'networkConfiguration': {'awsvpcConfiguration': {'subnets': ['fixture']}}}), \
                 patch.object(runner, 'aws', side_effect=aws):
                if case == 'success':
                    receipt = runner.run(mode, INVENTORY, ATTEMPT)
                    self.assertEqual(receipt['status'], 'PASS')
                    self.assertEqual(receipt['retainedTaskDefinitionArn'], registered)
                else:
                    with self.assertRaises(RuntimeError):
                        runner.run(mode, INVENTORY, ATTEMPT)
                operations = [call[1] for call in calls]
                self.assertNotIn('update-service', operations)
                self.assertNotIn('get-secret-value', operations)
                self.assertEqual(operations.count('run-task'), 0 if case == 'before-run-drift' else 1)
                self.assertNotIn('deregister-task-definition', operations)


if __name__ == '__main__':
    unittest.main()
