#!/usr/bin/env python3
"""Rotate the RDS master password from the deployment-locked workflow."""

import argparse
import json
import secrets
import sys
import time
from urllib.request import Request, urlopen
from urllib.parse import quote, urlsplit, urlunsplit


REGION = "eu-west-1"
ACCOUNT = "269416271598"
INSTANCE = "vayada-database"
HOST = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com"
MASTER_USER = "vayada_admin"
PARAMETER = "/vayada/prod/db-marketplace-url"
LEGACY_PARAMETER = "/vayada/prod/db-marketplace-url-ssl"
PENDING_PARAMETER = "/vayada/prod/db-marketplace-admin-rotation-pending"
EXPECTED_CA = "rds-ca-rsa2048-g1"
CLUSTER = "vayada-backend-cluster"
SERVICE = "vayada-marketplace-backend-service"
SERVICE_CONTAINER = "vayada-marketplace-backend"
DATABASE_HEALTH_URL = "https://api.vayada.com/health/db"
PENDING_TAGS = {
    "Project": "vayada",
    "Environment": "production",
    "Purpose": "VAY-2038-rds-admin-rotation-recovery",
}


class RotationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def clients():
    import boto3
    from botocore.config import Config

    session = boto3.Session(region_name=REGION)
    config = Config(retries={"max_attempts": 5, "mode": "standard"})
    return tuple(session.client(name, config=config) for name in ("sts", "ssm", "rds", "ecs"))


def pending_metadata(ssm):
    response = ssm.describe_parameters(
        ParameterFilters=[{"Key": "Name", "Option": "Equals", "Values": [PENDING_PARAMETER]}]
    )
    if not response["Parameters"]:
        return False
    parameter = response["Parameters"][0]
    tags = ssm.list_tags_for_resource(ResourceType="Parameter", ResourceId=PENDING_PARAMETER)["TagList"]
    if (
        len(response["Parameters"]) != 1
        or parameter["Name"] != PENDING_PARAMETER
        or parameter["Type"] != "SecureString"
        or parameter.get("KeyId") != "alias/aws/ssm"
        or {item["Key"]: item["Value"] for item in tags} != PENDING_TAGS
    ):
        raise RotationError("rotation_failed_pending_validation")
    return True


def connection_url(ssm, name):
    parameter = ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]
    if parameter["Name"] != name or parameter["Type"] != "SecureString":
        raise RotationError("rotation_failed_parameter_validation")
    url = urlsplit(parameter["Value"])
    if (
        url.scheme != "postgresql"
        or url.username != MASTER_USER
        or url.hostname != HOST
        or url.port != 5432
        or url.path != "/postgres"
        or url.query != "sslmode=require"
        or url.fragment
        or not url.password
    ):
        raise RotationError("rotation_failed_url_validation")
    return url


def validate(sts, ssm, rds, ecs, recovery):
    if sts.get_caller_identity()["Account"] != ACCOUNT:
        raise RotationError("rotation_failed_account_validation")

    database = rds.describe_db_instances(DBInstanceIdentifier=INSTANCE)["DBInstances"][0]
    endpoint = database["Endpoint"]
    if (
        database["DBInstanceIdentifier"] != INSTANCE
        or database["MasterUsername"] != MASTER_USER
        or database["Engine"] != "postgres"
        or database["CACertificateIdentifier"] != EXPECTED_CA
        or database.get("ManageMasterUserPassword") is True
        or endpoint["Address"] != HOST
        or endpoint["Port"] != 5432
    ):
        raise RotationError("rotation_failed_rds_validation")
    if not recovery and (database["DBInstanceStatus"] != "available" or database.get("PendingModifiedValues")):
        raise RotationError("rotation_failed_rds_readiness")

    url = connection_url(ssm, PARAMETER)

    service = ecs.describe_services(cluster=CLUSTER, services=[SERVICE])["services"][0]
    primary = [item for item in service["deployments"] if item["status"] == "PRIMARY"]
    if service["status"] != "ACTIVE" or service["desiredCount"] != 1 or len(primary) != 1:
        raise RotationError("rotation_failed_service_validation")
    if not recovery and (
        service["runningCount"] != 1
        or service["pendingCount"] != 0
        or primary[0].get("rolloutState") != "COMPLETED"
    ):
        raise RotationError("rotation_failed_service_readiness")

    task_definition = service["taskDefinition"]
    definition = ecs.describe_task_definition(taskDefinition=task_definition)["taskDefinition"]
    containers = [item for item in definition["containerDefinitions"] if item["name"] == SERVICE_CONTAINER]
    if len(containers) != 1:
        raise RotationError("rotation_failed_service_mapping")
    secret_refs = [
        item["valueFrom"]
        for item in containers[0].get("secrets", [])
        if item["name"] == "DATABASE_URL"
    ]
    allowed_refs = {
        f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter{PARAMETER}": PARAMETER,
        f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter{LEGACY_PARAMETER}": LEGACY_PARAMETER,
    }
    if len(secret_refs) != 1 or secret_refs[0] not in allowed_refs:
        raise RotationError("rotation_failed_service_mapping")
    consumer_parameter = allowed_refs[secret_refs[0]]
    consumer_url = url if consumer_parameter == PARAMETER else connection_url(ssm, consumer_parameter)
    return url, consumer_parameter, consumer_url, task_definition, primary[0]["id"]


