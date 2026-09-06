"""VAY-1480: CI-only staging API, routed exclusively to the reusable test hotel."""
import argparse
import json
import re
import subprocess
import time

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
TAGS = [{"key": "Task", "value": "VAY-1480"}]


def aws(service, operation, **values):
    result = subprocess.run(
        ["aws", service, operation, "--region", REGION, "--output", "json",
         "--cli-input-json", json.dumps(values)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-sha", required=True)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()
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
    paths = [f"/api/hotel-setup/properties/{PROPERTY}", f"/api/booking/hotels/{PROPERTY}", f"/api/booking-web/hotels/{SLUG}"]
    conditions = [[
        {"Field": "host-header", "HostHeaderConfig": {"Values": ["next-api.vayada.com"]}},
        {"Field": "path-pattern", "PathPatternConfig": {"Values": [path, path + "/*"]}},
    ] for path in paths]
    baseline_rules = [r for r in rules if r not in owned_rules and any(c.get("Field") == "host-header" and "next-api.vayada.com" in c.get("HostHeaderConfig", {}).get("Values", []) for c in r["Conditions"])]
    existing = aws("ecs", "describe-services", cluster=CLUSTER, services=[SERVICE], include=["TAGS"])["services"]
    if existing and existing[0]["status"] != "INACTIVE":
        assert {"key": "Task", "value": "VAY-1480"} in existing[0].get("tags", [])
    else:
        existing = []
    print(json.dumps({"action": "remove" if args.remove else "deploy", "sourceDefinition": current["taskDefinition"],
                      "canaryService": SERVICE, "conditions": conditions, "sharedApiUnchanged": True}))
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
    # Inspect metadata only. ECS injects the existing server credential; CI never retrieves its value.
    parameters = aws("ssm", "describe-parameters", ParameterFilters=[{"Key": "Name", "Option": "Equals", "Values": [SECRET.split(":parameter")[1]]}])["Parameters"]
    assert len(parameters) == 1 and parameters[0]["Type"] == "SecureString"
    source["image"] = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/vayada-next-api@{digest}"
    source["environment"] = [e for e in source["environment"] if e["name"] not in {"PUBLIC_HOTEL_PROFILE_SOURCE", "GOOGLE_NEARBY_ENABLED", "API_BACKGROUND_WORKERS_ENABLED"}]
    source["environment"] += [{"name": "PUBLIC_HOTEL_PROFILE_SOURCE", "value": "active_publication"}, {"name": "GOOGLE_NEARBY_ENABLED", "value": "true"}, {"name": "API_BACKGROUND_WORKERS_ENABLED", "value": "false"}]
    source["secrets"] = [e for e in source["secrets"] if e["name"] != "GOOGLE_PLACES_SERVER_API_KEY"]
    source["secrets"].append({"name": "GOOGLE_PLACES_SERVER_API_KEY", "valueFrom": SECRET})
    accepted = {"taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions", "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory", "runtimePlatform", "ephemeralStorage"}
    payload = {k: v for k, v in definition.items() if k in accepted}
    payload.update(family=FAMILY, tags=TAGS)
    task = aws("ecs", "register-task-definition", **payload)["taskDefinition"]["taskDefinitionArn"]
    if not group:
        source_group = next(g for g in groups if g["TargetGroupArn"] == current["loadBalancers"][0]["targetGroupArn"])
        group = aws("elbv2", "create-target-group", Name=GROUP, Protocol="HTTP", Port=8003,
                    VpcId=source_group["VpcId"], TargetType="ip", HealthCheckPath="/health",
                    Matcher={"HttpCode": "200"}, Tags=[{"Key": "Task", "Value": "VAY-1480"}])["TargetGroups"][0]
    baseline_group = current["loadBalancers"][0]["targetGroupArn"]
    previous_actions = {r["RuleArn"]: r["Actions"] for r in owned_rules}
    created_rules = []
    service_created = False
    previous_task = existing[0]["taskDefinition"] if existing else None
    try:
        # Zero canary weight associates the group with ALB while every request stays on the baseline.
        if not owned_rules:
            used = {int(r["Priority"]) for r in rules if r["Priority"].isdigit()}
            free = [p for p in range(1, before) if p not in used]
            assert len(free) >= len(conditions)
            for priority, condition in zip(free, conditions):
                rule = aws("elbv2", "create-rule", ListenerArn=LISTENER, Priority=priority,
                    Conditions=condition, Actions=[{"Type": "forward", "ForwardConfig": {"TargetGroups": [
                        {"TargetGroupArn": baseline_group, "Weight": 1},
                        {"TargetGroupArn": group["TargetGroupArn"], "Weight": 0},
                    ]}}])["Rules"][0]
                created_rules.append(rule)
            owned_rules = created_rules
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
    print(json.dumps({"taskDefinition": task, "imageDigest": digest, "rules": [r["RuleArn"] for r in owned_rules], "routedTestHotelOnly": True}))


if __name__ == "__main__":
    main()
