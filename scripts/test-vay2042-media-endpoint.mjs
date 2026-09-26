import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const policyFile = fileURLToPath(new URL('../infra/vay2017-metadata-runner/media-s3-endpoint-policy.json', import.meta.url));
const checkerFile = fileURLToPath(new URL('./check-vay2017-rehearsal-isolation.sh', import.meta.url));
const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
const checker = readFileSync(checkerFile, 'utf8');
const filter = checker.match(/--slurpfile expected "\$s3_policy_file" '([\s\S]*?)' <<<"\$s3_policy"/)?.[1];
assert.ok(filter, 'live endpoint checker must use the tested filter');
const legacy = { Version: policy.Version, Statement: [policy.Statement[0]] };
const validate = (value, mode = 'media') => spawnSync('jq', ['-e', '--arg', 'mode', mode,
  '--slurpfile', 'expected', policyFile, filter], { input: JSON.stringify(value), encoding: 'utf8' });

test('Terraform uses the exact ECR and role-bound five-prefix endpoint contract', () => {
  const scoped = { ArnEquals: { 'aws:PrincipalArn': 'arn:aws:iam::269416271598:role/vayada-rehearsal-vay2042-20260926-media' } };
  assert.deepEqual(policy, { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::prod-eu-west-1-starport-layer-bucket/*' },
    { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: [
      'arn:aws:s3:::vayada-uploads-prod/creators/*',
      'arn:aws:s3:::vayada-uploads-prod/listings/*',
      'arn:aws:s3:::vayada-creator-marketplace-images/*',
    ], Condition: scoped },
    { Effect: 'Allow', Principal: '*', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [
      'arn:aws:s3:::vayada-rehearsal-vay2042-20260926-269416271598/public/media/*',
      'arn:aws:s3:::vayada-rehearsal-vay2042-20260926-269416271598/private/media/*',
    ], Condition: scoped },
  ] });
  const tf = readFileSync(new URL('../infra/vay2017-metadata-runner/runner.tf', import.meta.url), 'utf8');
  assert.match(tf, /resource "aws_vpc_endpoint" "vay2017_ecr_s3" \{[^]*?policy\s*=\s*file\("\$\{path.module\}\/media-s3-endpoint-policy.json"\)/);
  assert.match(checker, /routeTables:RouteTableIds,policy:PolicyDocument/);
  assert.match(checker, /\.type == "Gateway" and \.service == "com.amazonaws.eu-west-1.s3"\) \| \.policy/);
});

test('each mode accepts only its exact policy, including equivalent AWS serialization', () => {
  for (const [mode, value] of [['ecr-only', legacy], ['media', policy]]) {
    assert.equal(validate(value, mode).status, 0);
    const reordered = structuredClone(value);
    reordered.Statement.reverse();
    for (const statement of reordered.Statement) {
      statement.Sid = 'HarmlessIdentifier';
      statement.Principal = { AWS: '*' };
      statement.Action = [statement.Action].flat().reverse();
      statement.Resource = [statement.Resource].flat().reverse();
    }
    reordered.Statement = reordered.Statement.map((s) => Object.fromEntries(Object.entries(s).reverse()));
    const result = validate(reordered, mode);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.notEqual(validate(policy, 'ecr-only').status, 0);
  assert.notEqual(validate(legacy, 'media').status, 0);
  for (const invalid of [null, {}, [], { ...policy, Version: '2008-10-17' }]) {
    assert.notEqual(validate(invalid).status, 0);
  }
});

test('missing, extra, broadened and foreign-principal grants fail closed', () => {
  const mutations = [
    ['missing ECR', (p) => p.Statement.shift()],
    ['extra ECR', (p) => p.Statement.push(p.Statement[0])],
    ['broader ECR', (p) => { p.Statement[0].Resource = 'arn:aws:s3:::*'; }],
    ['missing source grant', (p) => p.Statement.splice(1, 1)],
    ['missing destination grant', (p) => p.Statement.pop()],
    ['no role restriction', (p) => { delete p.Statement[1].Condition; }],
    ['different role', (p) => { p.Statement[2].Condition.ArnEquals['aws:PrincipalArn'] = 'arn:aws:iam::269416271598:role/other'; }],
    ['wildcard role', (p) => { p.Statement[1].Condition = { ArnLike: { 'aws:PrincipalArn': '*' } }; }],
    ['extra principal', (p) => { p.Statement[2].Principal = { AWS: ['*', 'arn:aws:iam::269416271598:root'] }; }],
    ['source bucket root', (p) => { p.Statement[1].Resource[0] = 'arn:aws:s3:::vayada-uploads-prod/*'; }],
    ['source writes', (p) => { p.Statement[1].Action = ['s3:GetObject', 's3:PutObject']; }],
    ['production destination', (p) => { p.Statement[2].Resource[0] = 'arn:aws:s3:::vayada-media-production/public/media/*'; }],
    ['retained destination', (p) => { p.Statement[2].Resource[1] = 'arn:aws:s3:::vayada-rehearsal-7200a43a-269416271598/private/media/*'; }],
    ['owner reservation', (p) => p.Statement[2].Resource.push('arn:aws:s3:::vayada-rehearsal-vay2042-20260926-269416271598/rehearsal-control/owner.json')],
    ['bucket listing', (p) => p.Statement[2].Action.push('s3:ListBucket')],
    ['version deletion', (p) => p.Statement[2].Action.push('s3:DeleteObjectVersion')],
    ['wildcard actions', (p) => { p.Statement[2].Action = 's3:*'; }],
    ['extra statement', (p) => p.Statement.push({ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' })],
    ['NotAction', (p) => { p.Statement[2].NotAction = 's3:DeleteBucket'; }],
  ];
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(policy);
    mutate(changed);
    assert.notEqual(validate(changed).status, 0, name);
  }
});

test('checker defaults to ECR-only and rejects unknown modes before cloud access', () => {
  assert.ok(checker.includes('${1:---s3-ecr-only}'));
  assert.ok(checker.indexOf('case "${1:---s3-ecr-only}"') < checker.indexOf('aws sts'));
  for (const args of [['--allow-any'], ['--s3-media', '--s3-ecr-only']]) {
    const result = spawnSync('bash', [checkerFile, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected --s3-ecr-only/);
  }
});