def load_or_create_pending(ssm, recovery):
    if recovery:
        pending = ssm.get_parameter(Name=PENDING_PARAMETER, WithDecryption=True)["Parameter"]
        password = pending["Value"]
    else:
        password = secrets.token_urlsafe(48)
        ssm.put_parameter(
            Name=PENDING_PARAMETER,
            Type="SecureString",
            KeyId="alias/aws/ssm",
            Value=password,
            Overwrite=False,
            Tags=[{"Key": key, "Value": value} for key, value in PENDING_TAGS.items()],
        )
    if not 8 <= len(password) <= 128 or any(character in password for character in '/"@ '):
        raise RotationError("rotation_failed_pending_password_validation")
    return password


def run_stage(code, operation):
    try:
        return operation()
    except RotationError:
        raise
    except Exception:
        raise RotationError(code) from None


def verify_database_health():
    request = Request(DATABASE_HEALTH_URL, headers={"User-Agent": "vayada-rds-rotation/1"})
    for attempt in range(12):
        try:
            with urlopen(request, timeout=10) as response:
                body = response.read(4097)
            if len(body) <= 4096:
                payload = json.loads(body)
                if payload.get("status") == "healthy" and payload.get("database", {}).get("connected") is True:
                    return
        except Exception:
            pass
        if attempt < 11:
            time.sleep(5)
    raise RotationError("rotation_failed_database_health")


def url_with_password(url, password):
    return urlunsplit((
        "postgresql",
        f"{MASTER_USER}:{quote(password, safe='')}@{HOST}:5432",
        url.path,
        url.query,
        "",
    ))


def completed_replacement(ecs, deployment_id, task_definition):
    service = ecs.describe_services(cluster=CLUSTER, services=[SERVICE])["services"][0]
    primary = [item for item in service["deployments"] if item["status"] == "PRIMARY"]
    if (
        service["status"] != "ACTIVE"
        or service["desiredCount"] != 1
        or service["runningCount"] != 1
        or service["pendingCount"] != 0
        or len(primary) != 1
        or primary[0].get("id") != deployment_id
        or primary[0].get("taskDefinition") != task_definition
        or primary[0].get("rolloutState") != "COMPLETED"
    ):
        raise RotationError("rotation_failed_service_replacement")


def rotate(
    ssm, rds, ecs, url, consumer_parameter, consumer_url,
    task_definition, previous_deployment_id, recovery,
):
    password = run_stage(
        "rotation_failed_pending_write",
        lambda: load_or_create_pending(ssm, recovery),
    )
    updated_url = url_with_password(url, password)

    run_stage("rotation_failed_rds_update", lambda: rds.modify_db_instance(
        DBInstanceIdentifier=INSTANCE,
        MasterUserPassword=password,
        ApplyImmediately=True,
    ))
    run_stage("rotation_failed_rds_wait", lambda: rds.get_waiter("db_instance_available").wait(
        DBInstanceIdentifier=INSTANCE,
        WaiterConfig={"Delay": 15, "MaxAttempts": 80},
    ))
    run_stage("rotation_failed_parameter_write", lambda: ssm.put_parameter(
        Name=PARAMETER,
        Type="SecureString",
        KeyId="alias/aws/ssm",
        Value=updated_url,
        Overwrite=True,
    ))
    if consumer_parameter != PARAMETER:
        run_stage("rotation_failed_consumer_parameter_write", lambda: ssm.put_parameter(
            Name=consumer_parameter,
            Type="SecureString",
            KeyId="alias/aws/ssm",
            Value=url_with_password(consumer_url, password),
            Overwrite=True,
        ))
    updated_service = run_stage("rotation_failed_service_update", lambda: ecs.update_service(
        cluster=CLUSTER, service=SERVICE, taskDefinition=task_definition, forceNewDeployment=True,
    ))["service"]
    updated_primary = [item for item in updated_service["deployments"] if item["status"] == "PRIMARY"]
    if (
        len(updated_primary) != 1
        or not updated_primary[0].get("id")
        or updated_primary[0]["id"] == previous_deployment_id
        or updated_primary[0].get("taskDefinition") != task_definition
    ):
        raise RotationError("rotation_failed_service_update_validation")
    deployment_id = updated_primary[0]["id"]
    run_stage("rotation_failed_service_wait", lambda: ecs.get_waiter("services_stable").wait(
        cluster=CLUSTER,
        services=[SERVICE],
        WaiterConfig={"Delay": 15, "MaxAttempts": 80},
    ))
    run_stage(
        "rotation_failed_service_replacement",
        lambda: completed_replacement(ecs, deployment_id, task_definition),
    )
    run_stage("rotation_failed_database_health", verify_database_health)
    run_stage("rotation_failed_pending_cleanup", lambda: ssm.delete_parameter(Name=PENDING_PARAMETER))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("check", "apply"))
    args = parser.parse_args()
    sts, ssm, rds, ecs = clients()
    recovery = pending_metadata(ssm)
    url, consumer_parameter, consumer_url, task_definition, previous_deployment_id = validate(
        sts, ssm, rds, ecs, recovery
    )
    if args.mode == "check":
        print(json.dumps({"status": "PASS", "mode": "check", "recovery": recovery}))
        return
    rotate(
        ssm, rds, ecs, url, consumer_parameter, consumer_url,
        task_definition, previous_deployment_id, recovery,
    )
    print(json.dumps({"status": "PASS", "mode": "apply", "instance": INSTANCE, "service": SERVICE}))


if __name__ == "__main__":
    try:
        main()
    except RotationError as error:
        print(json.dumps({"status": "FAIL", "code": error.code}), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Never let SDK exceptions print request data that may contain the password.
        print(json.dumps({"status": "FAIL", "code": "rotation_failed_unexpected"}), file=sys.stderr)
        sys.exit(1)
