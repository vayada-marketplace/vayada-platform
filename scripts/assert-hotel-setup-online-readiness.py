#!/usr/bin/env python3
"""Read-only gate for the separate online provisioner; never update a service."""
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup_release', ROOT / 'scripts/release-hotel-setup.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ACCOUNT = 'arn:aws:iam::269416271598:role/'
CLUSTER_ARN = 'arn:aws:ecs:eu-west-1:269416271598:cluster/' + release.CLUSTER
TASK_ARN = re.compile(r'arn:aws:ecs:eu-west-1:269416271598:task/' + release.CLUSTER + r'/[a-f0-9]{32}')
ENTRY_POINT = ['/bin/sh', '-ec']
COMMAND = ["umask 077; printf '%s' \"$HOTEL_SETUP_RDS_CA\" > /runtime/rds-ca.pem; unset HOTEL_SETUP_RDS_CA; exec node apps/api/dist/hotelSetupCommandServer.js"]


def approved(image, purpose, inventory):
    prefix = release.REPOSITORY + '@'
    release.require(image.startswith(prefix), 'Online image must be immutable')
    digest = image[len(prefix):]
    release.require(re.fullmatch(r'sha256:[a-f0-9]{64}', digest) is not None
                    and re.fullmatch(r'[a-f0-9]{40}', inventory.get(purpose, {}).get(digest, '')) is not None,
                    'Image has no reviewed online readiness proof')
    return digest


def physical_tasks(name, definition, container_name='hotel-setup'):
    running = release.aws('ecs', 'list-tasks', '--cluster', release.CLUSTER,
                          '--service-name', name, '--desired-status', 'RUNNING')
    arns = running.get('taskArns', [])
    release.require(not running.get('nextToken') and len(arns) == 1
                    and TASK_ARN.fullmatch(arns[0]), 'Expected one physical private task')
    observed = release.aws('ecs', 'describe-tasks', '--cluster', release.CLUSTER, '--tasks', *arns)
    release.require(not observed.get('failures') and len(observed.get('tasks', [])) == 1,
                    'Physical private task is missing')
    task = observed['tasks'][0]
    release.require(task.get('taskArn') == arns[0] and task.get('taskDefinitionArn') == definition['taskDefinitionArn']
                    and task.get('clusterArn') == CLUSTER_ARN and task.get('group') == 'service:' + name
                    and task.get('desiredStatus') == task.get('lastStatus') == 'RUNNING',
                    'Physical private task differs from the serving definition')
    task_overrides = task.get('overrides', {})
    release.require(set(task_overrides) <= {'containerOverrides'}, 'Private task has identity or runtime overrides')
    overrides = task_overrides.get('containerOverrides', [])
    release.require(all(set(item) <= {'name'} and item.get('name') == container_name for item in overrides),
                    'Private startup has effective command or environment overrides')
    containers = task.get('containers', [])
    release.require(len(containers) == 1 and containers[0].get('name') == container_name
                    and containers[0].get('image') == release.container(definition, container_name)['image']
                    and containers[0].get('imageDigest') == containers[0]['image'].split('@')[1],
                    'Observed private image differs')
    # A desired-STOPPED task may still be physically RUNNING during draining.
    history = release.aws('ecs', 'list-tasks', '--cluster', release.CLUSTER,
                          '--service-name', name, '--desired-status', 'STOPPED')
    stopped = history.get('taskArns', [])
    release.require(not history.get('nextToken') and len(stopped) <= 100
                    and len(set(stopped)) == len(stopped) and all(TASK_ARN.fullmatch(arn) for arn in stopped),
                    'Cannot bound private draining history')
    if stopped:
        result = release.aws('ecs', 'describe-tasks', '--cluster', release.CLUSTER, '--tasks', *stopped)
        tasks = result.get('tasks', [])
        release.require(not result.get('failures') and len(tasks) == len(stopped)
                        and {item.get('taskArn') for item in tasks} == set(stopped)
                        and all(item.get('lastStatus') == 'STOPPED' and item.get('clusterArn') == CLUSTER_ARN
                                and item.get('group') == 'service:' + name for item in tasks),
                        'Private service still has draining tasks')
    return arns[0]


