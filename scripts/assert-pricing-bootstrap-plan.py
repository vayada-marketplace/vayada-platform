#!/usr/bin/env python3
"""Check separate seven-create or two-update pricing plans; never apply."""
import hashlib
import json
from pathlib import Path
import re
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
METADATA_HASH = "3137c89b74dd2f059226f3f6c94c9fc6f11b335fd84240f3ed945fa398bed42f"


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


def check_metadata(plan):
    """Offline two-update content check; not live evidence, approval or execution."""
    check_source(SOURCE.read_bytes(), SOURCE.parent)
    template = (SOURCE.parent / "pricing_command_metadata_policy.json.tftpl").read_bytes()
    if hashlib.sha256(template).hexdigest() != METADATA_HASH:
        raise ValueError("Metadata declaration needs review")
    for name, value in (("aws_account_id", ACCOUNT), ("aws_region", REGION)):
        if plan["variables"][name]["value"] != value:
            raise ValueError("Unexpected account or region")
    if plan["variables"]["enable_pricing_command_metadata_refresh"]["value"] is not True:
        raise ValueError("Metadata stage must be explicit")
    boundary = json.loads((SOURCE.parent / "platform_writer_boundary.auto.tfvars.json").read_text())["platform_writer_boundary"]
    if (plan["variables"]["platform_writer_boundary"]["value"] != boundary
            or boundary.get("bootstrap_plan_role") is not True or boundary.get("enforce_trust") is not True
            or not boundary.get("revoke_before")):
        raise ValueError("Reviewed writer-boundary stage must remain installed")
    resources = plan["resource_changes"]
    by_address = {resource["address"]: resource for resource in resources}
    if len(by_address) != len(resources) or any(
            "previous_address" in resource or "importing" in resource["change"] for resource in resources):
        raise ValueError("Duplicate resources, moves and imports rejected")
    targets = {"aws_iam_role_policy.platform_plan[0]", "aws_iam_policy.platform_writer_boundary[0]"}
    changes = [r for r in resources if r["mode"] == "managed" and r["change"]["actions"] != ["no-op"]]
    if len(changes) != 2 or {r["address"] for r in changes} != targets:
        raise ValueError("Expected exactly two metadata updates")
    if any(r["change"]["actions"] != ["no-op"] for r in plan.get("resource_drift", [])) or any(
            c["actions"] != ["no-op"] for c in plan.get("output_changes", {}).values()):
        raise ValueError("Drift and output changes rejected")
    arns = []
    for key, name in sorted(NAMES.items()):
        resource = by_address[f'aws_secretsmanager_secret.pricing_command["{key}"]']
        change = resource["change"]
        before = change["before"]
        prefix = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:pricing-command/prod/{name}-"
        if (resource["mode"] != "managed" or change["actions"] != ["no-op"]
                or before != change["after"] or change.get("after_unknown")
                or before["name"] != f"pricing-command/prod/{name}"
                or not isinstance(before["arn"], str)
                or not re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9]{6}", before["arn"])):
            raise ValueError("Final secret identities must be known and unchanged")
        arns.append(before["arn"])
    for address, identity in ((ROLE, {"name": "vayada-pricing-command-execution",
                                     "arn": f"arn:aws:iam::{ACCOUNT}:role/vayada-pricing-command-execution"}),
                              (POLICY, {"name": "pricing-command-exact-secret-read",
                                        "role": "vayada-pricing-command-execution",
                                        "id": "vayada-pricing-command-execution:pricing-command-exact-secret-read"})):
        change = by_address[address]["change"]
        if (by_address[address]["mode"] != "managed" or change["actions"] != ["no-op"]
                or change["before"] != change["after"] or not change["before"]
                or any(change["before"].get(k) != v for k, v in identity.items()) or change.get("after_unknown")):
            raise ValueError("Existing execution role and policy must be known and unchanged")
    addition = json.loads(template.decode().replace("${secret_arns}", json.dumps(arns)).replace(
        "${role_arn}", json.dumps(f"arn:aws:iam::{ACCOUNT}:role/vayada-pricing-command-execution")))["Statement"]
    identities = {
        "aws_iam_role_policy.platform_plan[0]": {
            "name": "vayada-platform-plan", "role": "vayada-github-actions-platform-plan",
            "id": "vayada-github-actions-platform-plan:vayada-platform-plan"},
        "aws_iam_policy.platform_writer_boundary[0]": {
            "name": "vayada-platform-writer-boundary",
            "arn": f"arn:aws:iam::{ACCOUNT}:policy/vayada-platform-writer-boundary",
            "id": f"arn:aws:iam::{ACCOUNT}:policy/vayada-platform-writer-boundary"},
    }
    for resource in changes:
        change = resource["change"]
        before, after = change["before"], change["after"]
        if (change["actions"] != ["update"] or change.get("after_unknown")
                or any(before.get(k) != v for k, v in identities[resource["address"]].items())
                or {k: v for k, v in before.items() if k != "policy"} != {
                    k: v for k, v in after.items() if k != "policy"}):
            raise ValueError("Only known policy documents on exact targets may change")
        old, new = json.loads(before["policy"]), json.loads(after["policy"])
        if resource["address"] == "aws_iam_policy.platform_writer_boundary[0]":
            revoke = [s for s in old["Statement"] if s.get("Sid") == "RevokeSessionsBeforeReviewedCutover"]
            if revoke != [{"Sid": "RevokeSessionsBeforeReviewedCutover", "Effect": "Deny", "Action": "*",
                           "Resource": "*", "Condition": {"DateLessThan": {"aws:TokenIssueTime": boundary["revoke_before"]}}}]:
                raise ValueError("Installed reviewed cutoff must be present")
        if (not isinstance(old["Statement"], list) or not isinstance(new["Statement"], list)
                or any(s.get("Sid") in {a["Sid"] for a in addition} for s in old["Statement"])
                or {k: v for k, v in old.items() if k != "Statement"} != {
                    k: v for k, v in new.items() if k != "Statement"}
                or sorted(json.dumps(s, sort_keys=True) for s in old["Statement"] + addition) !=
                sorted(json.dumps(s, sort_keys=True) for s in new["Statement"])):
            raise ValueError("Only exact metadata statements may be added; existing grants and cutoff must stay")


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--check-source"]:
            check_source(SOURCE.read_bytes(), SOURCE.parent)
        elif len(sys.argv) == 3 and sys.argv[1] == "--metadata":
            with open(sys.argv[2]) as handle:
                check_metadata(json.load(handle))
        else:
            with open(sys.argv[1]) as handle:
                check(json.load(handle), SOURCE.read_bytes())
    except (ValueError, KeyError, TypeError, OSError, StopIteration, IndexError, AttributeError):
        sys.exit("Pricing bootstrap plan rejected; inspect securely, never publish raw plan data")
    print("Pricing metadata plan: exactly 2 updates; no apply" if sys.argv[1:2] == ["--metadata"] else
          "Pricing declaration checked" if sys.argv[1:] == ["--check-source"] else
          "Pricing bootstrap plan: exactly 7 creates, 0 updates/deletes/replacements; no apply")
