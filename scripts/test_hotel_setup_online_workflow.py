"""Execute the workflow's actual environment gate with offline GitHub responses."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import textwrap
import unittest
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/hotel-setup-online.yml').read_text()
GATE = textwrap.dedent(WORKFLOW.split("python3 - <<'PY'\n", 1)[1].split('\n          PY', 1)[0])
NAME = 'hotel-setup-automatic-provisioning'
BASE = 'https://api.github.com/repos/vayada-marketplace/vayada-platform/environments/' + NAME
ENV = {'GITHUB_REPOSITORY': 'vayada-marketplace/vayada-platform', 'GITHUB_REF': 'refs/heads/main',
       'HOTEL_SETUP_AUTOMATIC_PROVISIONING_ENABLED': 'true', 'GH_TOKEN': 'private-synthetic-token'}
SAFE = [
    {'id': 42, 'name': NAME, 'deployment_branch_policy': {
        'protected_branches': False, 'custom_branch_policies': True},
     'protection_rules': [{'type': 'branch_policy'}]},
    {'total_count': 1, 'branch_policies': [{'name': 'main', 'type': 'branch'}]},
    {'total_count': 0, 'custom_deployment_protection_rules': []},
]


def execute(responses, env=ENV, calls=None):
    calls = [] if calls is None else calls
    def request(item, timeout):
        calls.append(item)
        if timeout != 15:
            raise AssertionError('unbounded API request')
        value = responses[len(calls) - 1]
        if isinstance(value, Exception):
            raise value
        body = io.BytesIO(json.dumps(value).encode())
        body.status = 200
        body.geturl = lambda: item.full_url
        return body
    output = io.StringIO()
    with patch.dict(os.environ, env, clear=True), patch.object(urllib.request, 'urlopen', request), \
         contextlib.redirect_stdout(output):
        exec(compile(GATE, 'actual-workflow-environment-gate', 'exec'), {})
    return calls, output.getvalue()


class OnlineWorkflowTests(unittest.TestCase):
    def test_exact_machine_environment_uses_only_bounded_fixed_gets(self):
        calls, output = execute(SAFE)
        self.assertEqual([item.full_url for item in calls], [BASE,
            BASE + '/deployment-branch-policies?per_page=100', BASE + '/deployment_protection_rules'])
        for item in calls:
            self.assertEqual(item.get_method(), 'GET')
            self.assertIsNone(item.data)
            self.assertEqual(item.get_header('X-github-api-version'), '2022-11-28')
        self.assertNotIn(ENV['GH_TOKEN'], output)

    def test_missing_unrestricted_human_and_unknown_protection_fail_closed(self):
        variants = [None, {'protected_branches': True, 'custom_branch_policies': False}]
        invalid = []
        for policy in variants:
            value = copy.deepcopy(SAFE)
            value[0]['deployment_branch_policy'] = policy
            invalid.append(value)
        for rule in [{'type': 'required_reviewers', 'reviewers': []},
                     {'type': 'wait_timer', 'wait_timer': 0}, {'type': 'unknown'}]:
            value = copy.deepcopy(SAFE)
            value[0]['protection_rules'].append(rule)
            invalid.append(value)
        value = copy.deepcopy(SAFE)
        del value[0]['protection_rules']
        invalid.append(value)
        invalid.append([RuntimeError('private-synthetic-token'), *SAFE[1:]])
        for value in invalid:
            with self.subTest(response=value), self.assertRaises(SystemExit) as error:
                execute(value)
            self.assertNotIn(ENV['GH_TOKEN'], str(error.exception))

    def test_only_one_exact_main_branch_and_no_custom_approval_app_is_admitted(self):
        invalid = []
        for policy in [{'name': '*', 'type': 'branch'}, {'name': 'main', 'type': 'tag'}, {'name': 'main'}]:
            value = copy.deepcopy(SAFE)
            value[1]['branch_policies'] = [policy]
            invalid.append(value)
        value = copy.deepcopy(SAFE)
        value[1]['total_count'] = 2
        invalid.append(value)
        for custom in [{'total_count': 1, 'custom_deployment_protection_rules': [{'enabled': True}]},
                       {'total_count': 0}, {'custom_deployment_protection_rules': []}]:
            value = copy.deepcopy(SAFE)
            value[2] = custom
            invalid.append(value)
        for value in invalid:
            with self.subTest(response=value), self.assertRaises(SystemExit):
                execute(value)

    def test_disabled_foreign_and_nonmain_requests_make_no_api_calls(self):
        for key, value in [('HOTEL_SETUP_AUTOMATIC_PROVISIONING_ENABLED', ''),
                           ('HOTEL_SETUP_AUTOMATIC_PROVISIONING_ENABLED', 'false'),
                           ('HOTEL_SETUP_AUTOMATIC_PROVISIONING_ENABLED', 'TRUE'),
                           ('GITHUB_REF', 'refs/heads/other'), ('GITHUB_REF', 'refs/tags/main'),
                           ('GITHUB_REPOSITORY', 'other/repository')]:
            calls = []
            with self.subTest(key=key, value=value), self.assertRaises(SystemExit):
                execute([], dict(ENV, **{key: value}), calls)
            self.assertEqual(calls, [])

    def test_queue_default_off_environment_dependency_and_sequential_passes(self):
        preflight, mutation = WORKFLOW.split('  provision:\n', 1)
        self.assertIn('cron: "*/5 * * * *"', WORKFLOW)
        self.assertIn('group: production-ecs-mutations\n  queue: max', WORKFLOW)
        self.assertEqual(WORKFLOW.count("vars.HOTEL_SETUP_AUTOMATIC_PROVISIONING_ENABLED == 'true'"), 2)
        self.assertEqual(WORKFLOW.count("github.ref == 'refs/heads/main'"), 2)
        self.assertNotIn('\n    environment:', preflight)
        self.assertNotIn('id-token: write', preflight)
        self.assertIn('needs: environment-check', mutation)
        self.assertIn('environment: ' + NAME, mutation)
        self.assertLess(mutation.index('*machine_environment'), mutation.index('configure-aws-credentials'))
        self.assertIn('role/vayada-github-actions-hotel-setup-online', mutation)
        self.assertIn('ref: ${{ github.sha }}', mutation)
        self.assertLess(mutation.index('--mode organization'), mutation.index('--mode property'))
        for forbidden in ['strategy:', 'inputs:', 'update-service', 'get-secret-value', 'platform-mutations-v2']:
            self.assertNotIn(forbidden, WORKFLOW)


if __name__ == '__main__':
    unittest.main()
