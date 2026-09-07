"""Stable staging frontends: one test guest hostname and an opt-in admin cookie."""
import argparse
import json
import pathlib
import re
import runpy
import time

api = runpy.run_path(str(pathlib.Path(__file__).with_name('deploy-next-maps-canary.py')))
aws, ACCOUNT, REGION, CLUSTER, LISTENER = [api[k] for k in ('aws', 'ACCOUNT', 'REGION', 'CLUSTER', 'LISTENER')]
TAGS = [{'key': 'Task', 'value': 'VAY-1480'}]
SPECS = [
    ('guest', 'vayada-next-booking-frontend', 'fb8290aea0e82cc9d197484dbaf0d4d916956893', 'codex-test-hotel-not-bookable.next-booking.vayada.com'),
    ('admin', 'vayada-next-booking-admin', 'fb8290aea0e82cc9d197484dbaf0d4d916956893', 'next-booking-admin.vayada.com'),
]


def owned(rule, arn):
    return any(a.get('TargetGroupArn') == arn or any(t['TargetGroupArn'] == arn for t in a.get('ForwardConfig', {}).get('TargetGroups', [])) for a in rule['Actions'])


def deploy(spec, remove=False, expected_digest=None):
    kind, baseline, sha, host = spec
    name = 'vayada-next-maps-' + kind
    service_name = name + '-service'
    current = aws('ecs', 'describe-services', cluster=CLUSTER, services=[baseline + '-service'])['services'][0]
    groups = aws('elbv2', 'describe-target-groups')['TargetGroups']
    group = next((g for g in groups if g['TargetGroupName'] == name), None)
    if group:
        tags = aws('elbv2', 'describe-tags', ResourceArns=[group['TargetGroupArn']])['TagDescriptions'][0]['Tags']
        assert {'Key': 'Task', 'Value': 'VAY-1480'} in tags
    rules = aws('elbv2', 'describe-rules', ListenerArn=LISTENER)['Rules']
    prior_rules = [r for r in rules if group and owned(r, group['TargetGroupArn'])]
    existing = aws('ecs', 'describe-services', cluster=CLUSTER, services=[service_name], include=['TAGS'])['services']
    existing = [s for s in existing if s['status'] != 'INACTIVE']
    if existing:
        assert {'key': 'Task', 'value': 'VAY-1480'} in existing[0].get('tags', [])
    if remove:
        for rule in prior_rules:
            aws('elbv2', 'delete-rule', RuleArn=rule['RuleArn'])
        if existing:
            aws('ecs', 'update-service', cluster=CLUSTER, service=service_name, desiredCount=0)
            aws('ecs', 'delete-service', cluster=CLUSTER, service=service_name, force=True)
        return
    assert len(prior_rules) <= 1
    baseline_group = next(g for g in groups if g['TargetGroupArn'] == current['loadBalancers'][0]['targetGroupArn'])
    baseline_rules = [r for r in rules if r not in prior_rules and owned(r, baseline_group['TargetGroupArn'])]
    before = min(int(r['Priority']) for r in baseline_rules if r['Priority'].isdigit())
    conditions = [{'Field': 'host-header', 'HostHeaderConfig': {'Values': [host]}}]
    if kind == 'admin':
        conditions.append({'Field': 'http-header', 'HttpHeaderConfig': {'HttpHeaderName': 'Cookie', 'Values': ['*vay1480_preview=1*']}})
    if prior_rules:
        assert int(prior_rules[0]['Priority']) < before
        if not api['matching_conditions'](prior_rules[0]['Conditions'], conditions):
            raise ValueError('Existing frontend rule has unexpected conditions')
    repo = baseline + ('-frontend' if kind == 'admin' else '')
    digest = aws('ecr', 'describe-images', repositoryName=repo, imageIds=[{'imageTag': 'next-' + sha}])['imageDetails'][0]['imageDigest']
    if expected_digest and digest != expected_digest:
        raise ValueError('Guest image digest does not match the reviewed candidate')
    definition = aws('ecs', 'describe-task-definition', taskDefinition=current['taskDefinition'])['taskDefinition']
    container = next(c for c in definition['containerDefinitions'] if c['name'] == baseline)
    container['image'] = f'{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/{repo}@{digest}'
    accepted = {'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions', 'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform', 'ephemeralStorage'}
    payload = {k: v for k, v in definition.items() if k in accepted}
    payload.update(family=name, tags=TAGS)
    task = aws('ecs', 'register-task-definition', **payload)['taskDefinition']['taskDefinitionArn']
    if not group:
        config = api['target_group_config'](baseline_group)
        group = aws('elbv2', 'create-target-group', Name=name, **config, Tags=[{'Key': 'Task', 'Value': 'VAY-1480'}])['TargetGroups'][0]
    created_rule = None
    service_created = False
    try:
        if not prior_rules:
            used = {int(r['Priority']) for r in rules if r['Priority'].isdigit()}
            priority = next(p for p in range(1, before) if p not in used)
            created_rule = aws('elbv2', 'create-rule', ListenerArn=LISTENER, Priority=priority, Conditions=conditions, Actions=[{'Type': 'forward', 'ForwardConfig': {'TargetGroups': [{'TargetGroupArn': baseline_group['TargetGroupArn'], 'Weight': 1}, {'TargetGroupArn': group['TargetGroupArn'], 'Weight': 0}]}}])['Rules'][0]
        if existing:
            aws('ecs', 'update-service', cluster=CLUSTER, service=service_name, taskDefinition=task, desiredCount=1)
        else:
            lb = dict(current['loadBalancers'][0], targetGroupArn=group['TargetGroupArn'])
            aws('ecs', 'create-service', cluster=CLUSTER, serviceName=service_name, taskDefinition=task, desiredCount=1, launchType='FARGATE', networkConfiguration=current['networkConfiguration'], loadBalancers=[lb], deploymentConfiguration={'deploymentCircuitBreaker': {'enable': True, 'rollback': True}}, tags=TAGS)
            service_created = True
        for _ in range(80):
            s = aws('ecs', 'describe-services', cluster=CLUSTER, services=[service_name])['services'][0]
            primary = next(d for d in s['deployments'] if d['status'] == 'PRIMARY')
            if primary.get('rolloutState') == 'FAILED':
                raise RuntimeError('Frontend rollout failed')
            health = aws('elbv2', 'describe-target-health', TargetGroupArn=group['TargetGroupArn'])['TargetHealthDescriptions']
            if primary['taskDefinition'] == task and primary.get('rolloutState') == 'COMPLETED' and any(t['TargetHealth']['State'] == 'healthy' for t in health):
                break
            time.sleep(10)
        else:
            raise RuntimeError('Frontend health timeout')
        rule = created_rule or prior_rules[0]
        aws('elbv2', 'modify-rule', RuleArn=rule['RuleArn'], Conditions=conditions, Actions=[{'Type': 'forward', 'TargetGroupArn': group['TargetGroupArn']}])
        print(json.dumps({'frontend': kind, 'host': host, 'previewCookieRequired': kind == 'admin', 'imageDigest': digest, 'taskDefinition': task}), flush=True)
    except Exception:
        if created_rule:
            aws('elbv2', 'delete-rule', RuleArn=created_rule['RuleArn'])
        for rule in prior_rules:
            aws('elbv2', 'modify-rule', RuleArn=rule['RuleArn'], Conditions=rule['Conditions'], Actions=rule['Actions'])
        if service_created:
            aws('ecs', 'update-service', cluster=CLUSTER, service=service_name, desiredCount=0)
            aws('ecs', 'delete-service', cluster=CLUSTER, service=service_name, force=True)
        elif existing:
            aws('ecs', 'update-service', cluster=CLUSTER, service=service_name, taskDefinition=existing[0]['taskDefinition'])
        raise


def main(argv=None):
    parser = argparse.ArgumentParser()
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--remove', action='store_true')
    selection.add_argument('--guest-image-sha')
    parser.add_argument('--guest-image-digest')
    args = parser.parse_args(argv)
    specs = SPECS
    if args.guest_image_sha is not None:
        if not re.fullmatch(r'next-[0-9a-f]{40}', args.guest_image_sha):
            parser.error('Guest image must be an immutable next-<40-character SHA> tag')
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', args.guest_image_digest or ''):
            parser.error('Guest image requires its reviewed SHA-256 digest')
        kind, baseline, _, host = SPECS[0]
        specs = [(kind, baseline, args.guest_image_sha[5:], host)]
    elif args.guest_image_digest is not None:
        parser.error('Guest digest requires --guest-image-sha')
    assert aws('sts', 'get-caller-identity')['Account'] == ACCOUNT
    for spec in specs:
        deploy(spec, args.remove, args.guest_image_digest)


if __name__ == '__main__':
    main()
