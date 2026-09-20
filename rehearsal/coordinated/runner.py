"""Inspect the exact fixture, then run one bounded private-network smoke task."""

import argparse
import ipaddress
import json
import subprocess
import time
from pathlib import Path

from probe import SERVICES

ACCOUNT = "269416271598"
REGION = "eu-west-1"
CLUSTER = "vayada-coordinated-recovery"
SUBNET = "subnet-08de4ae22f24fde7e"
GROUP = "sg-04d69fd8c5d1ee6c5"
EXECUTION = f"arn:aws:iam::{ACCOUNT}:role/vayada-recovery-execution"
IMAGE = "docker.io/library/python@sha256:c4634f578a412db396771b61b064c6e546c9d6414c7fb5b1b05d5871f1885f7b"
LOG_GROUP = "/ecs/vayada-recovery"


def aws(service, operation, *args):
    result = subprocess.run(
        ["aws", service, operation, *args, "--region", REGION, "--output", "json",
         "--cli-connect-timeout", "5", "--cli-read-timeout", "20"],
        capture_output=True, text=True, check=False, timeout=45,
    )
    if result.returncode:
        raise RuntimeError(f"AWS {service}/{operation} failed (exit {result.returncode})")
    return json.loads(result.stdout)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect():
    identity = aws("sts", "get-caller-identity")
    require(identity["Account"] == ACCOUNT, "Unexpected AWS account")
    names = [f"vayada-recovery-{key}" for key in sorted(SERVICES)]
    response = aws("ecs", "describe-services", "--cluster", CLUSTER, "--services", *names)
    require(not response.get("failures") and len(response["services"]) == 6, "Missing fixture services")
    targets, evidence = {}, []
    for service in response["services"]:
        name = service["serviceName"]
        require(name in names, "Unexpected physical service")
        key = name.removeprefix("vayada-recovery-")
        require(key not in targets, "Duplicate fixture service")
        require(service["serviceArn"] == f"arn:aws:ecs:{REGION}:{ACCOUNT}:service/{CLUSTER}/{name}", "Wrong service ARN")
        network = service["networkConfiguration"]["awsvpcConfiguration"]
        require(network["subnets"] == [SUBNET] and network["securityGroups"] == [GROUP], "Unexpected fixture network")
        require(service["runningCount"] == service["desiredCount"] == 1 and service["pendingCount"] == 0, "Fixture not steady")
        task_arn = service["taskDefinition"]
        require(task_arn.startswith(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{name}:"), "Wrong fixture family")
        definition = aws("ecs", "describe-task-definition", "--task-definition", task_arn)["taskDefinition"]
        require(not definition.get("taskRoleArn") and not definition.get("volumes"), "Unexpected task authority/storage")
        require(definition.get("executionRoleArn") == EXECUTION, "Unexpected execution role")
        containers = definition["containerDefinitions"]
        require(len(containers) == 1 and containers[0]["name"] == name, "Unexpected container")
        require(containers[0]["image"] == IMAGE and not containers[0].get("secrets"), "Unexpected bootstrap image/secrets")
        require(containers[0].get("command") == ["python", "-u", "-c", Path(__file__).with_name("fixture.py").read_text()],
                "Unexpected fixture command")
        require(containers[0].get("user") == "65534:65534" and containers[0].get("readonlyRootFilesystem") is True,
                "Unexpected container privilege")
        require(sorted(containers[0].get("environment", []), key=lambda item: item["name"]) == [
            {"name": "FIXTURE_REVISION", "value": "bootstrap-v1"}, {"name": "FIXTURE_SERVICE", "value": key},
        ], "Unexpected fixture environment")
        tasks = aws("ecs", "list-tasks", "--cluster", CLUSTER, "--service-name", name)["taskArns"]
        require(len(tasks) == 1, "Expected exactly one fixture task")
        detail = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *tasks)
        require(not detail.get("failures") and len(detail["tasks"]) == 1, "Missing fixture task")
        task = detail["tasks"][0]
        require(task["taskDefinitionArn"] == task_arn and task["group"] == f"service:{name}", "Fixture task drift")
        require(task["lastStatus"] == "RUNNING" and task["healthStatus"] == "HEALTHY", "Fixture task not healthy")
        address = task["containers"][0]["networkInterfaces"][0]["privateIpv4Address"]
        require(ipaddress.ip_address(address) in ipaddress.ip_network("10.229.0.0/26"), "Task outside fixture subnet")
        targets[key] = address
        evidence.append({"service": name, "taskDefinition": task_arn, "health": "HEALTHY"})
    require(set(targets) == SERVICES, "Incomplete fixture identities")
    return identity, targets, evidence


def run_probe(identity, targets):
    require(identity["Arn"].startswith(f"arn:aws:sts::{ACCOUNT}:assumed-role/vayada-recovery-runner/"),
            "Mutating probe requires the dedicated fixture role")
    definition = {
        "family": "vayada-recovery-probe", "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"], "cpu": "256", "memory": "512",
        "executionRoleArn": EXECUTION,
        "runtimePlatform": {"operatingSystemFamily": "LINUX", "cpuArchitecture": "X86_64"},
        "tags": [{"key": "Environment", "value": "coordinated-recovery"}],
        "containerDefinitions": [{
            "name": "probe", "image": IMAGE, "essential": True, "user": "65534:65534",
            "readonlyRootFilesystem": True,
            "command": ["python", "-u", "-c", Path(__file__).with_name("probe.py").read_text()],
            "environment": [{"name": "FIXTURE_TARGETS", "value": json.dumps(targets)}],
            "logConfiguration": {"logDriver": "awslogs", "options": {
                "awslogs-group": LOG_GROUP, "awslogs-region": REGION, "awslogs-stream-prefix": "probe",
            }},
        }],
    }
    registered = aws("ecs", "register-task-definition", "--cli-input-json", json.dumps(definition))["taskDefinition"]["taskDefinitionArn"]
    require(registered.startswith(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/vayada-recovery-probe:"), "Wrong registered family")
    response = aws("ecs", "run-task", "--cluster", CLUSTER, "--task-definition", registered,
                   "--launch-type", "FARGATE", "--count", "1", "--network-configuration", json.dumps({
                       "awsvpcConfiguration": {"subnets": [SUBNET], "securityGroups": [GROUP], "assignPublicIp": "ENABLED"},
                   }))
    require(not response.get("failures") and len(response.get("tasks", [])) == 1, "Probe task failed to start")
    task_arn = response["tasks"][0]["taskArn"]
    require(task_arn.startswith(f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/{CLUSTER}/"), "Wrong probe task cluster")
    stopped = False
    try:
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            task = aws("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", task_arn)["tasks"][0]
            if task["lastStatus"] == "STOPPED":
                stopped = True
                require(task["containers"][0].get("exitCode") == 0, "Private fixture probe failed")
                return {"probeTaskArn": task_arn, "taskDefinitionArn": registered, "exitCode": 0}
            time.sleep(5)
        raise RuntimeError("Private fixture probe timed out")
    finally:
        if not stopped:
            aws("ecs", "stop-task", "--cluster", CLUSTER, "--task", task_arn, "--reason", "Bounded VAY-2029 probe finished")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="Run a private probe using the dedicated fixture role")
    parser.add_argument("--output", default="preflight.json")
    args = parser.parse_args()
    identity, targets, evidence = inspect()
    result = {"scope": "isolated-recovery-bootstrap", "services": evidence, "recoveryScenarios": "not-run"}
    if args.run:
        result.update(run_probe(identity, targets))
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
