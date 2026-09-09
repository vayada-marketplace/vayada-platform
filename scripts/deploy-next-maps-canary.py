"""VAY-1480: CI-only staging API, routed exclusively to the reusable test hotel."""
import argparse
import copy
import json
import re
import subprocess
import time
import urllib.request

REGION = "eu-west-1"
ACCOUNT = "269416271598"
CLUSTER = "vayada-backend-cluster"
SERVICE = "vayada-next-maps-canary-service"
FAMILY = "vayada-next-maps-canary"
GROUP = "vayada-next-maps-canary"
LISTENER = f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:listener/app/vayada-backend-alb/d0816fa04cda80b4/40f3e72670746dc7"
PROPERTY = "65f6b2fc-c783-4963-9d6b-a85f82319769"
SLUG = "codex-test-hotel-not-bookable"
SECRET = f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/vayada/prod/next-google-places-server-test"
CHANNEX_SECRET = f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/vayada/staging/next-channex-test-api-key"
TAGS = [{"key": "Task", "value": "VAY-1480"}]


def target_group_config(source):
    return {key: source[key] for key in (
        "Protocol", "Port", "VpcId", "TargetType", "HealthCheckEnabled",
        "HealthCheckProtocol", "HealthCheckPort", "HealthCheckPath",
        "HealthCheckIntervalSeconds", "HealthCheckTimeoutSeconds",
        "HealthyThresholdCount", "UnhealthyThresholdCount", "Matcher",
    )}


def matching_conditions(actual, expected):
    # ALB repeats host/path values at the top level in describe-rules responses.
    normalized = []
    for condition in actual:
        item = dict(condition)
        config = {"host-header": "HostHeaderConfig", "path-pattern": "PathPatternConfig"}.get(item.get("Field"))
        if config and "Values" in item:
            if item["Values"] != item.get(config, {}).get("Values"):
                return False
            del item["Values"]
        normalized.append(item)
    return sorted(map(lambda c: json.dumps(c, sort_keys=True), normalized)) == sorted(
        map(lambda c: json.dumps(c, sort_keys=True), expected)
    )



