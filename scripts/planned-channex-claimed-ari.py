#!/usr/bin/env python3
"""VAY-2108 P2: does the plan declare the claimed ARI stage (ARI sync or provisioning mutating) on
next-api? tf-apply then reruns --preflight-channex-claimed-worker on the running image before the
apply, so a missing claimed grant or an unlisted worker image fails before the rollout instead of
crash-looping the new task. Malformed/unknown plans must fail closed."""
import json
import sys

CLAIMED_ARI_MODES = {"PMS_CHANNEX_ARI_SYNC_MODE", "PMS_CHANNEX_PROVISIONING_MODE"}


def claimed_ari(plan):
    resources = [r for r in plan["planned_values"]["root_module"]["resources"]
                 if r["address"] == 'aws_ecs_task_definition.services["next-target-backend"]']
    if len(resources) != 1:
        raise ValueError("expected one planned next-api definition")
    containers = [c for c in json.loads(resources[0]["values"]["container_definitions"])
                  if c["name"] == "vayada-next-api"]
    if len(containers) != 1:
        raise ValueError("expected one planned next-api container")
    modes = {e["name"]: e["value"] for e in containers[0].get("environment", []) if e["name"] in CLAIMED_ARI_MODES}
    if any(value not in ("mutating", "observe_only") for value in modes.values()):
        raise ValueError("unexpected claimed ARI mode")
    return "mutating" in modes.values()


if __name__ == "__main__":
    try:
        with open(sys.argv[1]) as source:
            print(str(claimed_ari(json.load(source))).lower())
    except (KeyError, TypeError, ValueError, IndexError):
        sys.exit("claimed Channex ARI plan check failed: the plan is unreadable")
