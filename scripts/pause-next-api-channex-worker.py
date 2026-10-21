"""Keep baseline next API deployments paused until worker rollout is reviewed.

VAY-2055: Terraform may declare the reviewed connection-only scope (worker on,
only PMS_CHANNEX_CONNECTION_MODE mutating, dedicated worker secret mapped). A
deployment preserves exactly that shape; anything else is paused as before.

VAY-2108: on top of that scope Terraform may declare the claimed booking scope
(PMS_CHANNEX_SCOPE=claimed, booking sync mutating and target-owned for a list of
owned hotels, webhook intake observe_only). Anything short of that exact shape
falls back to the connection scope with every claimed setting removed.
"""
import json
import os
import re
from pathlib import Path

PAUSED_ENV = {
    "PMS_CHANNEX_WORKER_ENABLED": "false",
    **{f"PMS_CHANNEX_{capability}_MODE": "observe_only" for capability in (
        "CONNECTION", "PROVISIONING", "ARI_SYNC", "BOOKING_SYNC", "MARKUPS", "MESSAGING"
    )},
}
CONNECTION_ENV = {"PMS_CHANNEX_WORKER_ENABLED": "true", "PMS_CHANNEX_CONNECTION_MODE": "mutating"}
WORKER_SECRET_NAME = "PMS_CHANNEX_MANAGEMENT_DATABASE_URL"
WORKER_SECRET_PARAMETER = "/vayada/prod/target-database-channex-management-worker-url"
WORKER_SECRET_PARAMETERS = {WORKER_SECRET_PARAMETER, "arn:aws:ssm:eu-west-1:269416271598:parameter" + WORKER_SECRET_PARAMETER}
OWNED_IDS = "PMS_CHANNEX_OWNED_PROPERTY_IDS"
CLAIMED_BOOKING_ENV = {
    "PMS_CHANNEX_SCOPE": "claimed", "PMS_CHANNEX_BOOKING_SYNC_MODE": "mutating",
    "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE": "target-owned",
}
MANAGED_ENV = {*PAUSED_ENV, *CLAIMED_BOOKING_ENV, OWNED_IDS}
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# Staging and test properties in the production database (app migration 0432).
RESERVED_PROPERTY_IDS = {
    "17621565-40b5-4ebc-8727-3a301ac947a2", "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
    "65f6b2fc-c783-4963-9d6b-a85f82319769", "8f4c1e47-3de1-4150-8bde-ad031a013842",
}


def connection_scope_declared(container):
    """True only for the reviewed shape: worker secret mapped, worker on, connection mutating."""
    secrets = [s for s in container.get("secrets", []) if s["name"] == WORKER_SECRET_NAME]
    if len(secrets) > 1 or any(s.get("valueFrom") not in WORKER_SECRET_PARAMETERS for s in secrets):
        raise ValueError("Channex worker secret must map only the reviewed dedicated parameter")
    seen = environment_values(container)
    # A mutating connection mode without the dedicated secret is the pre-VAY-2041
    # shape, and conflicting duplicates are ambiguous: both are paused, never promoted.
    return bool(secrets) and all(seen.get(key) == {value} for key, value in CONNECTION_ENV.items())


def environment_values(container):
    seen = {}
    for entry in container.get("environment", []):
        seen.setdefault(entry["name"], set()).add(entry["value"])
    return seen


def claimed_booking_settings(container):
    """The reviewed claimed booking settings when declared exactly on the connection scope, else {}."""
    seen = environment_values(container)
    owned = seen.get(OWNED_IDS, set())
    if not (connection_scope_declared(container) and len(owned) == 1
            and all(seen.get(key) == {value} for key, value in CLAIMED_BOOKING_ENV.items())
            and seen.get("CHANNEX_WEBHOOK_INTAKE_MODE") == {"observe_only"}
            and not any(name.startswith("PMS_CHANNEX_STAGING_") for name in seen)):
        return {}
    [value] = owned
    ids = value.split(",") if value else []
    if (not re.fullmatch(rf"(?:{UUID}(?:,{UUID})*)?", value) or len(set(ids)) != len(ids)
            or RESERVED_PROPERTY_IDS.intersection(ids)):
        return {}
    return {**CLAIMED_BOOKING_ENV, OWNED_IDS: value}


def pause_worker(task):
    if task.get("family") != "vayada-next-api":
        raise ValueError("Unexpected next API task family")
    containers = [c for c in task["containerDefinitions"] if c["name"] == "vayada-next-api"]
    if len(containers) != 1:
        raise ValueError("Expected exactly one next API container")
    container = containers[0]
    if not re.fullmatch(r"269416271598\.dkr\.ecr\.eu-west-1\.amazonaws\.com/vayada-next-api@sha256:[a-f0-9]{64}", container["image"]):
        raise ValueError("Paused recovery requires an immutable next API image")
    if any(s["name"] in MANAGED_ENV for s in container.get("secrets", [])):
        raise ValueError("Worker pause configuration cannot be overridden by a secret")
    settings = {**PAUSED_ENV, **(CONNECTION_ENV if connection_scope_declared(container) else {}),
                **claimed_booking_settings(container)}
    container["environment"] = [e for e in container.get("environment", []) if e["name"] not in MANAGED_ENV]
    container["environment"].extend({"name": key, "value": value} for key, value in settings.items())
    return task


def main():
    if os.environ.get("SERVICE") != "next-target-backend":
        return
    paths = [Path(os.environ["TASK_DEFINITION"])]
    if os.environ.get("ROLLBACK_TASK_DEFINITION"):
        paths.append(Path(os.environ["ROLLBACK_TASK_DEFINITION"]))
    # Validate both artifacts before changing either; no AWS operations here.
    tasks = [pause_worker(json.loads(path.read_text())) for path in paths]
    for path, task in zip(paths, tasks):
        path.write_text(json.dumps(task))


if __name__ == "__main__":
    main()
