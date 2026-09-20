"""Fixture-only hosted recovery exercises. Never accepts a production config."""

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import runner as fixture

SPEC = importlib.util.spec_from_file_location("release", Path(__file__).resolve().parents[2] / "scripts/coordinated_release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
PREFIX = "/vayada/rehearsal/coordinated-deployments/v1"
SERVICES = sorted(fixture.SERVICES)
REGISTRY = f"{fixture.ACCOUNT}.dkr.ecr.{fixture.REGION}.amazonaws.com"
TAG = [{"key": "Environment", "value": "coordinated-recovery"}]


def digest(value):
    return hashlib.sha256(release.canonical_json(value).encode()).hexdigest()


def publication(path):
    value = release.read_json(path)
    release.exact_keys(value, {"scope", "runId", "runAttempt", "sourceSha", "repository", "variants"}, "fixture publication")
    fixture.require(value["scope"] == "isolated-recovery-scenarios-v1", "Wrong publication scope")
    fixture.require(value["repository"] == "vayada-marketplace/vayada-platform", "Wrong publisher repository")
    fixture.require(os.environ.get("GITHUB_REPOSITORY") == value["repository"] and os.environ.get("GITHUB_REF") == "refs/heads/main", "Main-only fixture publication")
    fixture.require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual fixture workflow required")
    for field, env in (("runId", "GITHUB_RUN_ID"), ("runAttempt", "GITHUB_RUN_ATTEMPT")):
        fixture.require(str(release.positive_int(value[field], field)) == os.environ.get(env), "Publication run mismatch")
    fixture.require(release.require_sha(value["sourceSha"], "fixture source") == os.environ.get("GITHUB_SHA"), "Publication source mismatch")
    fixture.require(set(value["variants"]) == {"baseline", "good", "bad"}, "Wrong fixture variants")
    for images in value["variants"].values():
        fixture.require(set(images) == set(SERVICES), "Incomplete fixture images")
        for image in images.values():
            release.require_digest(image, "fixture digest")
    for key in SERVICES:
        fixture.require(len({images[key] for images in value["variants"].values()}) == 3, "Variants must have distinct digests")
    return value


def inventory():
    """Read only, including exact definitions/network for the approval fingerprint."""
    fixture.require(fixture.aws("sts", "get-caller-identity")["Account"] == fixture.ACCOUNT, "Wrong account")
    response = fixture.aws("ecs", "describe-services", "--cluster", fixture.CLUSTER,
                           "--services", *[f"vayada-recovery-{key}" for key in SERVICES])
    fixture.require(not response.get("failures") and len(response["services"]) == 6, "Missing fixtures")
    result = {}
    for service in response["services"]:
        key = service["serviceName"].removeprefix("vayada-recovery-")
        fixture.require(key in SERVICES and key not in result, "Unexpected/duplicate fixture")
        fixture.require(service["serviceArn"] == f"arn:aws:ecs:{fixture.REGION}:{fixture.ACCOUNT}:service/{fixture.CLUSTER}/vayada-recovery-{key}", "Wrong service identity")
        network = service["networkConfiguration"]["awsvpcConfiguration"]
        fixture.require(network == {"subnets": [fixture.SUBNET], "securityGroups": [fixture.GROUP], "assignPublicIp": "ENABLED"}, "Unexpected fixture network")
        fixture.require(service["runningCount"] == service["desiredCount"] == 1 and service["pendingCount"] == 0, "Fixture not steady")
        fixture.require(len(service["deployments"]) == 1 and service["deployments"][0]["rolloutState"] == "COMPLETED", "Fixture rollout incomplete")
        task = fixture.aws("ecs", "describe-task-definition", "--task-definition", service["taskDefinition"])["taskDefinition"]
        # AWS CLI renders these instants in the caller's timezone. Bind the same
        # instant on developer machines and hosted runners without dropping it.
        for field in ("registeredAt", "deregisteredAt"):
            if field in task:
                task[field] = release.parse_time(task[field], f"fixture.{field}").isoformat()
        fixture.require(task["family"] == f"vayada-recovery-{key}" and task.get("executionRoleArn") == fixture.EXECUTION, "Wrong task family/execution role")
        fixture.require(not task.get("taskRoleArn") and not task.get("volumes"), "Unexpected fixture authority/storage")
        containers = task["containerDefinitions"]
        fixture.require(len(containers) == 1 and containers[0]["name"] == f"vayada-recovery-{key}" and not containers[0].get("secrets"), "Unexpected containers/secrets")
        result[key] = {"taskDefinitionArn": service["taskDefinition"], "taskDefinition": task, "network": network}
    return result


class Commands(release.CommandRunner):
    def run(self, *args, input_value=None):
        fixture.require(args[0] == "aws", "Fixture runner only executes AWS CLI")
        result = subprocess.run(args, input=input_value, text=True, capture_output=True, timeout=660, check=False)
        if result.returncode:
            reason = "AccessDenied" if "AccessDenied" in result.stderr else f"exit {result.returncode}"
            raise release.ReleaseError(f"Fixture AWS {args[1]}/{args[2]} failed ({reason})")
        return result.stdout


class ScenarioAws(release.Aws):
    def __init__(self, published, output):
        self.published, self.output = published, output
        self.interrupt = False
        self.updates = []
        self.evidence_lock = threading.Lock()
        self.config = {
            "deployment": {"accountId": fixture.ACCOUNT, "region": fixture.REGION, "cluster": fixture.CLUSTER,
                           "statePrefix": f"{PREFIX}/runs/{published['runId']}-{published['runAttempt']}"},
            "services": {key: {"phase": "api" if key == "api" else "frontend", "smoke": "fixture",
                               **{field: f"vayada-recovery-{key}" for field in ("ecrRepository", "ecsService", "taskFamily", "containerName")}}
                         for key in SERVICES},
        }
        super().__init__(Commands(), self.config)

    def parameter(self, name):
        fixture.require(name.startswith(self.config["deployment"]["statePrefix"] + "/"), "State outside this fixture run")

    def get_parameter(self, name):
        self.parameter(name)
        return super().get_parameter(name)

    def put_parameter(self, name, value):
        self.parameter(name)
        return super().put_parameter(name, value)

    def verify_image(self, key, image):
        fixture.require(key in SERVICES and image["ecrRepository"] == f"vayada-recovery-{key}", "Wrong fixture repository")
        variant = next((name for name, images in self.published["variants"].items() if images[key] == image["digest"]), None)
        fixture.require(variant is not None, "Image outside this publication")
        details = self.json("ecr", "describe-images", "--repository-name", image["ecrRepository"], "--image-ids", f"imageDigest={image['digest']}")["imageDetails"]
        tag = f"recovery-{self.published['runId']}-{self.published['runAttempt']}-{variant}"
        fixture.require(len(details) == 1 and details[0]["imageDigest"] == image["digest"] and tag in details[0].get("imageTags", []), "Unbound fixture digest/tag")

    def verify_api_split_image(self, key, image_digest):
        # Synthetic containers have no application migration launcher or attestations.
        self.verify_image(key, {"ecrRepository": f"vayada-recovery-{key}", "digest": image_digest})

    def json(self, service, operation, *args):
        if (service, operation) == ("ecs", "register-task-definition"):
            path = Path(args[1].removeprefix("file://"))
            definition = release.read_json(path)
            definition["tags"] = TAG
            path.write_text(json.dumps(definition))
        return super().json(service, operation, *args)

    def update_service(self, key, task_definition):
        fixture.require(key in SERVICES and task_definition.startswith(f"arn:aws:ecs:{fixture.REGION}:{fixture.ACCOUNT}:task-definition/vayada-recovery-{key}:"), "Wrong update target")
        started = release.iso_now()
        self.runner.run("aws", "ecs", "update-service", "--cluster", fixture.CLUSTER,
                        "--service", f"vayada-recovery-{key}", "--task-definition", task_definition,
                        "--region", fixture.REGION)
        with self.evidence_lock:
            row = {"service": key, "taskDefinitionArn": task_definition, "startedAt": started, "acceptedAt": release.iso_now()}
            self.updates.append(row)
            (self.output / f"updates-{os.getpid()}.json").write_text(json.dumps(self.updates, indent=2))
        self.wait_service(key)
        with self.evidence_lock:
            row["completedAt"] = release.iso_now()
            (self.output / f"updates-{os.getpid()}.json").write_text(json.dumps(self.updates, indent=2))
        if self.interrupt:
            # Actual worker process termination, after ECS update and durable pending writes.
            os._exit(77)

    def smoke(self, runner, config, key, source):
        snapshot = self.service_snapshot(key)
        revision = next(name for name, images in self.published["variants"].items() if images[key] == snapshot["digest"])
        tasks = fixture.aws("ecs", "list-tasks", "--cluster", fixture.CLUSTER, "--service-name", f"vayada-recovery-{key}")["taskArns"]
        fixture.require(len(tasks) == 1, "Expected one fixture task")
        detail = fixture.aws("ecs", "describe-tasks", "--cluster", fixture.CLUSTER, "--tasks", *tasks)
        fixture.require(not detail.get("failures") and len(detail["tasks"]) == 1, "Missing target task")
        task = detail["tasks"][0]
        fixture.require(task["taskDefinitionArn"] == snapshot["taskDefinitionArn"] and task["healthStatus"] == "HEALTHY", "Target task drift/health")
        ip = task["containers"][0]["networkInterfaces"][0]["privateIpv4Address"]
        private_probe(key, ip, revision)


def private_probe(key, address, revision):
    import ipaddress
    fixture.require(key in SERVICES and revision in {"baseline", "good", "bad"}, "Unknown probe identity")
    fixture.require(ipaddress.ip_address(address) in ipaddress.ip_network("10.229.0.0/26"), "Probe outside fixture subnet")
    code = '''import json,os,sys,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args): return None
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
try:
 r=opener.open("http://"+os.environ["TARGET"]+":8080/health",timeout=5)
except urllib.error.HTTPError as error:
 r=error
with r:
 body=json.loads(r.read(4097))
 if os.environ["REVISION"]=="bad" and r.status==503 and body=={"status":"unhealthy","service":os.environ["SERVICE"],"revision":"bad"}:
  sys.exit(42)
 assert r.status==200 and body=={"status":"ok","service":os.environ["SERVICE"],"revision":os.environ["REVISION"]}
print("private fixture readiness passed")
'''
    definition = {"family": "vayada-recovery-probe", "networkMode": "awsvpc", "requiresCompatibilities": ["FARGATE"],
                  "cpu": "256", "memory": "512", "executionRoleArn": fixture.EXECUTION, "tags": TAG,
                  "runtimePlatform": {"operatingSystemFamily": "LINUX", "cpuArchitecture": "X86_64"},
                  "containerDefinitions": [{"name": "probe", "image": fixture.IMAGE, "essential": True,
                    "user": "65534:65534", "readonlyRootFilesystem": True, "command": ["python", "-c", code],
                    "environment": [{"name": name, "value": value} for name, value in (("TARGET", address), ("SERVICE", key), ("REVISION", revision))]}]}
    registered = fixture.aws("ecs", "register-task-definition", "--cli-input-json", json.dumps(definition))["taskDefinition"]["taskDefinitionArn"]
    response = fixture.aws("ecs", "run-task", "--cluster", fixture.CLUSTER, "--task-definition", registered,
                           "--launch-type", "FARGATE", "--count", "1", "--tags", "key=Purpose,value=recovery-probe",
                           "--network-configuration", json.dumps({"awsvpcConfiguration": {"subnets": [fixture.SUBNET], "securityGroups": [fixture.GROUP], "assignPublicIp": "ENABLED"}}))
    fixture.require(not response.get("failures") and len(response.get("tasks", [])) == 1, "Probe launch failed")
    task_arn = response["tasks"][0]["taskArn"]
    fixture.require(task_arn.startswith(f"arn:aws:ecs:{fixture.REGION}:{fixture.ACCOUNT}:task/{fixture.CLUSTER}/"), "Wrong probe cluster")
    stopped = False
    try:
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            detail = fixture.aws("ecs", "describe-tasks", "--cluster", fixture.CLUSTER, "--tasks", task_arn)["tasks"][0]
            if detail["lastStatus"] == "STOPPED":
                stopped = True
                exit_code = detail["containers"][0].get("exitCode")
                if exit_code == 42:
                    raise release.ReleaseError("Synthetic readiness rejected")
                if exit_code != 0:
                    raise release.ReleaseError("Probe failed before validated readiness")
                return
            time.sleep(5)
        raise release.ReleaseError("Synthetic readiness timed out")
    finally:
        if not stopped:
            fixture.aws("ecs", "stop-task", "--cluster", fixture.CLUSTER, "--task", task_arn, "--reason", "Bounded recovery probe")


def manifest(published, variant):
    return {"schemaVersion": 1, "manifestId": f"recovery/v1/{published['runId']}/{published['runAttempt']}/{variant}",
            "repository": published["repository"], "source": {"sha": published["sourceSha"], "branch": "main"},
            "barriers": [], "services": {key: {"ecrRepository": f"vayada-recovery-{key}", "digest": image,
                       "imageSourceSha": published["sourceSha"]} for key, image in published["variants"][variant].items()}}


def reconcile(aws, variant, key, operation, *, resume=False):
    value = manifest(aws.published, variant)
    def validate(candidate, config):
        fixture.require(candidate == value and config == aws.config, "Synthetic publication changed")
    path = aws.output / f"{operation}-{key}-manifest.json"
    path.write_text(json.dumps(value))
    before = aws.service_snapshot(key)
    hold = release.active_hold(aws, aws.config, key)
    if resume:
        fixture.require(hold is not None, "Synthetic resume requires an active hold")
        if key != "api":
            api = aws.service_snapshot("api")
            api_hold = release.active_hold(aws, aws.config, "api")
            blocked = release.incompatible_api_hold_blocks_frontends(api_hold, operation="resume", selected_service=key, api_service="api")
            release.require_resume_api_readiness({"observedDigest": api["digest"], "desiredDigest": value["services"]["api"]["digest"]}, blocked)
    action, reason = release.planned_action(operation="resume" if resume else "ordinary", order="duplicate",
        selected=True, hold=hold, live_digest=before["digest"], desired_digest=value["services"][key]["digest"])
    plan = {"schemaVersion": 1, "manifestId": value["manifestId"], "manifestSha256": release.sha256_file(path),
            "operationId": operation, "operation": "resume" if resume else "ordinary", "resumeService": key if resume else None,
            "services": {key: {"action": action, "reason": reason}}}
    args = argparse.Namespace(manifest=path, service=key)
    release.reconcile_service_with_dependencies(args, aws.config, value, plan, aws, aws.runner, aws.smoke, validate)
    return action


def bootstrap(aws, expected):
    before = inventory()
    with (aws.output / "before.json").open("x") as evidence:
        evidence.write(json.dumps(before, indent=2))
    fixture.require(digest(before) == expected, "Fixture baseline changed since approval")
    path = release.state_path(aws.config, "suite")
    fixture.require(aws.get_parameter(path) is None, "This run already started; recovery requires its retained evidence")
    aws.put_parameter(path, {"scope": "isolated-recovery-scenarios-v1", "status": "running", "publicationSha256": digest(aws.published)})
    for key in SERVICES:
        image = manifest(aws.published, "baseline")["services"][key]
        aws.verify_image(key, image)
        task = {name: value for name, value in before[key]["taskDefinition"].items() if name not in release.TASK_DEFINITION_READ_ONLY_FIELDS}
        container = task["containerDefinitions"][0]
        # Change the reviewed bootstrap task into an image-owned fixture, retaining resource isolation.
        fixture.require(container.get("user") == "65534:65534" and container.get("readonlyRootFilesystem") is True, "Unexpected privilege")
        container.pop("command", None)
        container.pop("entryPoint", None)
        container["image"] = f"{REGISTRY}/vayada-recovery-{key}@{image['digest']}"
        container["environment"] = [{"name": "FIXTURE_SERVICE", "value": key}]
        container["healthCheck"]["command"] = ["CMD", "python", "-c", "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:8080/live',timeout=3).status==200"]
        task["tags"] = TAG
        registered = fixture.aws("ecs", "register-task-definition", "--cli-input-json", json.dumps(task))["taskDefinition"]["taskDefinitionArn"]
        aws.update_service(key, registered)
        aws.smoke(aws.runner, aws.config, key, aws.published["sourceSha"])


def state(aws, key, suffix):
    return aws.get_parameter(release.state_path(aws.config, f"services/{key}/{suffix}"))


def expect_failure(aws, variant, key, operation, expected_error="Synthetic readiness rejected"):
    before = aws.service_snapshot(key)
    try:
        reconcile(aws, variant, key, operation)
    except release.ReleaseError as error:
        fixture.require(expected_error in str(error), "Unexpected failure cause; scenario not proven")
    else:
        raise ValueError("Expected failure did not occur")
    pending, hold = state(aws, key, "pending-operation"), state(aws, key, "hold")
    fixture.require(pending["status"] == "rolled-back-held" and hold["status"] == "active", "Failure did not retain rollback/hold")
    fixture.require(hold["capturedTaskDefinitionArn"] == before["taskDefinitionArn"] and aws.service_snapshot(key)["taskDefinitionArn"] == before["taskDefinitionArn"], "Wrong rollback target")
    (aws.output / f"{operation}-result.json").write_text(json.dumps({"expectedFailure": True, "pending": pending, "hold": hold}, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["inspect", "exercise", "deny", "recover", "interrupt"], required=True)
    parser.add_argument("--publication", type=Path)
    parser.add_argument("--expected-baseline-sha256")
    parser.add_argument("--output-dir", type=Path, default=Path("evidence"))
    args = parser.parse_args()
    if args.phase == "inspect":
        print(json.dumps({"baselineSha256": digest(inventory()), "scope": "isolated-recovery-scenarios-v1"}))
        return
    published = publication(args.publication)
    expected_role = "vayada-recovery-state-denial" if args.phase == "deny" else "vayada-recovery-scenarios"
    identity = fixture.aws("sts", "get-caller-identity")
    fixture.require(identity["Arn"].startswith(f"arn:aws:sts::{fixture.ACCOUNT}:assumed-role/{expected_role}/"), "Dedicated fixture role required")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    aws = ScenarioAws(published, args.output_dir)
    suite_path = release.state_path(aws.config, "suite")
    if args.phase != "exercise":
        suite = aws.get_parameter(suite_path)
        fixture.require(suite and suite["publicationSha256"] == digest(published), "Run publication changed")
    if args.phase == "exercise":
        bootstrap(aws, args.expected_baseline_sha256)
        reconcile(aws, "good", "api", "healthy-api")
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(lambda key: reconcile(aws, "good", key, "healthy-frontends"), [key for key in SERVICES if key != "api"]))
        count = len(aws.updates)
        for key in SERVICES:
            reconcile(aws, "good", key, "duplicate")
        fixture.require(len(aws.updates) == count, "Duplicate mutated a service")
        expect_failure(aws, "bad", "booking-admin", "frontend-failure")
        fixture.require(reconcile(aws, "bad", "booking-admin", "held-retry") == "held", "Ordinary retry ignored hold")
        reconcile(aws, "good", "api", "resume-api-check")
        reconcile(aws, "good", "booking-admin", "resume-frontend", resume=True)
        expect_failure(aws, "bad", "api", "api-failure")
        plan_services = {key: {"action": "deploy", "reason": "synthetic API failure gate"} for key in SERVICES}
        api_hold = release.active_hold(aws, aws.config, "api")
        blocked = release.incompatible_api_hold_blocks_frontends(api_hold, operation="ordinary", selected_service=None, api_service="api")
        release.apply_api_hold_gate(plan_services, aws.config, blocked)
        fixture.require(all(row["action"] == "blocked" for key, row in plan_services.items() if key != "api"), "API hold did not block frontends")
        (aws.output / "api-hold-gate.json").write_text(json.dumps(plan_services, indent=2))
        reconcile(aws, "good", "api", "resume-api", resume=True)
        # A child process really exits immediately after updating the target.
        previous_task = aws.service_snapshot("booking-admin")["taskDefinitionArn"]
        child = subprocess.run([sys.executable, __file__, "--phase", "interrupt", "--publication", str(args.publication), "--output-dir", str(args.output_dir)], timeout=900, check=False)
        fixture.require(child.returncode == 77, "Worker interruption did not reach checkpoint")
        pending = state(aws, "booking-admin", "pending-operation")
        fixture.require(pending["status"] == "mutating", "Interrupted mutation lost durable pending state")
        fixture.require(pending["rollbackTaskDefinitionArn"] == previous_task, "Interruption lost the original rollback target")
        interrupted_task = aws.service_snapshot("booking-admin")["taskDefinitionArn"]
        fixture.require(interrupted_task != previous_task, "Interruption did not update the service")
        (aws.output / "interrupted-pending.json").write_text(json.dumps(pending, indent=2))
        reconcile(aws, "baseline", "booking-admin", "recover-interruption")
        fixture.require(state(aws, "booking-admin", "pending-operation")["status"] == "succeeded", "Interrupted recovery failed")
        fixture.require(aws.service_snapshot("booking-admin")["taskDefinitionArn"] == interrupted_task, "Interrupted recovery repeated the update")
        aws.put_parameter(suite_path, {"publicationSha256": digest(published), "status": "awaiting-denial"})
    elif args.phase == "interrupt":
        fixture.require(suite["status"] == "running", "Wrong interruption phase")
        aws.interrupt = True
        reconcile(aws, "baseline", "booking-admin", "interrupted-worker")
        raise ValueError("Interruption did not mutate")
    elif args.phase == "deny":
        fixture.require(suite["status"] == "awaiting-denial", "Wrong denial phase")
        expect_failure(aws, "good", "booking-admin", "state-denial", "Fixture AWS ssm/put-parameter failed (AccessDenied)")
        aws.put_parameter(suite_path, {"publicationSha256": digest(published), "status": "awaiting-recovery"})
    elif args.phase == "recover":
        fixture.require(suite["status"] == "awaiting-recovery", "Wrong recovery phase")
        reconcile(aws, "good", "api", "state-recovery-api")
        reconcile(aws, "good", "booking-admin", "state-recovery", resume=True)
        for key in SERVICES:
            reconcile(aws, "good", key, "final-verification")
            fixture.require(not release.active_hold(aws, aws.config, key), "Unresolved fixture hold")
        value = manifest(published, "good")
        plan = {"operation": "ordinary", "operationId": "final-verification", "order": "duplicate",
                "publishedAt": release.iso_now(), "preparedAt": release.iso_now(),
                "services": {key: {"action": "verify"} for key in SERVICES}}
        def validate(candidate, config):
            fixture.require(candidate == value and config == aws.config, "Synthetic finalization input changed")
        release.finalize_release_with_dependencies(args, aws.config, value, plan, aws, validate)
        aws.put_parameter(suite_path, {"publicationSha256": digest(published), "status": "completed"})
    (aws.output / f"{args.phase}-updates.json").write_text(json.dumps(aws.updates, indent=2))
    (aws.output / f"{args.phase}-state.json").write_text(json.dumps({key: {suffix: state(aws, key, suffix) for suffix in ("provenance", "pending-operation", "hold")} for key in SERVICES}, indent=2))


if __name__ == "__main__":
    main()
