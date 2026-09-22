"""Keep baseline next API deployments paused until worker rollout is reviewed."""
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


def pause_worker(task):
    if task.get("family") != "vayada-next-api":
        raise ValueError("Unexpected next API task family")
    containers = [c for c in task["containerDefinitions"] if c["name"] == "vayada-next-api"]
    if len(containers) != 1:
        raise ValueError("Expected exactly one next API container")
    container = containers[0]
    if not re.fullmatch(r"269416271598\.dkr\.ecr\.eu-west-1\.amazonaws\.com/vayada-next-api@sha256:[a-f0-9]{64}", container["image"]):
        raise ValueError("Paused recovery requires an immutable next API image")
    if any(s["name"] in PAUSED_ENV for s in container.get("secrets", [])):
        raise ValueError("Worker pause configuration cannot be overridden by a secret")
    container["environment"] = [e for e in container.get("environment", []) if e["name"] not in PAUSED_ENV]
    container["environment"].extend({"name": key, "value": value} for key, value in PAUSED_ENV.items())
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
