#!/usr/bin/env python3
"""Read a known export activation flag; malformed/unknown plans must fail closed."""
import json
import sys


def mode(plan):
    resources = [r for r in plan["planned_values"]["root_module"]["resources"]
                 if r["address"] == 'aws_ecs_task_definition.services["next-target-backend"]']
    if len(resources) != 1:
        raise ValueError("expected one planned next-api definition")
    containers = [c for c in json.loads(resources[0]["values"]["container_definitions"])
                  if c["name"] == "vayada-next-api"]
    if len(containers) != 1:
        raise ValueError("expected one planned next-api container")
    flags = [e["value"] for e in containers[0]["environment"]
             if e["name"] == "FINANCE_EXPORT_WORKER_ENABLED"]
    if len(flags) != 1 or flags[0] not in ("true", "false"):
        raise ValueError("expected one explicit export enabled flag")
    return flags[0]


if __name__ == "__main__":
    try:
        with open(sys.argv[1]) as source:
            print(mode(json.load(source)))
    except (KeyError, TypeError, ValueError, IndexError):
        sys.exit("Finance export plan is missing a known, explicit activation state")
