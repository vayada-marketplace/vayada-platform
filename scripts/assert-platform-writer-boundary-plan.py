#!/usr/bin/env python3
"""Reject weakening an installed writer boundary in a Terraform JSON plan."""
import json
import sys

SUBJECT = "repo:vayada-marketplace/vayada-platform:environment:platform-mutations-v2"
ROLE = "aws_iam_role.github_actions_platform_deploy"
POLICY = "aws_iam_policy.platform_writer_boundary[0]"
ATTACHMENT = "aws_iam_role_policy_attachment.platform_writer_boundary[0]"


def document(value):
    return json.loads(value) if isinstance(value, str) else (value or {})


def statements(value):
    return document(value).get("Statement", [])


def check(plan):
    for resource in plan.get("resource_changes", []):
        change = resource["change"]
        before, after = change.get("before") or {}, change.get("after") or {}
        address = resource.get("previous_address", resource["address"])
        is_role = address == ROLE or before.get("name") == "vayada-github-actions-platform-deploy"
        is_policy = address == POLICY or before.get("name") == "vayada-platform-writer-boundary"
        is_attachment = address == ATTACHMENT or (
            before.get("role") == "vayada-github-actions-platform-deploy"
            and str(before.get("policy_arn", "")).endswith(":policy/vayada-platform-writer-boundary")
        )
        if is_attachment and before:
            if any(before.get(field) != after.get(field) for field in ("role", "policy_arn")):
                raise ValueError("Installed writer-boundary attachment cannot be removed or repointed")
        if is_role:
            old = statements(before.get("assume_role_policy"))
            if any(SUBJECT == s.get("Condition", {}).get("StringEquals", {}).get(
                "token.actions.githubusercontent.com:sub") for s in old):
                if document(after.get("assume_role_policy")) != document(before.get("assume_role_policy")):
                    raise ValueError("Installed mutation-role trust cannot be changed by ordinary Terraform apply")
        if is_policy:
            old = [s for s in statements(before.get("policy"))
                   if s.get("Sid") == "RevokeSessionsBeforeReviewedCutover"]
            if not old:
                continue
            new = [s for s in statements(after.get("policy"))
                   if s.get("Sid") == "RevokeSessionsBeforeReviewedCutover"]
            if len(old) != 1 or len(new) != 1:
                raise ValueError("Installed session revocation must be retained")
            cutoff = old[0].get("Condition", {}).get("DateLessThan", {}).get("aws:TokenIssueTime")
            candidate = new[0].get("Condition", {}).get("DateLessThan", {}).get("aws:TokenIssueTime")
            expected = dict(old[0], Condition={"DateLessThan": {"aws:TokenIssueTime": candidate}})
            if not cutoff or not candidate or candidate < cutoff or new[0] != expected:
                raise ValueError("Session revocation may only retain or advance the reviewed cutoff")


if __name__ == "__main__":
    try:
        with open(sys.argv[1]) as handle:
            check(json.load(handle))
    except (ValueError, KeyError, TypeError, OSError) as error:
        sys.exit(f"Writer boundary plan rejected: {error}")
    print("Writer boundary retained")
