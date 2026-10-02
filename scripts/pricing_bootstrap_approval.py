"""Same-process exact-plan approval gate. No AWS, Terraform or apply entry point.

The future executor must run all plan/source/identity/hold/authorization guards
before constructing this gate and again before consuming approval. Receipt
metadata and comment evidence alone do not establish those prerequisites.
"""
import copy
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import stat
import subprocess
import threading

REPOSITORY = "vayada-marketplace/vayada-platform"
# Human-selected accountable owner, not authorization for a runner/session.
# Stable IAM ID was read with GetUser; never infer ownership from credentials.
SELECTED_OPERATOR_ARN = "arn:aws:iam::269416271598:user/VayadaUser"
SELECTED_OPERATOR_ID = "AIDAT5OTWB3XLUEYGCQ56"
# Flamur explicitly selected GitHub User FlamurMaliqi; bind its stable ID, not login.
# Never load approvers from dispatch inputs, comments or the process environment.
APPROVED_HUMAN_IDS = frozenset({120040061})
CONTEXT_FIELDS = frozenset({
    "sourceSha", "runId", "runAttempt", "operatorArn", "stateLineage", "stateSerial",
    "planSha256", "writerHoldSha256", "authorizationSha256",
})
# Only these reviewed read/validation workflows may remain active in this
# diagnostic. No setup-runner exception is configured or silently inferred.
READ_WORKFLOWS = frozenset({".github/workflows/tf-plan.yml", ".github/workflows/tf-validate.yml"})
EDIT_QUERY = """query($id: ID!) {
  node(id: $id) {
    ... on IssueComment {
      id fullDatabaseId body createdAt updatedAt lastEditedAt
      editor { id } isMinimized author { id __typename }
    }
  }
}"""

MAX_PLAN_BYTES = 64 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]


def saved_plan_digest(fd):
    """Hash only a private, anonymous, kernel-sealed Linux plan descriptor."""
    if not hasattr(os, "memfd_create"):
        raise ValueError("Saved plan custody requires Linux sealing")
    try:
        if type(fd) is not int or fd < 0:
            raise ValueError
        info = os.fstat(fd)
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 0
                or not 0 < info.st_size <= MAX_PLAN_BYTES
                or fcntl.fcntl(fd, fcntl.F_GET_SEALS) & seals != seals):
            raise ValueError
        digest = hashlib.sha256()
        for offset in range(0, info.st_size, 1024 * 1024):
            size = min(1024 * 1024, info.st_size - offset)
            chunk = os.pread(fd, size, offset)
            if len(chunk) != size:
                raise ValueError
            digest.update(chunk)
        return digest.hexdigest()
    except (OSError, ValueError, OverflowError):
        raise ValueError("Saved plan binding rejected") from None


