#!/usr/bin/env python3
"""Protected normal-CI release. Never run this directly against production."""
import argparse
import copy
import json
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('setup_coordinated_release', ROOT / 'scripts/coordinated_release.py')
coordinated = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(coordinated)
REGION = 'eu-west-1'
CLUSTER = 'vayada-backend-cluster'
REPOSITORY = '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api'
PUBLIC = 'vayada-next-api-service'
PRIVATE = {'creation': 'vayada-hotel-setup-service', 'property': 'vayada-hotel-setup-property-service'}
PREFIX = {'creation': 'HOTEL_SETUP_CREATION_COMMAND', 'property': 'HOTEL_SETUP_COMMAND'}
ORIGIN = {'creation': 'https://hotel-setup-command.vayada.com', 'property': 'https://hotel-setup-property-command.vayada.com'}
SECRET = {'creation': 'hotel-setup-creation/prod/internal-token', 'property': 'hotel-setup-command/prod/internal-token'}
EXECUTION = 'arn:aws:iam::269416271598:role/vayada-next-api-setup-caller-execution'
TASK = re.compile(r'^arn:aws:ecs:eu-west-1:269416271598:task-definition/[a-zA-Z0-9_-]+:[1-9][0-9]*$')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def aws(*args):
    result = subprocess.run(['aws', *args, '--region', REGION, '--output', 'json'], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def service(name):
    result = aws('ecs', 'describe-services', '--cluster', CLUSTER, '--services', name)
    require(not result.get('failures') and len(result['services']) == 1, 'Required service is missing')
    return result['services'][0]


def stable(state, task=None):
    return (state['desiredCount'] == state['runningCount'] == 1 and state['pendingCount'] == 0
            and len(state['deployments']) == 1 and state['deployments'][0]['rolloutState'] == 'COMPLETED' and state['deployments'][0].get('status') == 'PRIMARY'
            and (task is None or state['taskDefinition'] == task))


def healthy(state):
    groups = state.get('loadBalancers', [])
    require(len(groups) == 1, 'Expected exactly one service target group')
    targets = aws('elbv2', 'describe-target-health', '--target-group-arn', groups[0]['targetGroupArn'])['TargetHealthDescriptions']
    require(sum(target['TargetHealth']['State'] == 'healthy' for target in targets) == 1, 'Service target is not healthy')


def container(task, name):
    matches = [item for item in task['containerDefinitions'] if item['name'] == name]
    require(len(matches) == 1, 'Ambiguous container')
    return matches[0]


def environment(item):
    require(not any(entry.get('name') in {prefix + '_ADMISSION' for prefix in PREFIX.values()} for entry in item.get('secrets', [])), 'Admission cannot be supplied through secrets')
    entries = item.get('environment', [])
    values = {entry['name']: entry['value'] for entry in entries}
    require(len(entries) == len(values), 'Ambiguous environment')
    return values


def prepare_public(task, purpose, state, digest, token=None):
    result = copy.deepcopy(task)
    item = container(result, 'vayada-next-api')
    env = environment(item)
    prefix = PREFIX[purpose]
    secrets = item.get('secrets', [])
    pairs = [entry for entry in secrets if entry['name'] == prefix + '_INTERNAL_TOKEN']
    require(len(pairs) <= 1, 'Ambiguous token')
    if state == 'hold':
        require(prefix + '_ORIGIN' not in env and not pairs, 'Initial hold cannot remove an existing pair')
    elif state == 'blocked':
        require(result.get('executionRoleArn') == EXECUTION, 'Blocked pair requires isolated public execution identity')
        require(env.get(prefix + '_ORIGIN') == ORIGIN[purpose] and len(pairs) == 1, 'Blocked rollback must retain its pair')
    else:
        require(state == 'enabled' and token, 'Invalid caller release')
        env[prefix + '_ORIGIN'] = ORIGIN[purpose]
        item['secrets'] = [entry for entry in secrets if entry['name'] != prefix + '_INTERNAL_TOKEN'] + [{'name': prefix + '_INTERNAL_TOKEN', 'valueFrom': token}]
        result['executionRoleArn'] = EXECUTION
    if state != 'hold':
        reference = token if state == 'enabled' else pairs[0]['valueFrom']
        require(re.fullmatch(r'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + re.escape(SECRET[purpose]) + r'-[A-Za-z0-9]{6}', reference), 'Wrong internal token reference')
    env[prefix + '_ADMISSION'] = 'enabled' if state == 'enabled' else 'blocked'
    item['environment'] = [{'name': name, 'value': value} for name, value in env.items()]
    item['image'] = REPOSITORY + '@' + digest
    for key in ('taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt'):
        result.pop(key, None)
    return result


def approved(digest, inventory):
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', digest) is not None, 'Invalid digest')
    source = json.loads((ROOT / 'deployment' / inventory).read_text()).get(digest, '')
    require(re.fullmatch(r'[a-f0-9]{40}', source) is not None, 'Image lacks reviewed proof')


def initial_restore_target(public, expected, digest, hold, captured, candidate):
    """Restore only the captured pre-cutover task after an initial caller failure."""
    coordinated.validate_hold(hold, coordinated.load_config(), 'next-target-backend')
    require(public['taskDefinition'] == expected and public['desiredCount'] == 1,
            'Failed deployment changed before recovery')
    require(hold.get('status') == 'active' and hold.get('service') == 'next-target-backend'
            and hold.get('operationId', '').startswith('setup-')
            and hold.get('reason') == 'reviewed hotel setup caller release'
            and hold.get('physicalIdentity') == {'accountId': '269416271598', 'region': REGION,
                'cluster': CLUSTER, 'ecsService': PUBLIC}, 'Missing initial setup release hold')
    target = hold.get('capturedTaskDefinitionArn', '')
    require(TASK.fullmatch(target) and target.split('/')[-1].startswith('vayada-next-api:')
            and target != expected and captured.get('taskDefinitionArn') == target,
            'Captured recovery task differs')
    require(container(candidate, 'vayada-next-api')['image'] == REPOSITORY + '@' + digest,
            'Failed candidate differs from reviewed caller')
    old = container(captured, 'vayada-next-api')
    require(old['image'] == hold.get('capturedImage') and old['image'].startswith(REPOSITORY + '@'),
            'Captured image differs from hold')
    # This recovery is deliberately unavailable once any private pair is installed.
    for definition in (captured, candidate):
        item = container(definition, 'vayada-next-api')
        env = environment(item)
        require(not any(prefix + '_ORIGIN' in env or prefix + '_INTERNAL_TOKEN' in env or any(
            s['name'] == prefix + '_INTERNAL_TOKEN' for s in item.get('secrets', []))
            for prefix in PREFIX.values()), 'Activated callers cannot use initial recovery')
    require(any(d['taskDefinition'] == target and d['runningCount'] == 1
                and d.get('rolloutState') == 'COMPLETED' for d in public['deployments']),
            'Captured task is no longer the retained running deployment')
    return target


def restore_initial_public(args, public):
    approved(args.image_digest, 'hotel-setup-caller-images.json')
    result = aws('ssm', 'get-parameter', '--name',
                 '/vayada/prod/coordinated-deployments/v1/services/next-target-backend/hold')
    hold = json.loads(result['Parameter']['Value'])
    coordinated.validate_hold(hold, coordinated.load_config(), 'next-target-backend')
    captured = aws('ecs', 'describe-task-definition', '--task-definition', hold['capturedTaskDefinitionArn'])['taskDefinition']
    candidate = aws('ecs', 'describe-task-definition', '--task-definition', args.expected_public_task)['taskDefinition']
    target = initial_restore_target(public, args.expected_public_task, args.image_digest, hold, captured, candidate)
    healthy(public)
    with tempfile.TemporaryDirectory() as directory:
        task_file, image_file = Path(directory, 'task.json'), Path(directory, 'image.json')
        old_digest = container(captured, 'vayada-next-api')['image'].split('@')[1]
        task_file.write_text(json.dumps(captured))
        image_file.write_text(json.dumps(aws('ecr', 'describe-images', '--repository-name', 'vayada-next-api', '--image-ids', 'imageDigest=' + old_digest)))
        subprocess.run(['python3', str(ROOT / 'scripts/assert-next-api-split-compatible-image.py'),
            'next-target-backend', 'vayada-next-api', old_digest, str(image_file), str(task_file)], check=True)
    # Recheck hold and current deployment immediately before restoring the captured task.
    latest = json.loads(aws('ssm', 'get-parameter', '--name',
        '/vayada/prod/coordinated-deployments/v1/services/next-target-backend/hold')['Parameter']['Value'])
    require(latest == hold, 'Recovery hold changed')
    initial_restore_target(service(PUBLIC), args.expected_public_task, args.image_digest, latest, captured, candidate)
    aws('ecs', 'update-service', '--cluster', CLUSTER, '--service', PUBLIC, '--task-definition', target, '--desired-count', '1')
    subprocess.run(['aws', 'ecs', 'wait', 'services-stable', '--cluster', CLUSTER, '--services', PUBLIC, '--region', REGION], check=True)
    final = service(PUBLIC)
    require(stable(final, target), 'Captured API task failed recovery stability')
    healthy(final)
    print(json.dumps({'status': 'PASS', 'service': PUBLIC, 'taskDefinition': target, 'holdRetained': True}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--service', choices=['public', 'creation', 'property'], required=True)
    parser.add_argument('--purpose', choices=['creation', 'property'], required=True)
    parser.add_argument('--state', choices=['hold', 'blocked', 'enabled', 'start', 'restore_initial'], required=True)
    parser.add_argument('--image-digest', required=True)
    parser.add_argument('--expected-public-task', required=True)
    parser.add_argument('--private-task', default='')
    args = parser.parse_args()
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main', 'Reviewed main CI only')
    require(TASK.fullmatch(args.expected_public_task), 'Invalid reviewed public task')
    public = service(PUBLIC)
    if args.state == 'restore_initial':
        require(args.service == 'public' and not args.private_task, 'Recovery is public initial-cutover only')
        restore_initial_public(args, public)
        return
    require(stable(public, args.expected_public_task), 'Public service is not the reviewed stable task')
    current = aws('ecs', 'describe-task-definition', '--task-definition', args.expected_public_task)['taskDefinition']
    if args.service == 'public':
        require(args.state != 'start' and not args.private_task, 'Invalid public release')
        approved(args.image_digest, 'hotel-setup-caller-images.json')
        # Keep the same split-launcher/ongoing-export guard as normal API deployment.
        with tempfile.TemporaryDirectory() as directory:
            task_file, image_file = Path(directory, 'task.json'), Path(directory, 'image.json')
            task_file.write_text(json.dumps(current))
            image_file.write_text(json.dumps(aws('ecr', 'describe-images', '--repository-name', 'vayada-next-api', '--image-ids', 'imageDigest=' + args.image_digest)))
            subprocess.run(['python3', str(ROOT / 'scripts/assert-next-api-split-compatible-image.py'), 'next-target-backend', 'vayada-next-api', args.image_digest, str(image_file), str(task_file)], check=True)
        subprocess.run(['python3', str(ROOT / 'scripts/coordinated_release.py'), 'guard-legacy', '--service', 'next-target-backend', '--event-name', 'workflow_dispatch', '--operation-id', 'setup-' + os.environ['GITHUB_RUN_ID'], '--reason', 'reviewed hotel setup caller release'], check=True)
        token = None
        if args.state == 'enabled':
            private = service(PRIVATE[args.purpose])
            require(stable(private), 'Private service must be healthy before admission')
            healthy(private)
            private_task = aws('ecs', 'describe-task-definition', '--task-definition', private['taskDefinition'])['taskDefinition']
            private_image = container(private_task, 'hotel-setup')['image']
            require(private_image.startswith(REPOSITORY + '@'), 'Private image must be immutable')
            approved(private_image.split('@')[1], 'hotel-setup-command-images.json' if args.purpose == 'creation' else 'hotel-setup-property-images.json')
            token = aws('secretsmanager', 'describe-secret', '--secret-id', SECRET[args.purpose])['ARN']
        definition = prepare_public(current, args.purpose, args.state, args.image_digest, token)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'task.json')
            path.write_text(json.dumps(definition))
            target = aws('ecs', 'register-task-definition', '--cli-input-json', 'file://' + str(path))['taskDefinition']['taskDefinitionArn']
        destination = PUBLIC
    else:
        require(args.service == args.purpose and args.state == 'start' and TASK.fullmatch(args.private_task), 'Invalid private release')
        approved(args.image_digest, 'hotel-setup-command-images.json' if args.service == 'creation' else 'hotel-setup-property-images.json')
        public_image = container(current, 'vayada-next-api')['image']
        require(public_image.startswith(REPOSITORY + '@'), 'Public image must be immutable')
        approved(public_image.split('@')[1], 'hotel-setup-caller-images.json')
        require(environment(container(current, 'vayada-next-api')).get(PREFIX[args.purpose] + '_ADMISSION') == 'blocked', 'Caller admission must be blocked')
        destination = PRIVATE[args.service]
        private = service(destination)
        require(private['desiredCount'] == private['runningCount'] == private['pendingCount'] == 0, 'Private initial start requires zero tasks')
        target = args.private_task
        definition = aws('ecs', 'describe-task-definition', '--task-definition', target)['taskDefinition']
        item = container(definition, 'hotel-setup')
        marker = 'property-' if args.service == 'property' else ''
        require(definition.get('executionRoleArn') == 'arn:aws:iam::269416271598:role/vayada-hotel-setup-' + marker + 'execution' and definition.get('taskRoleArn') == 'arn:aws:iam::269416271598:role/vayada-hotel-setup-' + marker + 'task', 'Wrong private identities')
        require(len(definition['containerDefinitions']) == 1 and item.get('readonlyRootFilesystem') is True and item.get('privileged') is False, 'Unsafe private container')
        injected = item.get('secrets', [])
        require(len(injected) == 2 and {entry['name'] for entry in injected} == {'HOTEL_SETUP_COMMAND_READER_DATABASE_URL', 'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN'}, 'Unexpected private credentials')
        secret_prefix = 'hotel-setup-creation/prod/' if args.service == 'creation' else 'hotel-setup-command/prod/'
        for entry in injected:
            name = 'reader-database-url' if entry['name'].endswith('READER_DATABASE_URL') else 'internal-token'
            require(re.fullmatch(r'arn:aws:secretsmanager:eu-west-1:269416271598:secret:' + re.escape(secret_prefix + name) + r'-[A-Za-z0-9]{6}', entry['valueFrom']), 'Wrong private secret namespace')
        require(environment(item).get('HOTEL_SETUP_COMMAND_SECRET_PREFIX') == ('hotel-setup-command/prod/organization/' if args.service == 'creation' else 'hotel-setup-command/prod/property/'), 'Wrong native secret prefix')
        require(item['image'] == REPOSITORY + '@' + args.image_digest, 'Staged image differs')
        require(environment(item).get('HOTEL_SETUP_COMMAND_MODE') == ('property_creation' if args.service == 'creation' else 'property_commands'), 'Wrong private mode')
        require(definition['family'] in (('vayada-hotel-setup-primary', 'vayada-hotel-setup-rollback') if args.service == 'creation' else ('vayada-hotel-setup-property-primary', 'vayada-hotel-setup-property-rollback')), 'Wrong staged family')
    # Recheck immediately before the only service mutation.
    require(stable(service(PUBLIC), args.expected_public_task), 'Public task changed before release')
    aws('ecs', 'update-service', '--cluster', CLUSTER, '--service', destination, '--task-definition', target, '--desired-count', '1')
    subprocess.run(['aws', 'ecs', 'wait', 'services-stable', '--cluster', CLUSTER, '--services', destination, '--region', REGION], check=True)
    final = service(destination)
    require(stable(final, target), 'Selected service failed stability; admission remains unconfirmed')
    healthy(final)
    print(json.dumps({'status':'PASS', 'service':destination, 'taskDefinition':target, 'admission':args.state}))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError, ValueError, KeyError):
        raise SystemExit('Setup release failed; inspect service state before retrying')
