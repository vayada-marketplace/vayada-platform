#!/usr/bin/env python3
"""Allow only the reviewed seven empty pricing-resource creates; never apply."""
import hashlib
import json
from pathlib import Path
import sys

ACCOUNT = "269416271598"
REGION = "eu-west-1"
ROLE = "aws_iam_role.pricing_command_execution"
POLICY = "aws_iam_role_policy.pricing_command_secrets"
NAMES = {
    "identity_read": "identity-read-database-url",
    "owner_read": "owner-read-database-url",
    "owner_manage": "owner-manage-database-url",
    "public": "public-database-url",
    "internal_token": "internal-token",
}
SOURCE_HASH = "d86cde9408a3d9fccde0eb76270d32663a82ecf96dce74745d6d05704bd426b4"
SOURCE = Path(__file__).resolve().parents[1] / "infra/pricing_command_secrets.tf"


def check_source(source, directory):
    if hashlib.sha256(source).hexdigest() != SOURCE_HASH:
        raise ValueError("Pricing declaration needs a new review")
    if any(p.name in ("override.tf", "override.tf.json")
           or p.name.endswith(("_override.tf", "_override.tf.json")) for p in directory.iterdir()):
        raise ValueError("Terraform overrides cannot be included in this reviewed declaration")


def check(plan, source):
    check_source(source, SOURCE.parent)
    variables = plan["variables"]
    for name, value in (("aws_account_id", ACCOUNT), ("aws_region", REGION),
                        ("enable_pricing_command_metadata_refresh", False)):
        if variables[name]["value"] != value:
            raise ValueError("Unexpected account, region or activation stage")
    expected = {ROLE, POLICY} | {
        f'aws_secretsmanager_secret.pricing_command["{key}"]' for key in NAMES
    }
    resources = plan["resource_changes"]
    if any(r.get("previous_address") or r["change"].get("importing") for r in resources):
        raise ValueError("Imports and moves are not a seven-create bootstrap")
    changes = [r for r in resources if r["mode"] == "managed"
               and r["change"]["actions"] != ["no-op"]]
    if len(changes) != 7 or {r["address"] for r in changes} != expected:
        raise ValueError("Expected exactly seven pricing additions")
    for resource in changes:
        change = resource["change"]
        if (change["actions"] != ["create"] or change.get("before") is not None
                or resource.get("previous_address") or change.get("importing")):
            raise ValueError("Only new resources are allowed")
    for resource in plan.get("resource_drift", []):
        if resource["change"]["actions"] != ["no-op"]:
            raise ValueError("Unreviewed live drift")
    if any(c["actions"] != ["no-op"] for c in plan.get("output_changes", {}).values()):
        raise ValueError("Unexpected output changes")
    by_address = {r["address"]: r["change"] for r in changes}
    for key, name in NAMES.items():
        after = by_address[f'aws_secretsmanager_secret.pricing_command["{key}"]']["after"]
        if (after["name"] != f"pricing-command/prod/{name}"
                or after.get("kms_key_id") or after.get("policy")
                or after["tags"] != {"Project": "vayada", "Environment": "production",
                                     "Purpose": f"pricing-command-{key}"}):
            raise ValueError("Unexpected secret container configuration")
    role = by_address[ROLE]["after"]
    trust = {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"},
        "Action": "sts:AssumeRole", "Condition": {
            "StringEquals": {"aws:SourceAccount": ACCOUNT},
            "ArnLike": {"aws:SourceArn": f"arn:aws:ecs:{REGION}:{ACCOUNT}:*"},
        },
    }]}
    if (role["name"] != "vayada-pricing-command-execution"
            or role.get("managed_policy_arns") or role.get("inline_policy")
            or json.loads(role["assume_role_policy"]) != trust):
        raise ValueError("Unexpected execution role or trust")
    policy = by_address[POLICY]
    declarations = plan["configuration"]["root_module"]["resources"]
    expression = next(r for r in declarations if r["address"] == POLICY)["expressions"]
    if (policy["after"]["name"] != "pricing-command-exact-secret-read"
            or policy["after"].get("policy") is not None
            or policy["after"].get("role") is not None
            or policy.get("after_unknown", {}).get("policy") is not True
            or policy.get("after_unknown", {}).get("role") is not True
            or set(expression["role"]["references"]) != {
                "aws_iam_role.pricing_command_execution.id", "aws_iam_role.pricing_command_execution"}
            or set(expression["policy"]["references"]) != {"aws_secretsmanager_secret.pricing_command"}):
        raise ValueError("Unknown policy must come only from the reviewed five secret ARNs")


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--check-source"]:
            check_source(SOURCE.read_bytes(), SOURCE.parent)
        else:
            with open(sys.argv[1]) as handle:
                check(json.load(handle), SOURCE.read_bytes())
    except (ValueError, KeyError, TypeError, OSError, StopIteration, IndexError):
        sys.exit("Pricing bootstrap plan rejected; inspect securely, never publish raw plan data")
    print("Pricing declaration checked" if sys.argv[1:] == ["--check-source"] else
          "Pricing bootstrap plan: exactly 7 creates, 0 updates/deletes/replacements; no apply")