@contextmanager
def sealed_saved_plan(path, expected_sha256):
    """Keep exact approved bytes private and immutable; no Terraform/AWS call."""
    if not hasattr(os, "memfd_create"):
        raise ValueError("Saved plan custody requires Linux sealing")
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Invalid saved plan digest")
    fd = None
    try:
        try:
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
                info = os.fstat(source.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                        or not 0 < info.st_size <= MAX_PLAN_BYTES):
                    raise ValueError
                fd = os.memfd_create("pricing-plan", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
                os.fchmod(fd, 0o600)
                with os.fdopen(os.dup(fd), "wb") as target:
                    remaining = info.st_size
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError
                        target.write(chunk)
                        remaining -= len(chunk)
                    if source.read(1):
                        raise ValueError
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS,
                        fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
            if saved_plan_digest(fd) != expected_sha256:
                raise ValueError
            os.lseek(fd, 0, os.SEEK_SET)
        except (OSError, TypeError, ValueError, OverflowError):
            raise ValueError("Saved plan binding rejected") from None
        yield fd
    finally:
        if fd is not None:
            os.close(fd)


def guard_saved_plan(plan_fd, expected_sha256):
    """Read-only guards on the sealed bytes; not source/session admission or apply."""
    if saved_plan_digest(plan_fd) != expected_sha256:
        raise ValueError("Saved plan differs from receipt")
    try:
        pricing = runpy.run_path(str(ROOT / "scripts/assert-pricing-bootstrap-plan.py"))
        writer = runpy.run_path(str(ROOT / "scripts/assert-platform-writer-boundary-plan.py"))
        source = pricing["SOURCE"].read_bytes()
        pricing["check_source"](source, pricing["SOURCE"].parent)
        # Inspection needs no runner credentials, TF_VAR values, logging,
        # CLI injections, shell startup hooks or user Terraform configuration.
        env = {"PATH": os.environ["PATH"], "HOME": "/nonexistent",
               "TF_CLI_CONFIG_FILE": os.devnull, "TF_IN_AUTOMATION": "true",
               "TF_INPUT": "false", "AWS_EC2_METADATA_DISABLED": "true"}
        options = {"cwd": ROOT / "infra", "env": env, "pass_fds": (plan_fd,),
                   "capture_output": True, "text": True, "timeout": 120}
        path = f"/proc/self/fd/{plan_fd}"
        result = subprocess.run(["terraform", "show", "-json", path], **options)
        if result.returncode or len(result.stdout) > MAX_PLAN_BYTES:
            raise ValueError
        plan = json.loads(result.stdout)
        if not isinstance(plan, dict):
            raise ValueError
        writer["check"](plan)
        pricing["check"](plan, source)
        result = subprocess.run(["bash", str(ROOT / "scripts/guard-finance-folio-kms-plan.sh"),
                                 path, "plan"], **options)
        if result.returncode:
            raise ValueError
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, StopIteration,
            UnicodeError, subprocess.TimeoutExpired):
        raise ValueError("Saved pricing plan guards rejected; raw output withheld") from None


def _github_json(path, *, node_id=None):
    """Fixed-host GETs or the fixed read-only GraphQL query; no raw error output."""
    args = ["gh", "api", "--hostname", "github.com"]
    if node_id is not None:
        if path != "graphql":
            raise ValueError("Invalid approval API endpoint")
        args += ["graphql", "--method", "POST", "-f", "query=" + EDIT_QUERY, "-f", "id=" + node_id]
    else:
        if not path.startswith(f"repos/{REPOSITORY}/"):
            raise ValueError("Invalid approval API endpoint")
        args += [path, "--method", "GET"]
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=20)
        if result.returncode or len(result.stdout) > 2_000_000:
            raise ValueError("Approval API evidence unavailable")
        data = json.loads(result.stdout)
        if not isinstance(data, dict) or data.get("errors"):
            raise ValueError("Invalid approval API evidence")
        return data
    except (OSError, subprocess.TimeoutExpired, UnicodeError, json.JSONDecodeError):
        raise ValueError("Approval API evidence unavailable") from None


def read_github_comment(comment_id):
    if type(comment_id) is not int or comment_id < 1:
        raise ValueError("Invalid approval comment ID")
    comment = _github_json(f"repos/{REPOSITORY}/issues/comments/{comment_id}")
    node_id = comment.get("node_id")
    user = comment.get("user")
    if (type(comment.get("id")) is not int or comment["id"] != comment_id
            or not isinstance(node_id, str) or not re.fullmatch(r"[A-Za-z0-9_=-]{1,200}", node_id)
            or not isinstance(user, dict) or not isinstance(user.get("node_id"), str)
            or not re.fullmatch(r"[A-Za-z0-9_=-]{1,200}", user["node_id"])):
        raise ValueError("Invalid approval comment identity")
    response = _github_json("graphql", node_id=node_id)
    data = response.get("data")
    node = data.get("node") if isinstance(data, dict) else None
    if (not isinstance(node, dict) or node.get("id") != node_id
            or type(node.get("fullDatabaseId")) not in (int, str)
            or str(node["fullDatabaseId"]) != str(comment_id)
            or node.get("author") != {"id": user["node_id"], "__typename": user.get("type")}
            or any(field not in node or node[field] != comment.get(rest) for field, rest in (
                ("body", "body"), ("createdAt", "created_at"), ("updatedAt", "updated_at")))):
        raise ValueError("Approval API snapshots disagree")
    try:
        comment["editEvidence"] = {field: node[field] for field in
                                   ("id", "fullDatabaseId", "lastEditedAt", "editor", "isMinimized")}
    except KeyError:
        raise ValueError("Missing approval edit evidence") from None
    return comment


