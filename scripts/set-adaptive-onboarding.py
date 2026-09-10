"""Apply the explicitly requested next Marketplace runtime flag to a rendered task."""
import json
import os
import sys
from pathlib import Path


def main():
    state = os.environ.get("ADAPTIVE_ONBOARDING") or "preserve"
    if state == "preserve":
        return
    if state not in ("enabled", "disabled"):
        raise ValueError("Unknown adaptive onboarding state")
    if (os.environ.get("SERVICE") != "next-marketplace-frontend"
            or os.environ.get("ENVIRONMENT") != "next"
            or os.environ.get("EVENT_NAME") != "workflow_dispatch"):
        raise ValueError("Adaptive onboarding changes require manual next Marketplace deployment")
    if sys.argv[1:] == ["--validate-only"]:
        return
    path = Path(os.environ["TASK_DEFINITION"])
    task = json.loads(path.read_text())
    if task.get("family") != "vayada-next-marketplace-frontend":
        raise ValueError("Unexpected task family")
    containers = [c for c in task["containerDefinitions"]
                  if c["name"] == "vayada-next-marketplace-frontend"]
    if len(containers) != 1:
        raise ValueError("Expected exactly one Marketplace container")
    container = containers[0]
    current = json.loads(Path(os.environ["CURRENT_TASK_DEFINITION"]).read_text())
    current_containers = [c for c in current["containerDefinitions"]
                          if c["name"] == "vayada-next-marketplace-frontend"]
    if len(current_containers) != 1 or current_containers[0]["image"] != container["image"]:
        raise ValueError("Flag changes must preserve the currently deployed image; refresh deployment inputs")
    flag = "HOTEL_SETUP_ADAPTIVE_SHELL_ENABLED"
    container["environment"] = [e for e in container.get("environment", [])
                                if e["name"] != flag]
    container["environment"].append({"name": flag, "value": str(state == "enabled").lower()})
    path.write_text(json.dumps(task))


if __name__ == "__main__":
    main()