PROBE_PATH = f"/api/ai/hotels/{SLUG}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_active_publication():
    request = urllib.request.Request("https://next-api.vayada.com" + PROBE_PATH,
                                     headers={"Cache-Control": "no-cache", "Accept": "application/json"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        if response.status != 200 or "no-store" not in response.headers.get("Cache-Control", "").lower().split(", "):
            raise RuntimeError("Current publication probe must return uncached HTTP 200")
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise RuntimeError("Current publication probe exceeded size limit")
        profile = json.loads(raw)
    hotel = profile.get("hotel", {})
    if not (profile.get("contractVersion") == "public-bookability.v1"
            and profile.get("publicVisibility") == "public_safe"
            and hotel.get("propertyId") == PROPERTY and hotel.get("slug") == SLUG
            and hotel.get("trust", {}).get("bookabilityStatus") == "bookable"
            and profile.get("freshness", {}).get("status") == "fresh"):
        raise RuntimeError("Test hotel has no current, fresh active publication")


def activate_guest(existing, group, owned_rules, conditions, digest):
    if not (group and existing and len(owned_rules) == len(conditions)):
        raise RuntimeError("Deploy all scoped canary routes before activation")
    primary = next(d for d in existing[0]["deployments"] if d["status"] == "PRIMARY")
    assert len(existing[0]["deployments"]) == 1
    assert primary["taskDefinition"] == existing[0]["taskDefinition"] and primary.get("rolloutState") == "COMPLETED"
    deployed = aws("ecs", "describe-task-definition", taskDefinition=existing[0]["taskDefinition"])["taskDefinition"]
    container = next(c for c in deployed["containerDefinitions"] if c["name"] == "vayada-next-api")
    assert container["image"].endswith("@" + digest)
    for name, value in [("API_BACKGROUND_WORKERS_ENABLED", "false"), ("PUBLIC_HOTEL_PROFILE_SOURCE", "active_publication"), ("GOOGLE_NEARBY_ENABLED", "true")]:
        assert {"name": name, "value": value} in container["environment"]
    health = aws("elbv2", "describe-target-health", TargetGroupArn=group["TargetGroupArn"])["TargetHealthDescriptions"]
    assert health and all(t["TargetHealth"]["State"] == "healthy" for t in health)
    probe_condition = next(c for c in conditions if any(PROBE_PATH in item.get("PathPatternConfig", {}).get("Values", []) for item in c))
    probe = [r for r in owned_rules if matching_conditions(r["Conditions"], probe_condition)]
    guest = [r for r in owned_rules if matching_conditions(r["Conditions"], conditions[2])]
    assert len(probe) == len(guest) == 1
    # A separate public-profile route reaches the same active-publication repository
    # as booking-web, without activating guest traffic or relying on old publish attempts.
    assert len(probe[0]["Actions"]) == 1
    action = probe[0]["Actions"][0]
    assert action["Type"] == "forward" and action.get("TargetGroupArn") == group["TargetGroupArn"]
    forwards = action.get("ForwardConfig", {}).get("TargetGroups", [])
    assert not forwards or (len(forwards) == 1 and forwards[0]["TargetGroupArn"] == group["TargetGroupArn"] and forwards[0].get("Weight", 1) > 0)
    verify_active_publication()
    aws("elbv2", "modify-rule", RuleArn=guest[0]["RuleArn"], Actions=[{"Type": "forward", "TargetGroupArn": group["TargetGroupArn"]}])
    print(json.dumps({"guestActivated": SLUG, "imageDigest": digest, "currentPublicationVerified": True}))


def aws(aws_service, operation, **values):
    result = subprocess.run(
        ["aws", aws_service, operation, "--region", REGION, "--output", "json",
         "--cli-input-json", json.dumps(values)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else {}


def configure_channex_staging(container, meals=False, worker_enabled="true"):
    settings = {
        "CHANNEX_API_BASE_URL": "https://staging.channex.io",
        "PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID": PROPERTY,
        "PMS_CHANNEX_WORKER_ENABLED": worker_enabled,
        "PMS_CHANNEX_ARI_SYNC_MODE": "mutating",
        "PMS_CHANNEX_STAGING_MEALS_ENABLED": "true" if meals else "false",
        **{f"PMS_CHANNEX_{mode}_MODE": "observe_only" for mode in
           ("CONNECTION", "PROVISIONING", "BOOKING_SYNC", "MARKUPS", "MESSAGING", "IFRAME")},
    }
    if meals:
        settings["PMS_CHANNEX_PROVISIONING_MODE"] = "mutating"
    container["environment"] = [e for e in container["environment"] if e["name"] not in settings and e["name"] != "CHANNEX_API_KEY"]
    container["environment"] += [{"name": k, "value": v} for k, v in settings.items()]
    container["secrets"] = [e for e in container.get("secrets", []) if e["name"] not in {*settings, "CHANNEX_API_KEY"}]
    container["secrets"].append({"name": "CHANNEX_API_KEY", "valueFrom": CHANNEX_SECRET})



TASK_FIELDS = {"taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions", "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory", "runtimePlatform", "ephemeralStorage", "pidMode", "ipcMode", "proxyConfiguration", "inferenceAccelerators", "enableFaultInjection", "family", "tags"}


def staging_worker_value(definition):
    container = next(c for c in definition["containerDefinitions"] if c["name"] == "vayada-next-api")
    values = [e["value"] for e in container.get("environment", []) if e["name"] == "PMS_CHANNEX_WORKER_ENABLED"]
    if len(values) != 1 or values[0] not in ("true", "false"):
        raise ValueError("Existing staging worker state is missing or ambiguous")
    return values[0]


def change_staging_worker(existing, definition, image_sha, state, meals, plan=False):
    service = existing[0]
    primary = service["deployments"]
    assert len(primary) == 1 and primary[0]["rolloutState"] == "COMPLETED"
    assert primary[0]["taskDefinition"] == service["taskDefinition"]
    container = next(c for c in definition["containerDefinitions"] if c["name"] == "vayada-next-api")
    assert definition["family"] == FAMILY
    assert {"key": "Task", "value": "VAY-1480"} in definition["tags"]
    assert not (definition.keys() - TASK_FIELDS - {"taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities", "registeredAt", "registeredBy", "deregisteredAt"}), "Unrecognized task settings require review"
    env = {e["name"]: e["value"] for e in container["environment"]}
    expected = {"environment": [], "secrets": []}
    configure_channex_staging(expected, meals=meals, worker_enabled=staging_worker_value(definition))
    for e in expected["environment"]:
        assert [x for x in container["environment"] if x["name"] == e["name"]] == [e]
    assert [e for e in container["environment"] if e["name"] == "API_BACKGROUND_WORKERS_ENABLED"] == [{"name": "API_BACKGROUND_WORKERS_ENABLED", "value": "false"}]
    assert "CHANNEX_API_KEY" not in env
    assert [x for x in container["secrets"] if x["name"] == "CHANNEX_API_KEY"] == expected["secrets"]
    assert not any(x["name"] in {e["name"] for e in expected["environment"]} | {"API_BACKGROUND_WORKERS_ENABLED"} for x in container["secrets"])
    digest = aws("ecr", "describe-images", repositoryName="vayada-next-api", imageIds=[{"imageTag": image_sha}])["imageDetails"][0]["imageDigest"]
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
    assert container["image"] == f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/vayada-next-api@{digest}", "Pause/resume must retain the deployed image"
    value = "false" if state == "paused" else "true"
    summary = {"workerState": state, "previousTaskDefinition": service["taskDefinition"], "imageDigest": digest, "routesUnchanged": True}
    if plan or staging_worker_value(definition) == value:
        print(json.dumps({**summary, "plan": plan, "unchanged": staging_worker_value(definition) == value}))
        return
    payload = copy.deepcopy({k: v for k, v in definition.items() if k in TASK_FIELDS})
    target = next(c for c in payload["containerDefinitions"] if c["name"] == "vayada-next-api")
    next(e for e in target["environment"] if e["name"] == "PMS_CHANNEX_WORKER_ENABLED")["value"] = value
    task = aws("ecs", "register-task-definition", **payload)["taskDefinition"]["taskDefinitionArn"]
    try:
        aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE, taskDefinition=task)
        for _ in range(80):
            current = aws("ecs", "describe-services", cluster=CLUSTER, services=[SERVICE])["services"][0]
            deployment = next(d for d in current["deployments"] if d["status"] == "PRIMARY")
            if deployment.get("rolloutState") == "FAILED":
                raise RuntimeError("Worker state rollout failed")
            if len(current["deployments"]) == 1 and deployment["taskDefinition"] == task and deployment.get("rolloutState") == "COMPLETED":
                print(json.dumps({**summary, "taskDefinition": task}))
                return
            time.sleep(10)
        raise RuntimeError("Worker state rollout did not complete")
    except Exception:
        aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE, taskDefinition=service["taskDefinition"])
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-sha", required=True)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--remove", action="store_true")
    parser.add_argument("--activate-guest", action="store_true")
    parser.add_argument("--channex-staging", action="store_true")
    parser.add_argument("--channex-staging-meals", action="store_true")
    parser.add_argument("--channex-worker-state", choices=("preserve", "paused", "running"), default="preserve")
    args = parser.parse_args()
    if args.channex_worker_state != "preserve" and not args.channex_staging:
        raise ValueError("Worker state changes require --channex-staging")
    if args.channex_staging_meals and not args.channex_staging:
        raise ValueError("Staging meals require --channex-staging")
    if args.channex_staging and (args.activate_guest or args.remove):
        raise ValueError("Channex setup cannot activate guests or remove the service")
    if args.activate_guest and args.remove:
        raise ValueError("Activation and removal are mutually exclusive")
    if not re.fullmatch(r"next-[a-f0-9]{40}", args.image_sha):
        raise ValueError("Expected immutable next-<40-character SHA> image tag")
    assert aws("sts", "get-caller-identity")["Account"] == ACCOUNT
    current = aws("ecs", "describe-services", cluster=CLUSTER,
                  services=["vayada-next-api-service"])["services"][0]
    definition = aws("ecs", "describe-task-definition", taskDefinition=current["taskDefinition"])["taskDefinition"]
    source = next(c for c in definition["containerDefinitions"] if c["name"] == "vayada-next-api")
    groups = aws("elbv2", "describe-target-groups")["TargetGroups"]
    group = next((g for g in groups if g["TargetGroupName"] == GROUP), None)
    if group:
        tags = aws("elbv2", "describe-tags", ResourceArns=[group["TargetGroupArn"]])["TagDescriptions"][0]["Tags"]
        assert {"Key": "Task", "Value": "VAY-1480"} in tags
    rules = aws("elbv2", "describe-rules", ListenerArn=LISTENER)["Rules"]
    owned_rules = [r for r in rules if group and any(a.get("TargetGroupArn") == group["TargetGroupArn"] or any(t["TargetGroupArn"] == group["TargetGroupArn"] for t in a.get("ForwardConfig", {}).get("TargetGroups", [])) for a in r["Actions"])]
    paths = [f"/api/hotel-setup/properties/{PROPERTY}", f"/api/booking/hotels/{PROPERTY}", f"/api/booking-web/hotels/{SLUG}", f"/api/booking/properties/{PROPERTY}"]
    conditions = [[
        {"Field": "host-header", "HostHeaderConfig": {"Values": ["next-api.vayada.com"]}},
        {"Field": "path-pattern", "PathPatternConfig": {"Values": [path, path + "/*"]}},
    ] for path in paths]
    conditions.append([conditions[0][0], {"Field": "path-pattern", "PathPatternConfig": {"Values": [f"/api/pms/properties/{PROPERTY}/pricing-source", f"/api/pms/properties/{PROPERTY}/mandatory-charge-confirmation"]}}])
    conditions.append([conditions[0][0], {"Field": "path-pattern", "PathPatternConfig": {"Values": [f"/api/pms/properties/{PROPERTY}/inventory-materialization"]}}])
    conditions.append([conditions[0][0], {"Field": "path-pattern", "PathPatternConfig": {"Values": [PROBE_PATH]}}])
    channex_condition = [conditions[0][0], {"Field": "path-pattern", "PathPatternConfig": {"Values": [f"/api/pms/properties/{PROPERTY}/channex", f"/api/pms/properties/{PROPERTY}/channex/*"]}}]
    has_channex = any(matching_conditions(rule["Conditions"], channex_condition) for rule in owned_rules)
    if args.channex_staging or has_channex:
        conditions.append(channex_condition)
    meal_condition = [conditions[0][0], {"Field": "path-pattern", "PathPatternConfig": {"Values": [f"/api/pms/properties/{PROPERTY}/room-types/*/flexible-rate-plan"]}}]
    has_meals = any(matching_conditions(rule["Conditions"], meal_condition) for rule in owned_rules)
    if args.channex_staging_meals or has_meals:
        conditions.append(meal_condition)
    if has_meals and not args.channex_staging_meals and not args.remove and not args.activate_guest:
        raise ValueError("Existing staging meals require --channex-staging-meals to preserve configuration")
    if any(not any(matching_conditions(rule["Conditions"], expected) for expected in conditions) for rule in owned_rules):
        raise ValueError("Existing API rule has unexpected conditions")
    baseline_rules = [r for r in rules if r not in owned_rules and any(c.get("Field") == "host-header" and "next-api.vayada.com" in c.get("HostHeaderConfig", {}).get("Values", []) for c in r["Conditions"])]
    existing = aws("ecs", "describe-services", cluster=CLUSTER, services=[SERVICE], include=["TAGS"])["services"]
    if existing and existing[0]["status"] != "INACTIVE":
        assert {"key": "Task", "value": "VAY-1480"} in existing[0].get("tags", [])
    else:
        existing = []
    print(json.dumps({"action": "remove" if args.remove else "deploy", "sourceDefinition": current["taskDefinition"],
                      "canaryService": SERVICE, "conditions": conditions, "sharedApiUnchanged": True}))
    if has_channex and not args.channex_staging and not args.remove and not args.activate_guest:
        raise ValueError("Existing Channex staging requires --channex-staging to preserve its configuration")
    staging_definition = None
    if has_channex:
        if not existing:
            raise ValueError("Existing staging routes require an existing service")
        described = aws("ecs", "describe-task-definition", taskDefinition=existing[0]["taskDefinition"], include=["TAGS"])
        staging_definition = {**described["taskDefinition"], "tags": described.get("tags", [])}
    if args.channex_worker_state != "preserve":
        if not staging_definition:
            raise ValueError("Pause/resume requires an existing configured staging service")
        change_staging_worker(existing, staging_definition, args.image_sha, args.channex_worker_state, args.channex_staging_meals, args.plan)
        return
    if args.plan:
        return
    if args.remove:
        for rule in owned_rules:
            aws("elbv2", "delete-rule", RuleArn=rule["RuleArn"])
        if existing:
            aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE, desiredCount=0)
            aws("ecs", "delete-service", cluster=CLUSTER, service=SERVICE, force=True)
        # Keep the empty target group and task revisions for diagnosis/reuse; no database rollback.
        return
    assert baseline_rules
    before = min(int(r["Priority"]) for r in baseline_rules)
    assert all(int(r["Priority"]) < before for r in owned_rules)
    assert any(e == {"name": "PUBLIC_HOTEL_PROFILE_SOURCE", "value": "target"} for e in source["environment"])
    digest = aws("ecr", "describe-images", repositoryName="vayada-next-api",
                 imageIds=[{"imageTag": args.image_sha}])["imageDetails"][0]["imageDigest"]
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
    if args.activate_guest:
        activate_guest(existing, group, owned_rules, conditions, digest)
        return
    # Inspect metadata only. ECS injects the existing server credential; CI never retrieves its value.
    parameters = aws("ssm", "describe-parameters", ParameterFilters=[{"Key": "Name", "Option": "Equals", "Values": [SECRET.split(":parameter")[1]]}])["Parameters"]
    assert len(parameters) == 1 and parameters[0]["Type"] == "SecureString"
    if args.channex_staging:
        parameters = aws("ssm", "describe-parameters", ParameterFilters=[{"Key": "Name", "Option": "Equals", "Values": [CHANNEX_SECRET.split(":parameter")[1]]}])["Parameters"]
        assert len(parameters) == 1 and parameters[0]["Type"] == "SecureString"
        configure_channex_staging(source, meals=args.channex_staging_meals,
                                  worker_enabled=staging_worker_value(staging_definition) if staging_definition else "true")
    source["image"] = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/vayada-next-api@{digest}"
    source["environment"] = [e for e in source["environment"] if e["name"] not in {"PUBLIC_HOTEL_PROFILE_SOURCE", "GOOGLE_NEARBY_ENABLED", "API_BACKGROUND_WORKERS_ENABLED"}]
    source["environment"] += [{"name": "PUBLIC_HOTEL_PROFILE_SOURCE", "value": "active_publication"}, {"name": "GOOGLE_NEARBY_ENABLED", "value": "true"}, {"name": "API_BACKGROUND_WORKERS_ENABLED", "value": "false"}]
    source["secrets"] = [e for e in source["secrets"] if e["name"] != "GOOGLE_PLACES_SERVER_API_KEY"]
    source["secrets"].append({"name": "GOOGLE_PLACES_SERVER_API_KEY", "valueFrom": SECRET})
    payload = {k: v for k, v in definition.items() if k in TASK_FIELDS}
    payload.update(family=FAMILY, tags=TAGS)
    task = aws("ecs", "register-task-definition", **payload)["taskDefinition"]["taskDefinitionArn"]
    if not group:
        source_group = next(g for g in groups if g["TargetGroupArn"] == current["loadBalancers"][0]["targetGroupArn"])
        group = aws("elbv2", "create-target-group", Name=GROUP,
                    **target_group_config(source_group), Tags=[{"Key": "Task", "Value": "VAY-1480"}])["TargetGroups"][0]
    baseline_group = current["loadBalancers"][0]["targetGroupArn"]
    previous_actions = {r["RuleArn"]: r["Actions"] for r in owned_rules}
    created_rules = []
    service_created = False
    previous_task = existing[0]["taskDefinition"] if existing else None
    try:
        # Zero canary weight associates the group with ALB while every request stays on the baseline.
        used = {int(r["Priority"]) for r in rules if r["Priority"].isdigit()}
        free = [p for p in range(1, before) if p not in used]
        for condition in conditions:
            desired_paths = condition[1]["PathPatternConfig"]["Values"]
            if any(any(c.get("PathPatternConfig", {}).get("Values") == desired_paths for c in r["Conditions"]) for r in owned_rules):
                continue
            assert free
            rule = aws("elbv2", "create-rule", ListenerArn=LISTENER, Priority=free.pop(0),
                Conditions=condition, Actions=[{"Type": "forward", "ForwardConfig": {"TargetGroups": [
                    {"TargetGroupArn": baseline_group, "Weight": 1},
                    {"TargetGroupArn": group["TargetGroupArn"], "Weight": 0},
                ]}}])["Rules"][0]
            created_rules.append(rule)
            owned_rules.append(rule)
        assert len(owned_rules) == len(conditions)
        if existing:
            aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE, taskDefinition=task, desiredCount=1)
        else:
            aws("ecs", "create-service", cluster=CLUSTER, serviceName=SERVICE, taskDefinition=task,
                desiredCount=1, launchType="FARGATE", networkConfiguration=current["networkConfiguration"],
                loadBalancers=[{"targetGroupArn": group["TargetGroupArn"], "containerName": "vayada-next-api", "containerPort": 8003}],
                deploymentConfiguration={"deploymentCircuitBreaker": {"enable": True, "rollback": True}}, tags=TAGS)
            service_created = True
        for _ in range(80):
            service = aws("ecs", "describe-services", cluster=CLUSTER, services=[SERVICE])["services"][0]
            deployment = next(d for d in service["deployments"] if d["status"] == "PRIMARY")
            if deployment.get("rolloutState") == "FAILED":
                raise RuntimeError("Canary rollout failed")
            health = aws("elbv2", "describe-target-health", TargetGroupArn=group["TargetGroupArn"])["TargetHealthDescriptions"]
            if deployment["taskDefinition"] == task and deployment.get("rolloutState") == "COMPLETED" and any(t["TargetHealth"]["State"] == "healthy" for t in health):
                break
            time.sleep(10)
        else:
            raise RuntimeError("Canary did not become healthy")
        for rule in owned_rules:
            if matching_conditions(rule["Conditions"], conditions[2]):
                continue
            aws("elbv2", "modify-rule", RuleArn=rule["RuleArn"], Actions=[{"Type": "forward", "TargetGroupArn": group["TargetGroupArn"]}])
    except Exception:
        for arn, actions in previous_actions.items():
            aws("elbv2", "modify-rule", RuleArn=arn, Actions=actions)
        for rule in created_rules:
            aws("elbv2", "delete-rule", RuleArn=rule["RuleArn"])
        if previous_task:
            aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE, taskDefinition=previous_task)
        elif service_created:
            aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE, desiredCount=0)
            aws("ecs", "delete-service", cluster=CLUSTER, service=SERVICE, force=True)
        raise
    print(json.dumps({"taskDefinition": task, "imageDigest": digest, "rules": [r["RuleArn"] for r in owned_rules], "ownerPathsActivated": True, "existingGuestRoutingPreserved": bool(previous_actions)}))


if __name__ == "__main__":
    main()
