"""Same-process exact-plan approval gate. No AWS, Terraform or apply entry point.

The future executor must run all plan/source/identity/hold/authorization guards
before constructing this gate and again before consuming approval. Receipt
metadata and comment evidence alone do not establish those prerequisites.
"""
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
import secrets
import threading

REPOSITORY = "vayada-marketplace/vayada-platform"
# Empty until the human identities are explicitly chosen and reviewed in code.
# Never load approvers from dispatch inputs, comments or the process environment.
APPROVED_HUMAN_IDS = frozenset()
CONTEXT_FIELDS = frozenset({
    "sourceSha", "runId", "runAttempt", "operatorArn", "stateLineage", "stateSerial",
    "planSha256", "writerHoldSha256", "authorizationSha256",
})


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise ValueError("Invalid approval timestamp")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def validate_context(context):
    if not isinstance(context, dict) or set(context) != CONTEXT_FIELDS:
        raise ValueError("Incomplete approval context")
    for field, length in (("sourceSha", 40), ("planSha256", 64), ("writerHoldSha256", 64),
                          ("authorizationSha256", 64)):
        if not isinstance(context[field], str) or not re.fullmatch(r"[0-9a-f]{" + str(length) + "}", context[field]):
            raise ValueError("Invalid approval digest")
    for field in ("runId", "runAttempt", "stateSerial"):
        if type(context[field]) is not int or context[field] < (0 if field == "stateSerial" else 1):
            raise ValueError("Invalid approval run or state metadata")
    if not isinstance(context["stateLineage"], str) or not re.fullmatch(
            r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", context["stateLineage"]):
        raise ValueError("Invalid state lineage")
    if not isinstance(context["operatorArn"], str) or not re.fullmatch(
            r"arn:aws:sts::269416271598:assumed-role/[A-Za-z0-9+=,.@_-]+/[A-Za-z0-9+=,.@_-]+",
            context["operatorArn"]):
        raise ValueError("Invalid operator session metadata")


class ApprovalGate:
    def __init__(self, context, issue_number, *, now=None):
        validate_context(context)
        if type(issue_number) is not int or issue_number < 1:
            raise ValueError("Invalid approval discussion")
        now = now or datetime.now(timezone.utc)
        if now.tzinfo != timezone.utc:
            raise ValueError("Approval clock must be UTC")
        now = now.replace(microsecond=0)
        self._context = copy.deepcopy(context)
        self._issued = now
        self._expires = now + timedelta(minutes=15)
        self._issue_url = f"https://api.github.com/repos/{REPOSITORY}/issues/{issue_number}"
        self._receipt = {
            "schemaVersion": 1, "phase": "creation", "repository": REPOSITORY,
            "accountId": "269416271598", "region": "eu-west-1",
            "stateObject": "s3://vayada-terraform-state/platform/terraform.tfstate",
            "guard": "exact-seven-empty-pricing-creates", "context": copy.deepcopy(context),
            "expectedSecurity": {
                "additions": 7, "updates": 0, "deletions": 0,
                "secretNames": ["pricing-command/prod/" + name for name in (
                    "identity-read-database-url", "owner-read-database-url",
                    "owner-manage-database-url", "public-database-url", "internal-token")],
                "secretValuesManaged": False,
                "executionRole": "vayada-pricing-command-execution",
                "trustService": "ecs-tasks.amazonaws.com", "trustAction": "sts:AssumeRole",
                "sourceAccount": "269416271598",
                "sourceArn": "arn:aws:ecs:eu-west-1:269416271598:*",
                "inlinePolicy": "pricing-command-exact-secret-read",
                "policyAction": "secretsmanager:GetSecretValue",
                "policyResources": "Only the five generated exact secret ARNs",
                "extraRolePolicies": False, "metadataPhaseEnabled": False,
            },
            "issueNumber": issue_number, "issuedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "expiresAt": self._expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "nonce": secrets.token_hex(32),
        }
        self._digest = hashlib.sha256(json.dumps(self._receipt, sort_keys=True,
                                                separators=(",", ":")).encode()).hexdigest()
        self._consumed = False
        self._pid = os.getpid()
        self._lock = threading.Lock()

    def _not_copyable(self, *args):
        raise TypeError("Approval gate cannot be copied or serialized")

    __copy__ = __deepcopy__ = __reduce_ex__ = _not_copyable

    def receipt(self):
        # Only the allowlisted metadata above can be published, never raw plans.
        return {"receipt": copy.deepcopy(self._receipt), "receiptSha256": self._digest}

    def approval_text(self):
        return f"approve-vay1543-bootstrap {self._digest} {self._receipt['nonce']}"

    def check_comment(self, comment, *, now=None):
        now = now or datetime.now(timezone.utc)
        if os.getpid() != self._pid:
            raise ValueError("Approval gate belongs to another process")
        if now.tzinfo != timezone.utc or self._consumed or not self._issued <= now < self._expires:
            raise ValueError("Approval expired or consumed")
        if not isinstance(comment, dict) or not isinstance(comment.get("user"), dict):
            raise ValueError("Invalid approval API evidence")
        user = comment.get("user") or {}
        edit = comment.get("editEvidence")
        if (not isinstance(edit, dict)
                or set(edit) != {"id", "fullDatabaseId", "lastEditedAt", "editor", "isMinimized"}
                or not isinstance(comment.get("node_id"), str) or not comment["node_id"]
                or edit["id"] != comment["node_id"]
                or type(edit["fullDatabaseId"]) not in (int, str)
                or str(edit["fullDatabaseId"]) != str(comment.get("id"))
                or edit["lastEditedAt"] is not None or edit["editor"] is not None
                or edit["isMinimized"] is not False):
            raise ValueError("Missing or inconsistent GitHub edit evidence")
        if (type(user.get("id")) is not int or user["id"] not in APPROVED_HUMAN_IDS
                or user.get("type") != "User" or comment.get("performed_via_github_app") is not None
                or type(comment.get("id")) is not int or comment["id"] < 1
                or comment.get("issue_url") != self._issue_url
                or comment.get("body") != self.approval_text()
                or comment.get("created_at") != comment.get("updated_at")
                or "performed_via_github_app" not in comment):
            raise ValueError("Approval does not match the reviewed human and receipt")
        # GitHub timestamps have second resolution: require a later second,
        # never a pre-existing or same-second approval.
        if not self._issued < timestamp(comment.get("created_at")) <= now:
            raise ValueError("Approval must follow the receipt")

    def consume(self, comment, current_context, *, now=None):
        """Use fresh API comment + guarded context immediately before any apply.

        Consume before attempting apply. Failure must not retry with this gate.
        There is intentionally no serialization/resume or apply implementation.
        """
        # Check PID before acquiring: a fork can inherit a parent-held lock.
        if os.getpid() != self._pid:
            raise ValueError("Approval gate belongs to another process")
        with self._lock:
            validate_context(current_context)
            if current_context != self._context:
                raise ValueError("Source, plan, session, state or guard evidence changed")
            self.check_comment(comment, now=now)
            self._consumed = True


if __name__ == "__main__":
    raise SystemExit("Approval component only; no setup executor or approved operators configured")