def observe_workflow_pause():
    """Observe manual disable/drain only; not an enforced all-writer hold."""
    response = _github_json(f"repos/{REPOSITORY}/actions/workflows?per_page=100")
    workflows = response.get("workflows")
    if (not isinstance(workflows, list) or type(response.get("total_count")) is not int
            or not 1 <= response["total_count"] <= 100 or len(workflows) != response["total_count"]):
        raise ValueError("Incomplete workflow inventory")
    seen_ids, seen_paths, inventory, read_ids = set(), set(), [], set()
    for workflow in workflows:
        if not isinstance(workflow, dict):
            raise ValueError("Invalid workflow inventory")
        identity, path, state = (workflow.get(field) for field in ("id", "path", "state"))
        if (type(identity) is not int or identity < 1 or identity in seen_ids
                or not isinstance(path, str) or path in seen_paths
                or not re.fullmatch(r"\.github/workflows/[A-Za-z0-9_-]+\.ya?ml", path)):
            raise ValueError("Invalid workflow inventory")
        seen_ids.add(identity)
        seen_paths.add(path)
        if path in READ_WORKFLOWS:
            if state not in ("active", "disabled_manually"):
                raise ValueError("Unreviewed validation workflow state")
            read_ids.add(identity)
        elif state != "disabled_manually":
            raise ValueError("Writer workflow is not manually paused")
        inventory.append({"id": identity, "path": path, "state": state})
    if not READ_WORKFLOWS <= seen_paths:
        raise ValueError("Required workflow inventory missing")
    # All nonterminal statuses, without a main/date filter that could hide an
    # old waiting or queued writer. Large/truncated responses fail closed.
    seen_runs = set()
    for status in ("queued", "in_progress", "waiting", "pending", "requested"):
        response = _github_json(f"repos/{REPOSITORY}/actions/runs?status={status}&per_page=100")
        runs = response.get("workflow_runs")
        if (not isinstance(runs, list) or type(response.get("total_count")) is not int
                or not 0 <= response["total_count"] <= 100 or len(runs) != response["total_count"]):
            raise ValueError("Incomplete workflow-run inventory")
        for run in runs:
            if (not isinstance(run, dict) or type(run.get("id")) is not int
                    or run["id"] < 1 or run["id"] in seen_runs
                    or type(run.get("workflow_id")) is not int
                    or run["workflow_id"] not in read_ids or run.get("status") != status):
                raise ValueError("Invalid run inventory or a nonterminal writer remains")
            seen_runs.add(run["id"])
    return {"repository": REPOSITORY, "scope": "workflow-disable-observation-only",
            "workflows": sorted(inventory, key=lambda item: item["id"])}


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
            "operatorOwner": {"arn": SELECTED_OPERATOR_ARN, "userId": SELECTED_OPERATOR_ID},
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

    def fetch_and_consume(self, comment_id, current_context):
        """Fresh authenticated evidence; caller must first rerun real guards."""
        if not APPROVED_HUMAN_IDS:
            raise ValueError("No approved humans configured")
        if os.getpid() != self._pid:
            raise ValueError("Approval gate belongs to another process")
        self.consume(read_github_comment(comment_id), current_context)

    def fetch_and_consume_saved_plan(self, comment_id, current_context, plan_fd):
        """Future runner must guard/show/apply this same live sealed descriptor.

        Other source/session/state/hold/authorization guards are still required.
        The caller must keep sealed_saved_plan open and pass this FD to Terraform.
        """
        if os.getpid() != self._pid:
            raise ValueError("Approval gate belongs to another process")
        guard_saved_plan(plan_fd, self._context["planSha256"])
        self.fetch_and_consume(comment_id, current_context)
        return f"/proc/self/fd/{plan_fd}"


if __name__ == "__main__":
    raise SystemExit("Approval component only; no setup executor or approved sessions configured")
