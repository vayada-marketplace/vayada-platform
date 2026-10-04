#!/usr/bin/env python3
"""Bounded main-CI operational pass; never stop or update a serving service."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('online_gate', ROOT / 'scripts/assert-hotel-setup-online-readiness.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
release = gate.release
EXECUTION = gate.ACCOUNT + 'vayada-hotel-setup-property-bootstrap-execution'
ROLES = {'organization': gate.ACCOUNT + 'vayada-hotel-setup-creation-bootstrap',
         'property': gate.ACCOUNT + 'vayada-hotel-setup-property-bootstrap'}
FAMILIES = {mode: 'vayada-hotel-setup-online-' + mode for mode in ROLES}
CA = ROOT / 'rehearsal/rds-ca-rsa2048-g1.pem'
CA_HASH = 'f5c5f92ae025987c76dc49bdb1ace8556fdf332b4788d719a923bc274779d869'
COMMAND = ["umask 077; printf '%s' \"$HOTEL_SETUP_RDS_CA\" > /runtime/rds-ca.pem; unset HOTEL_SETUP_RDS_CA; exec node apps/api/dist/cli/hotelSetupAutomaticProvisioning.js"]


def aws(*args):
    result = subprocess.run(['aws', *args, '--region', release.REGION, '--output', 'json',
        '--cli-connect-timeout', '5', '--cli-read-timeout', '15'], capture_output=True, text=True, timeout=25,
        env={**os.environ, 'AWS_MAX_ATTEMPTS': '1', 'AWS_RETRY_MODE': 'standard'})
    release.require(result.returncode == 0, 'Operational AWS call failed')
    return json.loads(result.stdout or '{}')


def operational_image(inventory):
    images = inventory.get('operational', {})
    release.require(len(images) == 1, 'Exactly one reviewed operational image is required')
    digest, proof = next(iter(images.items()))
    release.require(re.fullmatch(r'sha256:[a-f0-9]{64}', digest) is not None
                    and isinstance(proof, dict) and set(proof) == {'source', 'primarySource', 'rollbackSource'}
                    and all(re.fullmatch(r'[a-f0-9]{40}', value) is not None for value in proof.values()),
                    'Operational image lacks reviewed dual native proof')
    return digest


def quiet():
    for family in FAMILIES.values():
        for status in ('RUNNING', 'STOPPED'):
            result = aws('ecs', 'list-tasks', '--cluster', release.CLUSTER, '--family', family, '--desired-status', status)
            arns = result.get('taskArns', [])
            release.require(not result.get('nextToken') and len(arns) <= 100
                            and len(arns) == len(set(arns)) and all(gate.TASK_ARN.fullmatch(arn) for arn in arns),
                            'Cannot bound operational task history')
            if arns:
                result = aws('ecs', 'describe-tasks', '--cluster', release.CLUSTER, '--tasks', *arns)
                tasks = result.get('tasks', [])
                release.require(not result.get('failures') and len(tasks) == len(arns)
                                and {task.get('taskArn') for task in tasks} == set(arns)
                                and all(task.get('clusterArn') == gate.CLUSTER_ARN
                                    and task.get('group') == 'family:' + family and task.get('lastStatus') == 'STOPPED'
                                    for task in tasks), 'An earlier operational task is still physical')


def definition(mode, digest):
    ca = CA.read_bytes()
    release.require(hashlib.sha256(ca).hexdigest() == CA_HASH, 'Pinned operational CA differs')
    return {'family': FAMILIES[mode], 'taskRoleArn': ROLES[mode], 'executionRoleArn': EXECUTION,
        'networkMode': 'awsvpc', 'requiresCompatibilities': ['FARGATE'], 'cpu': '256', 'memory': '512',
        'runtimePlatform': {'cpuArchitecture': 'X86_64', 'operatingSystemFamily': 'LINUX'},
        'volumes': [{'name': 'runtime'}], 'containerDefinitions': [{
            'name': 'hotel-setup-online', 'essential': True, 'image': release.REPOSITORY + '@' + digest,
            'workingDirectory': '/app', 'entryPoint': ['/bin/sh', '-ec'], 'command': COMMAND,
            'readonlyRootFilesystem': True, 'privileged': False, 'stopTimeout': 30,
            'mountPoints': [{'sourceVolume': 'runtime', 'containerPath': '/runtime', 'readOnly': False}],
            'secrets': [{'name': 'HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL', 'valueFrom': '/vayada/prod/db-marketplace-url'}],
            'environment': [{'name': key, 'value': value} for key, value in {
                'NODE_ENV': 'production', 'AWS_REGION': release.REGION, 'HOTEL_SETUP_AUTOMATIC_MODE': mode,
                'HOTEL_SETUP_RDS_CA': ca.decode('ascii'), 'NODE_EXTRA_CA_CERTS': '/runtime/rds-ca.pem',
            }.items()],
            'logConfiguration': {'logDriver': 'awslogs', 'options': {
                'awslogs-group': '/ecs/vayada-next-api', 'awslogs-region': release.REGION,
                'awslogs-stream-prefix': 'hotel-setup-online-' + mode}},
        }]}


def task_state(arn, registered, attempt, mode):
    release.require(gate.TASK_ARN.fullmatch(arn), 'Operational task identity is invalid')
    result = aws('ecs', 'describe-tasks', '--cluster', release.CLUSTER, '--tasks', arn)
    tasks = result.get('tasks', [])
    release.require(not result.get('failures') and len(tasks) == 1, 'Operational task is missing')
    task = tasks[0]
    release.require(task.get('taskArn') == arn and task.get('taskDefinitionArn') == registered
                    and task.get('clusterArn') == gate.CLUSTER_ARN and task.get('startedBy') == attempt
                    and task.get('group') == 'family:' + FAMILIES[mode], 'Operational task scope differs')
    return task


def stop_exact(arn, registered, attempt, mode):
    task = task_state(arn, registered, attempt, mode)
    if task.get('lastStatus') != 'STOPPED':
        aws('ecs', 'stop-task', '--cluster', release.CLUSTER, '--task', arn,
            '--reason', 'Bounded automatic credential pass cleanup')
        for _ in range(20):
            if task_state(arn, registered, attempt, mode).get('lastStatus') == 'STOPPED':
                return
            time.sleep(2)
        raise RuntimeError('Operational task stop requires inspection')


def run(mode, inventory, attempt):
    digest = operational_image(inventory)
    captured = gate.snapshot(inventory)
    quiet()
    network = release.service(release.PUBLIC)['networkConfiguration']
    registered = task = None
    run_attempted = False
    inspection = False
    try:
        registered = aws('ecs', 'register-task-definition', '--cli-input-json', json.dumps(definition(mode, digest)))['taskDefinition']['taskDefinitionArn']
        release.require(release.TASK.fullmatch(registered) and registered.split('/')[-1].startswith(FAMILIES[mode] + ':'),
                        'Registered operational family differs')
        release.require(gate.snapshot(inventory) == captured, 'Serving tasks changed before operational writes')
        quiet()
        run_attempted = True
        result = aws('ecs', 'run-task', '--cluster', release.CLUSTER, '--task-definition', registered,
            '--launch-type', 'FARGATE', '--count', '1', '--network-configuration', json.dumps(network),
            '--client-token', attempt, '--started-by', attempt)
        tasks = result.get('tasks', [])
        if len(tasks) == 1:
            task = tasks[0].get('taskArn')
        release.require(task and not result.get('failures'), 'Operational RunTask is uncertain')
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            state = task_state(task, registered, attempt, mode)
            if state.get('lastStatus') == 'STOPPED':
                containers = state.get('containers', [])
                release.require(len(containers) == 1 and containers[0].get('name') == 'hotel-setup-online'
                                and containers[0].get('exitCode') == 0, 'Operational pass did not complete')
                release.require(gate.snapshot(inventory) == captured, 'Serving tasks changed during operational writes')
                return {'status': 'PASS', 'mode': mode, 'taskArn': task, 'imageDigest': digest}
            release.require(gate.snapshot(inventory) == captured, 'Serving tasks changed during operational writes')
            time.sleep(3)
        raise RuntimeError('Operational pass deadline expired')
    finally:
        if run_attempted and not task:
            inspection = True
            found = aws('ecs', 'list-tasks', '--cluster', release.CLUSTER, '--started-by', attempt)
            arns = found.get('taskArns', [])
            if not found.get('nextToken') and len(arns) == 1:
                task = arns[0]
        if task:
            stop_exact(task, registered, attempt, mode)
        if registered and not inspection:
            aws('ecs', 'deregister-task-definition', '--task-definition', registered)
        if inspection:
            raise RuntimeError('Lost operational response requires inspection; no retry')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=list(ROLES), required=True)
    args = parser.parse_args()
    try:
        release.require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main', 'Reviewed main CI only')
        identity = os.environ['GITHUB_RUN_ID'] + ':' + os.environ['GITHUB_RUN_ATTEMPT'] + ':' + args.mode
        release.require(re.fullmatch(r'[1-9][0-9]*:[1-9][0-9]*:(organization|property)', identity), 'Invalid workflow identity')
        release.aws = aws
        inventory = json.loads((ROOT / 'deployment/hotel-setup-online-images.json').read_text())
        print(json.dumps(run(args.mode, inventory, hashlib.sha256(identity.encode()).hexdigest()[:32])))
    except Exception:
        raise SystemExit('Automatic hotel setup pass failed; inspect this workflow before retrying') from None
