#!/usr/bin/env python3
"""Reject any bootstrap mutation beyond the nine new finance resources."""
import json
from pathlib import Path
import sys

EXPECTED = {
    "aws_ecs_cluster.finance_export_once",
    "aws_iam_policy.finance_export_refresh",
    "aws_iam_role.finance_export_controller",
    "aws_iam_role.finance_export_once",
    "aws_iam_role.finance_export_once_writer",
    "aws_iam_role_policy.finance_export_controller",
    "aws_iam_role_policy.finance_export_once_assume_writer",
    "aws_iam_role_policy.finance_export_once_write",
    "aws_iam_role_policy_attachment.finance_export_refresh",
}


def validate(plan):
    changes = [r for r in plan.get("resource_changes", []) if r["change"]["actions"] != ["no-op"]]
    if len(changes) != len(EXPECTED) or {r["address"] for r in changes} != EXPECTED:
        raise ValueError("finance_bootstrap_scope_mismatch")
    if any(r["change"]["actions"] != ["create"] for r in changes):
        raise ValueError("finance_bootstrap_not_create_only")
    if plan.get("errored") or any(r.get("change", {}).get("importing") for r in changes):
        raise ValueError("finance_bootstrap_invalid_plan")


if __name__ == "__main__":
    validate(json.loads(Path(sys.argv[1]).read_text()))
    print("Finance bootstrap: exactly nine creations; no existing resource changes.")
