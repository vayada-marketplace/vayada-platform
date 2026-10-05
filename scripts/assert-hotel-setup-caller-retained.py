#!/usr/bin/env python3
"""Ordinary infrastructure apply must retain activated private caller wiring."""
import json
import sys

PREFIXES = ("HOTEL_SETUP_CREATION_COMMAND", "HOTEL_SETUP_COMMAND", "HOTEL_SETUP_LOGO_COMMAND")

def check(current, plan):
    containers = current["taskDefinition"]["containerDefinitions"]
    if len(containers) != 1:
        raise ValueError("Expected one serving API container")
    resources = plan["planned_values"]["root_module"]["resources"]
    tasks = [r["values"] for r in resources if r["type"] == "aws_ecs_task_definition" and r["values"].get("family") == "vayada-next-api"]
    if len(tasks) != 1:
        raise ValueError("Expected one planned API task")
    candidates = json.loads(tasks[0]["container_definitions"])
    if len(candidates) != 1:
        raise ValueError("Expected one planned API container")
    old, new = containers[0], candidates[0]
    def entries(container, field, value):
        result = {}
        for item in container.get(field) or []:
            if item["name"] in result:
                raise ValueError("Duplicate API configuration entry")
            result[item["name"]] = item[value]
        return result
    old_env, new_env = entries(old, "environment", "value"), entries(new, "environment", "value")
    old_secrets, new_secrets = entries(old, "secrets", "valueFrom"), entries(new, "secrets", "valueFrom")
    for prefix in PREFIXES:
        admission, origin, token = prefix + "_ADMISSION", prefix + "_ORIGIN", prefix + "_INTERNAL_TOKEN"
        if admission in old_secrets or admission in new_secrets:
            raise ValueError("Secret admission marker forbidden")
        if admission in old_env and admission not in new_env:
            raise ValueError("Installed setup admission cannot be removed")
        if old_env.get(admission) in ("enabled", "blocked") and new_env.get(admission) != old_env[admission]:
            raise ValueError("Ordinary apply must retain setup admission; use protected release")
        if origin in old_env or token in old_secrets:
            if (new_env.get(origin) != old_env.get(origin) or new_secrets.get(token) != old_secrets.get(token)):
                raise ValueError("Installed setup origin/token pair must be retained")

if __name__ == "__main__":
    try:
        check(json.load(open(sys.argv[1])), json.load(open(sys.argv[2])))
    except (ValueError, KeyError, TypeError, OSError) as error:
        sys.exit(f"Setup caller plan rejected: {error}")
    print("Installed setup caller retained")