def private_definition(definition, purpose, inventory):
    marker = 'property-' if purpose == 'property' else ''
    release.require(definition.get('family') in ('vayada-hotel-setup-' + marker + 'primary',
                    'vayada-hotel-setup-' + marker + 'rollback'), 'Wrong private serving family')
    release.require(definition.get('executionRoleArn') == ACCOUNT + 'vayada-hotel-setup-' + marker + 'execution'
                    and definition.get('taskRoleArn') == ACCOUNT + 'vayada-hotel-setup-' + marker + 'task',
                    'Wrong private serving identities')
    item = release.container(definition, 'hotel-setup')
    release.require(len(definition['containerDefinitions']) == 1 and item.get('readonlyRootFilesystem') is True
                    and item.get('privileged') is False, 'Unsafe private serving container')
    release.require(item.get('entryPoint') == ENTRY_POINT and item.get('command') == COMMAND
                    and item.get('workingDirectory') == '/app', 'Private readiness launcher differs')
    release.require(item.get('mountPoints') == [{'sourceVolume': 'runtime', 'containerPath': '/runtime', 'readOnly': False}]
                    and not item.get('volumesFrom') and not item.get('environmentFiles')
                    and len(definition.get('volumes', [])) == 1,
                    'Private code or runtime mounts differ')
    volume = definition['volumes'][0]
    release.require(volume.get('name') == 'runtime' and set(volume) <= {'name', 'host'}
                    and not volume.get('host'), 'Private runtime volume is not empty')
    digest = approved(item['image'], purpose, inventory)
    environment = release.environment(item)
    release.require(set(environment) == {'NODE_ENV', 'HOST', 'PORT', 'AWS_REGION', 'HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT',
                    'HOTEL_SETUP_COMMAND_MODE', 'HOTEL_SETUP_COMMAND_SECRET_PREFIX', 'HOTEL_SETUP_COMMAND_WORKOS_JWKS_URL',
                    'HOTEL_SETUP_COMMAND_WORKOS_ISSUER', 'HOTEL_SETUP_COMMAND_WORKOS_AUDIENCE', 'HOTEL_SETUP_RDS_CA', 'NODE_EXTRA_CA_CERTS'}
                    and environment['NODE_EXTRA_CA_CERTS'] == '/runtime/rds-ca.pem'
                    and environment['NODE_ENV'] == 'production' and environment['AWS_REGION'] == release.REGION
                    and environment['HOST'] == '0.0.0.0' and environment['PORT'] == '8011'
                    and environment['HOTEL_SETUP_RDS_CA'] == (ROOT / 'rehearsal/rds-ca-rsa2048-g1.pem').read_text(),
                    'Private startup environment differs')
    release.require(environment.get('HOTEL_SETUP_COMMAND_MODE') ==
                    ('property_creation' if purpose == 'creation' else 'property_commands')
                    and environment.get('HOTEL_SETUP_COMMAND_SECRET_PREFIX') ==
                    ('hotel-setup-command/prod/organization/' if purpose == 'creation' else 'hotel-setup-command/prod/property/')
                    and environment.get('HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT') ==
                    'postgresql://vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod',
                    'Private native mode or prefix differs')
    secrets = item.get('secrets', [])
    release.require(len(secrets) == 2 and {entry['name'] for entry in secrets} ==
                    {'HOTEL_SETUP_COMMAND_READER_DATABASE_URL', 'HOTEL_SETUP_COMMAND_INTERNAL_TOKEN'},
                    'Unexpected private injected credentials')
    namespace = 'hotel-setup-creation/prod/' if purpose == 'creation' else 'hotel-setup-command/prod/'
    for entry in secrets:
        leaf = 'reader-database-url' if entry['name'].endswith('READER_DATABASE_URL') else 'internal-token'
        release.require(re.fullmatch(r'arn:aws:secretsmanager:eu-west-1:269416271598:secret:'
                        + re.escape(namespace + leaf) + r'-[A-Za-z0-9]{6}', entry['valueFrom']),
                        'Private reader/token namespace differs')
    return digest


def snapshot(inventory):
    public = release.service(release.PUBLIC)
    release.require(release.stable(public) and release.TASK.fullmatch(public['taskDefinition']),
                    'Public caller must be stable')
    definition = release.aws('ecs', 'describe-task-definition', '--task-definition', public['taskDefinition'])['taskDefinition']
    image = release.container(definition, 'vayada-next-api')['image']
    release.require(image.startswith(release.REPOSITORY + '@'), 'Public caller must be immutable')
    release.approved(image.split('@')[1], 'hotel-setup-caller-images.json')
    public_arn = physical_tasks(release.PUBLIC, definition, 'vayada-next-api')
    release.healthy(public)
    result = {'publicTask': public['taskDefinition'], 'publicTaskArn': public_arn, 'private': {}}
    for purpose, name in release.PRIVATE.items():
        admission = release.environment(release.container(definition, 'vayada-next-api')).get(release.PREFIX[purpose] + '_ADMISSION')
        release.require(admission in ('enabled', 'blocked'), 'Public caller admission is not explicit')
        # Validate the retained fixed origin/token/execution identity; no mutation.
        release.prepare_public(definition, purpose, 'blocked', image.split('@')[1])
        service = release.service(name)
        release.require(release.stable(service) and release.TASK.fullmatch(service['taskDefinition']),
                        'Private service must be stable')
        private = release.aws('ecs', 'describe-task-definition', '--task-definition', service['taskDefinition'])['taskDefinition']
        digest = private_definition(private, purpose, inventory)
        arn = physical_tasks(name, private)
        release.healthy(service)
        release.require(release.stable(release.service(name), service['taskDefinition']), 'Private task changed during inspection')
        result['private'][purpose] = {'taskDefinition': service['taskDefinition'], 'imageDigest': digest, 'taskArn': arn}
    release.require(release.stable(release.service(release.PUBLIC), public['taskDefinition']), 'Public caller changed during inspection')
    return result


if __name__ == '__main__':
    try:
        inventory = json.loads((ROOT / 'deployment/hotel-setup-online-images.json').read_text())
        print(json.dumps({'status': 'PASS', **snapshot(inventory)}))
    except (RuntimeError, ValueError, KeyError):
        raise SystemExit('Online hotel setup admission denied; no provisioner was started')
