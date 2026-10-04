"""Declaration and real jq rejection checks; not hosted admission proof."""
import json
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/pricing-verification-reader.yml"


class ReaderTests(unittest.TestCase):
    def test_protected_main_and_reader_only(self):
        text = WORKFLOW.read_text()
        for required in ('environment: vay1543-pricing-verification', 'persist-credentials: false',
                         'group: production-ecs-mutations', 'test "$WORKFLOW_REF" = refs/heads/main',
                         'test "$EXPECTED_SHA" = "$WORKFLOW_SHA"', 'git rev-parse HEAD',
                         'git/ref/heads/main', 'allowed-account-ids: "269416271598"',
                         'role-duration-seconds: 900', 'role-session-name: pricing-reader-${{ github.run_id }}'):
            self.assertIn(required, text)
        self.assertEqual(re.findall(r'role-to-assume: (\S+)', text), [
            'arn:aws:iam::269416271598:role/vayada-github-actions-platform-plan'])
        self.assertEqual(re.findall(r'uses: (\S+)', text), [
            'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
            'aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'])
        for forbidden in ('secrets.', 'terraform ', 'upload-artifact', 'actions/cache', 'platform-deploy',
                          '--with-decryption', 'cancel-in-progress', 'pull_request:', 'schedule:'):
            self.assertNotIn(forbidden, text)
        self.assertIn('identity check only', text)
        for required in ('aws-profile: vayada', 'output-env-credentials: false',
                         '--profile vayada',
                         'env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN -u AWS_PROFILE -u AWS_DEFAULT_PROFILE'):
            self.assertIn(required, text)
        self.assertIn('no plan, permission admission, activation or hold release', text)

    def test_native_identity_expression_rejects_wrong_or_incomplete_callers(self):
        expression = WORKFLOW.read_text().split("jq -e '\n", 1)[1].split("' <<<", 1)[0]
        valid = {'Account': '269416271598',
                 'Arn': 'arn:aws:sts::269416271598:assumed-role/vayada-github-actions-platform-plan/pricing-reader-123',
                 'UserId': 'AROAT5OTWB3XFQWPINYTU:pricing-reader-123'}
        cases = [(valid, True), ({}, False),
                 (valid | {'UserId': 'AROAT5OTWB3XFQWPINYTU:pricing-reader-456'}, False)]
        for field in valid:
            for value in ('other', None, 1):
                cases.append((valid | {field: value}, False))
            cases.append(({k: v for k, v in valid.items() if k != field}, False))
        for caller, expected in cases:
            with self.subTest(caller=caller):
                result = subprocess.run(['jq', '-e', expression], input=json.dumps(caller),
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, expected)


if __name__ == '__main__':
    unittest.main()
