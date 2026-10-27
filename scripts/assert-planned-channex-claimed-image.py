#!/usr/bin/env python3
"""VAY-2108: Terraform may declare the claimed Channex scope only while every running
next-api task uses an image that recognises it. tf-apply rolls the new task definition
out on the running image, and an older image refuses the claimed scope at startup.
P2: the booking_ari stage (claimed with ARI sync and provisioning mutating) likewise needs an
image from the claimed-ARI list; a booking-only image refuses either mode mutating at startup,
so either one planned mutating counts as the ARI stage here."""
import json
from pathlib import Path
import sys

CLAIMED_ARI_MODES = {"PMS_CHANNEX_ARI_SYNC_MODE", "PMS_CHANNEX_PROVISIONING_MODE"}


def claimed_images(name="next-api-channex-claimed-compatible-images.txt"):
    path = Path(__file__).with_name(name)
    return {line.split()[1] for line in path.read_text().splitlines() if line.strip() and not line.startswith("#")}


def planned_claimed(plan):
    resources = [r for r in plan["planned_values"]["root_module"]["resources"]
                 if r["address"] == 'aws_ecs_task_definition.services["next-target-backend"]']
    if len(resources) != 1:
        raise ValueError("expected one planned next-api definition")
    containers = [c for c in json.loads(resources[0]["values"]["container_definitions"])
                  if c["name"] == "vayada-next-api"]
    if len(containers) != 1:
        raise ValueError("expected one planned next-api container")
    environment = containers[0].get("environment", [])
    return (any(e["name"] == "PMS_CHANNEX_SCOPE" for e in environment),
            any(e["name"] in CLAIMED_ARI_MODES and e.get("value") == "mutating" for e in environment))


def main():
    try:
        claimed, ari = planned_claimed(json.loads(Path(sys.argv[1]).read_text()))
        tasks = json.loads(Path(sys.argv[2]).read_text())["tasks"]
        digests = [c.get("imageDigest") for t in tasks for c in t["containers"] if c["name"] == "vayada-next-api"]
    except (IndexError, KeyError, TypeError, ValueError):
        sys.exit("claimed Channex image check failed: the plan or running tasks are unreadable")
    if not claimed and not ari:
        print("claimed Channex image check skipped: the plan declares no claimed scope")
        return
    if not digests or any(digest not in claimed_images() for digest in digests):
        sys.exit("claimed Channex image check failed: deploy a listed claimed-capable image before declaring the scope")
    if ari and any(digest not in claimed_images("next-api-channex-claimed-ari-compatible-images.txt") for digest in digests):
        sys.exit("claimed Channex image check failed: deploy a listed claimed-ARI-capable image before declaring booking_ari")
    print("claimed Channex image check passed")


if __name__ == "__main__":
    main()
