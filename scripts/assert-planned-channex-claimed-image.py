#!/usr/bin/env python3
"""VAY-2108: Terraform may declare the claimed Channex scope only while every running
next-api task uses an image that recognises it. tf-apply rolls the new task definition
out on the running image, and an older image refuses the claimed scope at startup."""
import json
from pathlib import Path
import sys


def claimed_images():
    path = Path(__file__).with_name("next-api-channex-claimed-compatible-images.txt")
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
    return any(e["name"] == "PMS_CHANNEX_SCOPE" for e in containers[0].get("environment", []))


def main():
    try:
        claimed = planned_claimed(json.loads(Path(sys.argv[1]).read_text()))
        tasks = json.loads(Path(sys.argv[2]).read_text())["tasks"]
        digests = [c.get("imageDigest") for t in tasks for c in t["containers"] if c["name"] == "vayada-next-api"]
    except (IndexError, KeyError, TypeError, ValueError):
        sys.exit("claimed Channex image check failed: the plan or running tasks are unreadable")
    if not claimed:
        print("claimed Channex image check skipped: the plan declares no claimed scope")
        return
    if not digests or any(digest not in claimed_images() for digest in digests):
        sys.exit("claimed Channex image check failed: deploy a listed claimed-capable image before declaring the scope")
    print("claimed Channex image check passed")


if __name__ == "__main__":
    main()
