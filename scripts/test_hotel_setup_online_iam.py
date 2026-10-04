"""Render the actual online IAM policy and exercise its task/secret boundaries."""
import fnmatch
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'infra/hotel_setup_online.tf'
CLUSTER = 'arn:aws:ecs:eu-west-1:269416271598:cluster/vayada-backend-cluster'
TASK = CLUSTER.replace(':cluster/', ':task/') + '/owned-task'
DEFINITION = 'arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-hotel-setup-online-property:1'
KEY = 'vayada:hotel-setup-online'


def render():
    with tempfile.TemporaryDirectory() as directory:
        text = SOURCE.read_text().split('resource "', 1)[0]
        text += '\nvariable "aws_region" { default = "eu-west-1" }\n'
        text += '\nvariable "aws_account_id" { default = "269416271598" }\n'
        Path(directory, 'main.tf').write_text(text)
        result = subprocess.run(['terraform', 'console', '-no-color'], cwd=directory,
            input='jsonencode({enabled=var.enable_hotel_setup_online_runner,trust=jsondecode(local.hotel_setup_online_trust),policy=jsondecode(local.hotel_setup_online_policy)})\n',
            capture_output=True, text=True, check=True, timeout=30)
        return json.loads(json.loads(result.stdout.strip()))


class OnlineIamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.actual = render()

    def allowed(self, action, resource, context):
        # Only the three condition operators present in this actual narrow policy.
        for statement in self.actual['policy']['Statement']:
            if action not in statement['Action']:
                continue
            resources = statement['Resource']
            resources = [resources] if isinstance(resources, str) else resources
            if not any(fnmatch.fnmatchcase(resource, pattern) for pattern in resources):
                continue
            matched = True
            for operator, conditions in statement.get('Condition', {}).items():
                for key, expected in conditions.items():
                    expected = [expected] if isinstance(expected, str) else expected
                    actual = context.get(key)
                    if operator == 'ForAllValues:StringEquals':
                        matched &= isinstance(actual, list) and all(value in expected for value in actual)
                    else:
                        self.assertIn(operator, ['StringEquals', 'ArnEquals'])
                        matched &= actual in expected
            if matched:
                return True
        return False

    def test_default_off_exact_machine_subject_and_no_credential_or_serving_mutation(self):
        self.assertFalse(self.actual['enabled'])
        trust, = self.actual['trust']['Statement']
        self.assertEqual(trust['Condition']['StringEquals'], {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': 'repo:vayada-marketplace/vayada-platform:environment:hotel-setup-automatic-provisioning'})
        actions = {a for s in self.actual['policy']['Statement'] for a in s['Action']}
        self.assertEqual(actions, {'ecs:DescribeServices', 'ecs:DescribeTaskDefinition', 'ecs:ListTasks',
            'elasticloadbalancing:DescribeTargetHealth', 'ecs:DescribeTasks', 'ecs:RegisterTaskDefinition',
            'ecs:RunTask', 'ecs:TagResource', 'ecs:StopTask', 'iam:PassRole'})
        self.assertEqual(SOURCE.read_text().count('var.enable_hotel_setup_online_runner ? 1 : 0'), 2)

    def test_stop_requires_own_marker_in_exact_cluster_and_tagging_is_create_only(self):
        stop = {'ecs:cluster': CLUSTER, 'aws:ResourceTag/' + KEY: 'true'}
        self.assertTrue(self.allowed('ecs:StopTask', TASK, stop))
        for context in [{}, dict(stop, **{'aws:ResourceTag/' + KEY: 'false'}),
                        dict(stop, **{'ecs:cluster': CLUSTER + '-other'})]:
            self.assertFalse(self.allowed('ecs:StopTask', TASK, context))
        self.assertFalse(self.allowed('ecs:StopTask', TASK.replace('269416271598', '111111111111'), stop))
        tagging = {'aws:RequestTag/' + KEY: 'true', 'aws:TagKeys': [KEY]}
        self.assertFalse(self.allowed('ecs:TagResource', TASK, tagging))
        for create in ['RunTask', 'RegisterTaskDefinition']:
            self.assertTrue(self.allowed('ecs:TagResource', TASK, dict(tagging, **{'ecs:CreateAction': create})))
        self.assertFalse(self.allowed('ecs:TagResource', TASK, dict(tagging, **{'ecs:CreateAction': 'CreateService'})))

    def test_run_and_register_reject_untagged_extra_tags_foreign_family_or_cluster(self):
        context = {'ecs:cluster': CLUSTER, 'aws:RequestTag/' + KEY: 'true', 'aws:TagKeys': [KEY]}
        for action in ['ecs:RunTask', 'ecs:RegisterTaskDefinition']:
            self.assertTrue(self.allowed(action, DEFINITION, context))
            self.assertFalse(self.allowed(action, DEFINITION.replace('online-property', 'property-primary'), context))
            self.assertFalse(self.allowed(action, DEFINITION, {}))
            self.assertFalse(self.allowed(action, DEFINITION, dict(context, **{'aws:TagKeys': [KEY, 'other']})))
        self.assertFalse(self.allowed('ecs:RunTask', DEFINITION, dict(context, **{'ecs:cluster': CLUSTER + '-other'})))

    def test_passrole_only_disjoint_operational_identities_and_exact_readonly_services(self):
        role = 'arn:aws:iam::269416271598:role/'
        for name in ['vayada-hotel-setup-creation-bootstrap', 'vayada-hotel-setup-property-bootstrap',
                     'vayada-hotel-setup-property-bootstrap-execution']:
            self.assertTrue(self.allowed('iam:PassRole', role + name, {'iam:PassedToService': 'ecs-tasks.amazonaws.com'}))
            self.assertFalse(self.allowed('iam:PassRole', role + name, {'iam:PassedToService': 'lambda.amazonaws.com'}))
        self.assertFalse(self.allowed('iam:PassRole', role + 'vayada-hotel-setup-task', {'iam:PassedToService': 'ecs-tasks.amazonaws.com'}))
        service = CLUSTER.replace(':cluster/', ':service/') + '/'
        for name in ['vayada-next-api-service', 'vayada-hotel-setup-service', 'vayada-hotel-setup-property-service']:
            self.assertTrue(self.allowed('ecs:DescribeServices', service + name, {}))
        self.assertFalse(self.allowed('ecs:DescribeServices', service + 'another-service', {}))


if __name__ == '__main__':
    unittest.main()
