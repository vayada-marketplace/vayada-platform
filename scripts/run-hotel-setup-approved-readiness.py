#!/usr/bin/env python3
"""Protected offline inspect/apply of the two reviewed legacy readiness bindings."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('offline_gate', ROOT / 'scripts/assert-hotel-setup-online-readiness.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
release = gate.release
CLUSTER = 'vayada-target-database-runtime-preflight'
CLUSTER_ARN = gate.CLUSTER_ARN.replace(release.CLUSTER, CLUSTER)
TASK_ARN = re.compile(r'arn:aws:ecs:eu-west-1:269416271598:task/' + CLUSTER + r'/[a-f0-9]{32}')
FAMILY = 'vayada-next-api-db-runtime-preflight'
CONTAINER = 'hotel-setup-approved-readiness'
TAGS = [{'key': 'VayadaPurpose', 'value': 'hotel-setup-approved-readiness'}]
ROLE = gate.ACCOUNT + 'vayada-hotel-setup-creation-bootstrap'
EXECUTION = gate.ACCOUNT + 'vayada-hotel-setup-property-bootstrap-execution'
CA = ROOT / 'rehearsal/rds-ca-rsa2048-g1.pem'
CA_HASH = 'f5c5f92ae025987c76dc49bdb1ace8556fdf332b4788d719a923bc274779d869'
COMMAND = ["umask 077; printf '%s' \"$HOTEL_SETUP_RDS_CA\" > /runtime/rds-ca.pem; unset HOTEL_SETUP_RDS_CA; exec node /app/apps/api/dist/cli/hotelSetupApprovedReadinessBackfill.js"]
BINDINGS = [
    ('6a717155-a188-45f3-87e5-5c8408f41a87', 'b9eec40b-2e2d-4ff1-b3d4-6d6e03bb58d9', 'vayada_next_hotel_setup_org_c0be02f6ee4d481aadb8c7eca98d74c1'),
    ('2734e584-022d-432a-9637-ccb0cce59c53', 'a729d719-2297-4be7-8f7a-12bdf87da1b3', 'vayada_next_hotel_setup_org_74adc91d74b84f11bacdf2b961cc8438'),
]


def aws(*args):
    result = subprocess.run(['aws', *args, '--region', release.REGION, '--output', 'json',
        '--no-paginate', '--cli-connect-timeout', '5', '--cli-read-timeout', '15'], capture_output=True, text=True, timeout=25,
        env={**os.environ, 'AWS_MAX_ATTEMPTS': '1', 'AWS_RETRY_MODE': 'standard'})
    release.require(result.returncode == 0, 'Offline AWS call failed')
    return json.loads(result.stdout or '{}')


def unique_object(pairs):
    result = dict(pairs)
    release.require(len(result) == len(pairs), 'Ambiguous receipt fields')
    return result


def approved_image(digest):
    inventory = json.loads((ROOT / 'deployment/hotel-setup-approved-readiness-images.json').read_text(), object_pairs_hook=unique_object)
    proof = inventory.get(digest)
    release.require(re.fullmatch(r'sha256:[a-f0-9]{64}', digest) and isinstance(proof, dict)
        and set(proof) == {'source', 'primarySource', 'rollbackSource'}
        and all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{40}', value) for value in proof.values()),
        'Image lacks reviewed approved-readiness dual native proof')
    return proof


def physically_stopped(cluster, selector, name, container_name=None):
    pattern = gate.TASK_ARN if cluster == release.CLUSTER else TASK_ARN
    cluster_arn = gate.CLUSTER_ARN if cluster == release.CLUSTER else CLUSTER_ARN
    for status in ('RUNNING', 'STOPPED'):
        result = aws('ecs', 'list-tasks', '--cluster', cluster, selector, name, '--desired-status', status)
        arns = result.get('taskArns', [])
        release.require(not result.get('nextToken') and len(arns) <= 100 and len(set(arns)) == len(arns)
            and all(pattern.fullmatch(arn) for arn in arns), 'Cannot bound stopped task history')
        if not arns:
            continue
        result = aws('ecs', 'describe-tasks', '--cluster', cluster, '--tasks', *arns)
        tasks = result.get('tasks', [])
        group = ('service:' if selector == '--service-name' else 'family:') + name
        release.require(not result.get('failures') and len(tasks) == len(arns)
            and {task.get('taskArn') for task in tasks} == set(arns)
            and all(task.get('clusterArn') == cluster_arn and task.get('group') == group
                and task.get('lastStatus') == 'STOPPED' for task in tasks), 'An earlier task is still physical')
        if container_name:
            for task in tasks:
                overrides = task.get('overrides', {})
                release.require(set(overrides) <= {'containerOverrides', 'inferenceAcceleratorOverrides'}
                    and overrides.get('inferenceAcceleratorOverrides', []) == [] and all(set(item) <= {'name'}
                    and item.get('name') == container_name for item in overrides.get('containerOverrides', [])),
                    'Stopped private history has runtime or identity overrides')


def public_startup(definition):
    item = release.container(definition, 'vayada-next-api')
    release.require(definition.get('family') == 'vayada-next-api' and len(definition['containerDefinitions']) == 1
        and definition.get('taskRoleArn') == gate.ACCOUNT + 'vayada-next-api-media-task-role'
        and item.get('entryPoint') in (None, []) and item.get('workingDirectory') in (None, '', '/app')
        and not item.get('privileged') and not definition.get('volumes') and not item.get('mountPoints')
        and not item.get('volumesFrom') and not item.get('environmentFiles'), 'Public startup identity or code mounts differ')
    environment = release.environment(item)
    secrets = item.get('secrets', [])
    names = [entry['name'] for entry in secrets]
    release.require(len(names) == len(set(names)) and not set(names).intersection(environment), 'Public injected environment is ambiguous')
    for name in set(environment) | set(names):
        release.require(name not in {'NODE_OPTIONS', 'NODE_PATH', 'API_RUNTIME', 'PATH', 'ENV', 'BASH_ENV',
            'SHELLOPTS', 'IFS', 'CDPATH', 'NODE_EXTRA_CA_CERTS', 'FINANCE_EXPORT_RDS_CA', 'FINANCE_EXPORT_WORKER_ENABLED'}
            or name in {'NODE_EXTRA_CA_CERTS', 'FINANCE_EXPORT_RDS_CA', 'FINANCE_EXPORT_WORKER_ENABLED'} and name in environment,
            'Public startup controls must remain canonical')
        release.require(not name.startswith('LD_') and not name.lower().startswith('npm_config_'), 'Public loader or npm startup control is forbidden')
    release.require(environment.get('NODE_ENV') == 'production' and environment.get('FINANCE_EXPORT_WORKER_ENABLED') in ('true', 'false'),
        'Public startup environment differs')
    if environment['FINANCE_EXPORT_WORKER_ENABLED'] == 'true':
        release.require(item.get('command') == ['sh', '-c', "umask 077; printf '%s' \"$FINANCE_EXPORT_RDS_CA\" > \"$NODE_EXTRA_CA_CERTS\" && exec ./scripts/start-next-api.sh"]
            and environment.get('NODE_EXTRA_CA_CERTS') == '/tmp/finance-export-rds-ca.pem'
            and environment.get('FINANCE_EXPORT_RDS_CA') == CA.read_text(), 'Public finance CA launcher differs')
    else:
        release.require(item.get('command') in (None, [], ['./scripts/start-next-api.sh'])
            and 'NODE_EXTRA_CA_CERTS' not in environment and 'FINANCE_EXPORT_RDS_CA' not in environment,
            'Public default launcher differs')


def snapshot(expected):
    public = release.service(release.PUBLIC)
    release.require(release.TASK.fullmatch(expected) and release.stable(public, expected), 'Public caller must be the reviewed stable task')
    definition = aws('ecs', 'describe-task-definition', '--task-definition', expected)['taskDefinition']
    release.require(definition.get('taskDefinitionArn') == expected, 'Public task definition differs')
    public_startup(definition)
    item = release.container(definition, 'vayada-next-api')
    image = item['image']
    release.require(image.startswith(release.REPOSITORY + '@'), 'Public caller must be immutable')
    digest = image.split('@')[1]
    release.require(image == release.REPOSITORY + '@' + digest, 'Public caller image reference is ambiguous')
    release.approved(digest, 'hotel-setup-caller-images.json')
    environment = release.environment(item)
    for purpose in release.PRIVATE:
        release.require(environment.get(release.PREFIX[purpose] + '_ADMISSION') == 'blocked', 'Both caller admissions must be blocked')
        release.prepare_public(definition, purpose, 'blocked', digest)
    arn = gate.physical_tasks(release.PUBLIC, definition, 'vayada-next-api')
    release.healthy(public)
    captured = {'publicTask': expected, 'publicTaskArn': arn, 'private': {}, 'network': public['networkConfiguration']}
    for purpose, name in release.PRIVATE.items():
        state = release.service(name)
        release.require(state['desiredCount'] == state['runningCount'] == state['pendingCount'] == 0
            and release.TASK.fullmatch(state['taskDefinition']) and len(state['deployments']) == 1
            and state['deployments'][0].get('status') == 'PRIMARY'
            and state['deployments'][0].get('rolloutState') == 'COMPLETED', 'Both private services must be stopped and settled')
        physically_stopped(release.CLUSTER, '--service-name', name, 'hotel-setup')
        release.require(release.service(name) == state, 'Stopped private service changed during inspection')
        captured['private'][purpose] = state['taskDefinition']
    release.require(release.stable(release.service(release.PUBLIC), expected), 'Public service changed during inspection')
    return captured


def oid(value):
    return type(value) is int and 0 < value <= 4294967295


def inspection(value):
    release.require(isinstance(value, dict) and set(value) == {'organizations', 'readers'}, 'Invalid frozen inspection')
    organizations = value['organizations']
    release.require(isinstance(organizations, list) and len(organizations) == len(BINDINGS), 'Exactly two approved organizations required')
    for item, binding in zip(organizations, BINDINGS):
        release.require(isinstance(item, dict) and set(item) == {'organizationId', 'actorUserId', 'login', 'expectedRoleOid', 'secretVersion'}
            and tuple(item.get(key) for key in ('organizationId', 'actorUserId', 'login')) == binding
            and oid(item['expectedRoleOid']) and isinstance(item['secretVersion'], str)
            and re.fullmatch(r'[A-Za-z0-9-]{32,64}', item['secretVersion']), 'Inspection must match each exact approved binding and immutable version')
    readers = value['readers']
    release.require(isinstance(readers, dict) and set(readers) == {'expectedCreationReaderOid', 'expectedPropertyReaderOid'}
        and all(oid(value) for value in readers.values()), 'Inspection must pin both reader identities')
    identities = [item['expectedRoleOid'] for item in organizations] + list(readers.values())
    release.require(len(set(identities)) == 4, 'All four inspected role identities must be distinct')
    return value


def definition(mode, digest, frozen=None):
    release.require(mode in ('inspect', 'apply', 'diagnose') and (mode == 'apply' or frozen is None), 'Invalid offline operation')
    ca = CA.read_bytes()
    release.require(hashlib.sha256(ca).hexdigest() == CA_HASH, 'Pinned offline CA differs')
    environment = {'NODE_ENV': 'production', 'AWS_REGION': release.REGION,
        'HOTEL_SETUP_APPROVED_READINESS_MODE': 'inspect' if mode == 'diagnose' else mode, 'HOTEL_SETUP_RDS_CA': ca.decode('ascii'),
        'NODE_EXTRA_CA_CERTS': '/runtime/rds-ca.pem'}
    if mode == 'apply':
        environment['HOTEL_SETUP_APPROVED_READINESS_INSPECTION'] = json.dumps(inspection(frozen), separators=(',', ':'))
    command = COMMAND
    if mode == 'diagnose':
        program = (ROOT / 'scripts/diagnose-hotel-setup-approved-readiness.mjs').read_text()
        command = [COMMAND[0].split('exec node')[0] + "exec node --input-type=module - <<'DIAGNOSTIC'\n" + program + '\nDIAGNOSTIC']
    return {'family': FAMILY, 'tags': TAGS, 'taskRoleArn': ROLE, 'executionRoleArn': EXECUTION,
        'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], 'cpu': '256', 'memory': '512',
        'runtimePlatform': {'cpuArchitecture': 'X86_64', 'operatingSystemFamily': 'LINUX'},
        'volumes': [{'name': 'runtime'}], 'containerDefinitions': [{
            'name': CONTAINER, 'essential': True, 'image': release.REPOSITORY + '@' + digest,
            'workingDirectory': '/app', 'entryPoint': ['/bin/sh', '-ec'], 'command': command,
            'readonlyRootFilesystem': True, 'privileged': False, 'stopTimeout': 30,
            'mountPoints': [{'sourceVolume': 'runtime', 'containerPath': '/runtime', 'readOnly': False}],
            'secrets': [{'name': 'HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}],
            'environment': [{'name': key, 'value': value} for key, value in environment.items()],
            'logConfiguration': {'logDriver': 'awslogs', 'options': {'awslogs-group': '/ecs/vayada-next-api',
                'awslogs-region': release.REGION, 'awslogs-stream-prefix': 'hotel-setup-approved-readiness-' + mode}},
        }]}


def task_state(arn, registered, attempt):
    release.require(isinstance(arn, str) and TASK_ARN.fullmatch(arn), 'Offline task identity is invalid')
    result = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', arn, '--include', 'TAGS')
    tasks = result.get('tasks', [])
    release.require(not result.get('failures') and len(tasks) == 1, 'Offline task is missing')
    task = tasks[0]
    release.require(task.get('taskArn') == arn and task.get('taskDefinitionArn') == registered
        and task.get('clusterArn') == CLUSTER_ARN and task.get('group') == 'family:' + FAMILY
        and task.get('startedBy') == attempt and task.get('tags') == TAGS, 'Offline task scope differs')
    overrides = task.get('overrides', {})
    release.require(set(overrides) <= {'containerOverrides', 'inferenceAcceleratorOverrides'}
        and overrides.get('inferenceAcceleratorOverrides', []) == [] and all(set(item) <= {'name'}
        and item.get('name') == CONTAINER for item in overrides.get('containerOverrides', [])), 'Offline task has effective overrides')
    return task


def stop_exact(arn, registered, attempt):
    if task_state(arn, registered, attempt).get('lastStatus') == 'STOPPED':
        return
    aws('ecs', 'stop-task', '--cluster', CLUSTER, '--task', arn, '--reason', 'Approved readiness bounded task cleanup')
    for _ in range(20):
        if task_state(arn, registered, attempt).get('lastStatus') == 'STOPPED':
            return
        time.sleep(2)
    raise RuntimeError('Offline physical stop requires inspection')


def apply_receipt(value, frozen):
    release.require(set(value) == {'status', 'mode', 'organizations', 'readers'}, 'Unexpected apply receipt fields')
    organizations = value['organizations']
    release.require(isinstance(organizations, list) and len(organizations) == len(BINDINGS), 'Apply must report both approved organizations')
    for item, expected in zip(organizations, frozen['organizations']):
        release.require(isinstance(item, dict) and set(item) == {'status', 'organizationId', 'login', 'roleOid', 'secretVersion'}
            and item['status'] in ('ready', 'already_ready', 'ready_commit_inspected') and oid(item['roleOid'])
            and all(item[key] == expected[source] for key, source in [('organizationId', 'organizationId'),
                ('login', 'login'), ('roleOid', 'expectedRoleOid'), ('secretVersion', 'secretVersion')]),
            'Apply organization receipt differs from frozen inspection')
    readers = value['readers']
    release.require(isinstance(readers, dict) and set(readers) == {'status', 'readers'}
        and readers['status'] in ('granted', 'grant_commit_inspected') and isinstance(readers['readers'], list)
        and len(readers['readers']) == 2, 'Apply reader receipt is invalid')
    for item, (login, relation, key) in zip(readers['readers'], [
            ('vayada_next_hotel_setup_creation_reader', 'platform.hotel_setup_creation_scopes', 'expectedCreationReaderOid'),
            ('vayada_next_hotel_setup_reader', 'platform.hotel_setup_property_scopes', 'expectedPropertyReaderOid')]):
        release.require(isinstance(item, dict) and oid(item.get('roleOid'))
            and item == {'login': login, 'relation': relation, 'roleOid': frozen['readers'][key],
            'columns': ['credential_role_oid', 'credential_secret_version', 'credential_ready_at']},
            'Apply reader receipt differs from frozen inspection')


def diagnostic_receipt(value):
    release.require(set(value) == {'status', 'mode', 'inspectionStatus', 'phase', 'rowCount', 'sqlState'}
        and value['status'] == 'PASS' and value['mode'] == 'diagnose'
        and value['inspectionStatus'] in ('PASS', 'FAIL')
        and isinstance(value['phase'], str)
        and re.fullmatch(r'configuration|connection|complete|query_[0-9]{2}', value['phase'])
        and (value['rowCount'] is None or type(value['rowCount']) is int and 0 <= value['rowCount'] <= 100)
        and (value['sqlState'] is None or isinstance(value['sqlState'], str)
            and re.fullmatch(r'[0-9A-Z]{5}', value['sqlState'])), 'Invalid diagnostic receipt')


def receipt(task, mode, frozen):
    stream = 'hotel-setup-approved-readiness-' + mode + '/' + CONTAINER + '/' + task.rsplit('/', 1)[1]
    for _ in range(10):
        events = aws('logs', 'get-log-events', '--log-group-name', '/ecs/vayada-next-api', '--log-stream-name', stream,
            '--start-from-head', '--limit', '200').get('events', [])
        release.require(len(events) < 200 and sum(len(event['message']) for event in events) <= 8192, 'Offline receipt is unbounded')
        messages = [event['message'].strip() for event in events if event['message'].strip()]
        if messages:
            release.require(len(messages) == 1, 'Offline task must emit exactly one receipt')
            value = json.loads(messages[0], object_pairs_hook=unique_object)
            release.require(value.get('status') == 'PASS' and value.get('mode') == mode, 'Offline task did not report completion')
            if mode == 'inspect':
                release.require(set(value) == {'status', 'mode', 'inspection'}, 'Unexpected inspection receipt fields')
                inspection(value['inspection'])
            elif mode == 'diagnose':
                diagnostic_receipt(value)
            else:
                apply_receipt(value, frozen)
            return value
        time.sleep(2)
    raise RuntimeError('Offline completion receipt requires inspection')


def run_pass(mode, digest, expected, captured, attempt, frozen=None):
    registered = task = None
    run_attempted = completed = False
    try:
        physically_stopped(CLUSTER, '--family', FAMILY)
        registered = aws('ecs', 'register-task-definition', '--cli-input-json', json.dumps(definition(mode, digest, frozen)))['taskDefinition']['taskDefinitionArn']
        release.require(release.TASK.fullmatch(registered) and registered.split('/')[-1].startswith(FAMILY + ':'), 'Registered offline family differs')
        release.require(snapshot(expected) == captured, 'Offline gates changed before task start')
        run_attempted = True
        result = aws('ecs', 'run-task', '--cluster', CLUSTER, '--task-definition', registered,
            '--launch-type', 'FARGATE', '--count', '1', '--network-configuration', json.dumps(captured['network']),
            '--client-token', attempt, '--started-by', attempt, '--tags', json.dumps(TAGS))
        tasks = result.get('tasks', [])
        if len(tasks) == 1:
            task = tasks[0].get('taskArn')
        release.require(task and not result.get('failures'), 'Offline RunTask is uncertain')
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            state = task_state(task, registered, attempt)
            release.require(snapshot(expected) == captured, 'Offline gates changed during task writes')
            if state.get('lastStatus') == 'STOPPED':
                containers = state.get('containers', [])
                release.require(len(containers) == 1 and containers[0].get('name') == CONTAINER and containers[0].get('exitCode') == 0
                    and containers[0].get('image') == release.REPOSITORY + '@' + digest
                    and containers[0].get('imageDigest') == digest, 'Offline task did not complete with the reviewed image')
                value = receipt(task, mode, frozen)
                release.require(snapshot(expected) == captured, 'Offline gates changed after task receipt')
                completed = True
                return value, {'taskArn': task, 'taskDefinition': registered}
            time.sleep(3)
        raise RuntimeError('Offline pass deadline expired')
    finally:
        uncertain = run_attempted and not task
        cleanup_complete = False
        try:
            if uncertain:
                found = []
                for status in ('RUNNING', 'STOPPED'):
                    result = aws('ecs', 'list-tasks', '--cluster', CLUSTER, '--family', FAMILY, '--desired-status', status)
                    arns = result.get('taskArns', [])
                    release.require(not result.get('nextToken') and len(arns) <= 100 and len(set(arns)) == len(arns)
                        and all(TASK_ARN.fullmatch(arn) for arn in arns), 'Lost task response cannot be bounded')
                    if arns:
                        observed = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', *arns, '--include', 'TAGS')
                        release.require(not observed.get('failures') and len(observed.get('tasks', [])) == len(arns)
                            and {item.get('taskArn') for item in observed['tasks']} == set(arns), 'Lost task response is ambiguous')
                        found.extend(item['taskArn'] for item in observed['tasks'] if item.get('startedBy') == attempt)
                release.require(len(set(found)) <= 1, 'Multiple exact-attempt tasks require inspection')
                if found:
                    task = found[0]
            if task:
                stop_exact(task, registered, attempt)
            cleanup_complete = True
            if uncertain:
                raise RuntimeError('Lost offline response requires inspection; no retry')
        finally:
            if not completed or uncertain or not cleanup_complete:
                print(json.dumps({'status': 'FAIL', 'mode': mode, 'attempt': attempt, 'inspectionRequired': True,
                    'candidateTaskArn': task if isinstance(task, str) and TASK_ARN.fullmatch(task) else None,
                    'taskDefinition': registered if isinstance(registered, str) and release.TASK.fullmatch(registered) else None}), file=sys.stderr)


def run(mode, digest, expected, identity):
    proof = approved_image(digest)
    captured = snapshot(expected)
    if mode == 'diagnose':
        attempt = hashlib.sha256((identity + ':diagnose').encode()).hexdigest()[:32]
        value, observed = run_pass('diagnose', digest, expected, captured, attempt)
        release.require(snapshot(expected) == captured, 'Offline gates changed after diagnosis')
        return {**value, 'imageDigest': digest, 'proof': proof, 'capturedGates': captured, 'tasks': {'diagnose': observed}}
    attempt = hashlib.sha256((identity + ':inspect').encode()).hexdigest()[:32]
    value, observed = run_pass('inspect', digest, expected, captured, attempt)
    frozen = json.loads(json.dumps(inspection(value['inspection'])))
    receipt_hash = hashlib.sha256(json.dumps(frozen, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    tasks = {'inspect': observed}
    if mode == 'apply':
        release.require(snapshot(expected) == captured, 'Offline gates changed between inspect and apply')
        attempt = hashlib.sha256((identity + ':apply').encode()).hexdigest()[:32]
        value, tasks['apply'] = run_pass('apply', digest, expected, captured, attempt, frozen)
    release.require(snapshot(expected) == captured, 'Offline gates changed after both tasks')
    return {**value, 'imageDigest': digest, 'proof': proof, 'inspectionSha256': receipt_hash,
        'capturedGates': captured, 'tasks': tasks}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['inspect', 'apply', 'diagnose'], required=True)
    parser.add_argument('--image-digest', required=True)
    parser.add_argument('--expected-public-task', required=True)
    args = parser.parse_args()
    try:
        release.require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
            and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
            and os.environ.get('GITHUB_REPOSITORY') == 'vayada-marketplace/vayada-platform', 'Protected main manual CI only')
        identity = os.environ['GITHUB_RUN_ID'] + ':' + os.environ['GITHUB_RUN_ATTEMPT']
        release.require(re.fullmatch(r'[1-9][0-9]*:[1-9][0-9]*', identity), 'Invalid workflow identity')
        release.aws = aws
        print(json.dumps(run(args.mode, args.image_digest, args.expected_public_task, identity)))
    except Exception:
        raise SystemExit('Approved offline readiness failed; inspect exact tasks before retrying') from None
