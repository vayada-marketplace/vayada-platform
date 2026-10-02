import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import importlib.util
import fcntl
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import pickle
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("approval", ROOT / "scripts/pricing_bootstrap_approval.py")
approval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approval)
pricing_fixture = approval.runpy.run_path(str(ROOT / "scripts/test_pricing_bootstrap_plan.py"))["fixture"]
NOW = datetime(2030, 1, 1, tzinfo=timezone.utc)


def runtime_result():
    return subprocess.CompletedProcess([], 0, json.dumps({
        "terraform_version": "1.5.7", "platform": "linux_amd64", "provider_selections": {
            "registry.terraform.io/hashicorp/aws": "5.100.0",
            "registry.terraform.io/cloudflare/cloudflare": "4.52.7"}}), "SECRET_SENTINEL")


def context():
    return {"sourceSha": "a" * 40, "runId": 123, "runAttempt": 1,
            "operatorArn": "arn:aws:sts::269416271598:assumed-role/vayada-pricing-operator-create/session",
            "stateLineage": "00000000-0000-0000-0000-000000000001", "stateSerial": 7,
            "planSha256": "b" * 64, "writerHoldSha256": "c" * 64, "authorizationSha256": "d" * 64}


def comment(gate):
    return {"id": 50, "node_id": "IC_fixture", "user": {"id": 42, "type": "User"},
            "issue_url": "https://api.github.com/repos/vayada-marketplace/vayada-platform/issues/344",
            "body": gate.approval_text(), "performed_via_github_app": None,
            "created_at": "2030-01-01T00:00:01Z", "updated_at": "2030-01-01T00:00:01Z",
            "editEvidence": {"id": "IC_fixture", "fullDatabaseId": "50",
                             "lastEditedAt": None, "editor": None, "isMinimized": False}}


def api_comment(gate):
    rest = comment(gate)
    rest["id"] = 5931916571
    rest["user"]["node_id"] = "U_fixture"
    rest.pop("editEvidence")
    node = {"id": rest["node_id"], "fullDatabaseId": str(rest["id"]),
            "author": {"id": "U_fixture", "__typename": "User"},
            "body": rest["body"], "createdAt": rest["created_at"], "updatedAt": rest["updated_at"],
            "lastEditedAt": None, "editor": None, "isMinimized": False}
    return rest, {"data": {"node": node}}


def paused_workflows():
    return {"total_count": 3, "workflows": [
        {"id": 1, "path": ".github/workflows/tf-plan.yml", "state": "active"},
        {"id": 2, "path": ".github/workflows/tf-validate.yml", "state": "active"},
        {"id": 3, "path": ".github/workflows/tf-apply.yml", "state": "disabled_manually"},
    ]}


class OperatorTemplateTests(unittest.TestCase):
    """Offline declaration checks, not actual-role admission/enforcement proof."""

    def render(self, name):
        source = (ROOT / "deployment" / name).read_text()
        self.assertEqual(source.count("${window_start}"), 1 if "trust" in name else 2)
        self.assertEqual(source.count("${window_end}"), 1)
        return json.loads(source.replace("${window_start}", "2030-01-01T00:00:00Z")
                         .replace("${window_end}", "2030-01-01T01:00:00Z"))

    def test_trust_requires_selected_stable_owner_mfa_source_and_window(self):
        policy = self.render("pricing-operator-trust.json.tftpl")
        self.assertEqual(policy, {"Version": "2012-10-17", "Statement": [{
            "Sid": "SelectedOwnerWithMFAOnly", "Effect": "Allow",
            "Principal": {"AWS": approval.SELECTED_OPERATOR_ARN},
            "Action": ["sts:AssumeRole", "sts:SetSourceIdentity"],
            "Condition": {
                "StringEquals": {"aws:userid": approval.SELECTED_OPERATOR_ID,
                                 "sts:SourceIdentity": approval.SELECTED_OPERATOR_ID},
                "Bool": {"aws:MultiFactorAuthPresent": "true"},
                "DateGreaterThanEquals": {"aws:CurrentTime": "2030-01-01T00:00:00Z"},
                "DateLessThan": {"aws:CurrentTime": "2030-01-01T01:00:00Z"},
            },
        }]})

    def test_no_mfa_pilot_only_changes_the_explicit_admission_factor(self):
        expected = self.render("pricing-operator-trust.json.tftpl")
        expected["Statement"][0]["Sid"] = "SelectedOwnerNoMFAPilotOnly"
        del expected["Statement"][0]["Condition"]["Bool"]
        self.assertEqual(self.render("pricing-operator-trust-no-mfa.json.tftpl"), expected)

    def test_fence_is_deny_only_and_rejects_missing_session_attribution(self):
        policy = self.render("pricing-operator-session-fence.json.tftpl")
        statements = {s["Sid"]: s for s in policy["Statement"]}
        expected = {
            "BeforeWindow": {"DateLessThan": {"aws:CurrentTime": "2030-01-01T00:00:00Z"}},
            "ExpireIssuedSessions": {"DateGreaterThanEquals": {"aws:CurrentTime": "2030-01-01T01:00:00Z"}},
            "RejectEarlierOrMissingSessions": {"DateLessThanIfExists": {"aws:TokenIssueTime": "2030-01-01T00:00:00Z"}},
            "SelectedSourceIdentityOnly": {"StringNotEqualsIfExists": {"aws:SourceIdentity": approval.SELECTED_OPERATOR_ID}},
        }
        self.assertEqual(policy["Version"], "2012-10-17")
        self.assertEqual(len(policy["Statement"]), 5)
        self.assertEqual(set(statements), set(expected) | {"NeverPassOrChainRoles"})
        for sid, condition in expected.items():
            self.assertEqual(statements[sid], {"Sid": sid, "Effect": "Deny", "Action": "*",
                                               "Resource": "*", "Condition": condition})
        self.assertEqual(statements["NeverPassOrChainRoles"], {
            "Sid": "NeverPassOrChainRoles", "Effect": "Deny", "Resource": "*",
            "Action": ["iam:PassRole", "sts:AssumeRole", "sts:AssumeRoleWithWebIdentity", "sts:AssumeRoleWithSAML"],
        })


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        source_patch = patch.object(approval, "verify_checkout_source")
        self.source = source_patch.start()
        self.addCleanup(source_patch.stop)

    def test_incompatible_runtime_rejects_before_show_or_approval(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        runtime = json.loads(runtime_result().stdout)
        bodies = [None, [], {}, runtime | {"terraform_version": "1.5.6"},
                  runtime | {"platform": "linux_arm64"}, runtime | {"provider_selections": None},
                  runtime | {"provider_selections": runtime["provider_selections"] | {
                      "registry.terraform.io/hashicorp/aws": "5.99.0"}},
                  runtime | {"provider_selections": runtime["provider_selections"] | {"extra": "1.0.0"}}]
        for field in runtime:
            bodies.append({key: value for key, value in runtime.items() if key != field})
        results = [subprocess.CompletedProcess([], 0, json.dumps(body), "SECRET_SENTINEL") for body in bodies]
        results += [subprocess.CompletedProcess([], 1, "SECRET_SENTINEL", "SECRET_SENTINEL"),
                    subprocess.CompletedProcess([], 0, "SECRET_SENTINEL", ""),
                    subprocess.CompletedProcess([], 0, "x" * 16_385, ""),
                    OSError("SECRET_SENTINEL"), subprocess.TimeoutExpired("SECRET_SENTINEL", 120)]
        for result in results:
            with self.subTest(result=type(result).__name__), \
                    patch.object(approval, "saved_plan_digest", return_value=context()["planSha256"]), \
                    patch.object(approval.subprocess, "run", side_effect=[result]) as run, \
                    patch.object(approval, "_github_json") as api, self.assertRaises(ValueError) as error:
                gate.fetch_and_consume_saved_plan(50, context(), 123)
            self.assertNotIn("SECRET_SENTINEL", str(error.exception))
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0], ["terraform", "version", "-json"])
            api.assert_not_called()
            self.assertFalse(gate._consumed)

    def test_runtime_selection_matches_committed_provider_lock(self):
        lock = (ROOT / "infra/.terraform.lock.hcl").read_text()
        runtime = json.loads(runtime_result().stdout)
        for name, version in runtime["provider_selections"].items():
            declaration = lock.split(f'provider "{name}" {{', 1)[1].split("}", 1)[0]
            self.assertIn(f'version     = "{version}"', declaration)

    def test_saved_plan_custody_requires_linux_before_reading_anything(self):
        with patch.object(approval, "os", spec=["open"]) as platform:
            with self.assertRaisesRegex(ValueError, "requires Linux"):
                with approval.sealed_saved_plan("SECRET_SENTINEL", "b" * 64):
                    self.fail("Unsupported platform accepted")
            with self.assertRaisesRegex(ValueError, "requires Linux"):
                approval.saved_plan_digest(1)
            platform.open.assert_not_called()

    def test_valid_approval_is_one_use_and_not_resumable(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})):
            gate.consume(comment(gate), context(), now=NOW + timedelta(seconds=2))
            with self.assertRaises(ValueError):
                gate.consume(comment(gate), context(), now=NOW + timedelta(seconds=3))
            fresh = approval.ApprovalGate(context(), 344, now=NOW)
            self.assertNotEqual(gate.approval_text(), fresh.approval_text())
            with self.assertRaises(ValueError):
                fresh.consume(comment(gate), context(), now=NOW + timedelta(seconds=3))

    def test_only_explicit_selected_github_user_can_approve(self):
        self.assertEqual(approval.APPROVED_HUMAN_IDS, frozenset({120040061}))
        for user in ({"id": 42, "type": "User", "login": "FlamurMaliqi"},
                     {"id": "120040061", "type": "User"}, {"id": True, "type": "User"},
                     {"id": 120040061, "type": "Bot"}):
            gate = approval.ApprovalGate(context(), 344, now=NOW)
            with self.subTest(user=user), self.assertRaises(ValueError):
                gate.consume(comment(gate) | {"user": user}, context(), now=NOW + timedelta(seconds=2))
            self.assertFalse(gate._consumed)
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        evidence = comment(gate) | {"user": {"id": 120040061, "type": "User"}}
        with self.assertRaises(ValueError):
            gate.consume(evidence | {"performed_via_github_app": {"id": 1}}, context(), now=NOW + timedelta(seconds=2))
        gate.consume(evidence, context(), now=NOW + timedelta(seconds=2))
        with self.assertRaises(ValueError):
            gate.consume(evidence, context(), now=NOW + timedelta(seconds=3))

    def test_empty_approver_configuration_still_fails_closed(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset()), self.assertRaises(ValueError):
            gate.consume(comment(gate), context(), now=NOW + timedelta(seconds=2))

    def test_selected_owner_is_receipt_metadata_not_session_authorization(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        expected = {"arn": "arn:aws:iam::269416271598:user/VayadaUser", "userId": "AIDAT5OTWB3XLUEYGCQ56"}
        self.assertEqual(gate.receipt()["receipt"]["operatorOwner"], expected)
        exported = gate.receipt()
        exported["receipt"]["operatorOwner"]["arn"] = "other"
        self.assertEqual(gate.receipt()["receipt"]["operatorOwner"], expected)
        changed = context() | {"operatorArn": expected["arn"]}
        with self.assertRaises(ValueError):
            approval.ApprovalGate(changed, 344, now=NOW)
        with self.assertRaises(ValueError):
            gate.consume(comment(gate), changed, now=NOW + timedelta(seconds=2))
        self.assertFalse(gate._consumed)

    def test_creation_context_rejects_other_role_names_before_source_or_approval(self):
        self.assertEqual(approval.CREATION_OPERATOR_ROLE, "vayada-pricing-operator-create")
        declaration = (ROOT / "infra/pricing-bootstrap-identity/operator.tf").read_text().split(
            'resource "aws_iam_role" "operator_creation" {', 1)[1].split("\n}", 1)[0]
        self.assertIn(f'name                 = "{approval.CREATION_OPERATOR_ROLE}"', declaration)
        invalid = [approval.SELECTED_OPERATOR_ARN, "arn:aws:iam::269416271598:root"]
        invalid += [f"arn:aws:sts::269416271598:assumed-role/{role}/session" for role in (
            "reviewed-fixture", "vayada-github-actions-platform-deploy", "vayada-pricing-command-execution",
            "vayada-pricing-bootstrap-create", "vayada-pricing-operator-create-extra", "Vayada-pricing-operator-create")]
        invalid += [context()["operatorArn"].replace("269416271598", "111111111111"),
                    context()["operatorArn"] + "/extra", context()["operatorArn"].replace("/session", "/")]
        with patch.object(approval, "_github_json") as api:
            for arn in invalid:
                with self.subTest(arn=arn), self.assertRaises(ValueError):
                    approval.ApprovalGate(context() | {"operatorArn": arn}, 344, now=NOW)
            self.source.assert_not_called()
            api.assert_not_called()
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})):
            for arn in invalid:
                with self.subTest(arn=arn), self.assertRaises(ValueError):
                    gate.consume(comment(gate), context() | {"operatorArn": arn}, now=NOW + timedelta(seconds=2))
                self.assertFalse(gate._consumed)
            gate.consume(comment(gate), context(), now=NOW + timedelta(seconds=2))

    def test_context_and_receipt_cannot_smuggle_or_mutate_fields(self):
        private = context() | {"privatePlan": "SECRET_SENTINEL"}
        with self.assertRaises(ValueError):
            approval.ApprovalGate(private, 344, now=NOW)
        original = context()
        gate = approval.ApprovalGate(original, 344, now=NOW)
        before = gate.receipt()
        original["planSha256"] = "e" * 64
        exported = gate.receipt()
        exported["receipt"]["context"]["planSha256"] = "e" * 64
        self.assertEqual(gate.receipt(), before)

    def test_reject_context_changes(self):
        for field in approval.CONTEXT_FIELDS:
            with self.subTest(field=field):
                gate = approval.ApprovalGate(context(), 344, now=NOW)
                changed = context()
                replacements = {"sourceSha": "e" * 40, "planSha256": "e" * 64,
                                "writerHoldSha256": "e" * 64, "authorizationSha256": "e" * 64,
                                "operatorArn": "arn:aws:sts::269416271598:assumed-role/vayada-pricing-operator-create/other-session",
                                "stateLineage": "00000000-0000-0000-0000-000000000002"}
                changed[field] = changed[field] + 1 if type(changed[field]) is int else replacements[field]
                approval.validate_context(changed)
                with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})), self.assertRaises(ValueError):
                    gate.consume(comment(gate), changed, now=NOW + timedelta(seconds=2))

    def test_reject_comment_and_time_variations(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        for fields in (
            {"user": {"id": 43, "type": "User"}}, {"user": {"id": True, "type": "User"}},
            {"user": {"id": 42, "type": "Bot"}}, {"performed_via_github_app": {"id": 1}},
            {"id": True}, {"issue_url": "https://api.github.com/repos/other/repo/issues/344"},
            {"body": "approve"}, {"body": gate.approval_text() + "\nextra"},
            {"updated_at": "2030-01-01T00:00:02Z"},
            {"created_at": "2030-01-01T00:00:00Z", "updated_at": "2030-01-01T00:00:00Z"},
            {"created_at": "2029-12-31T23:59:59Z", "updated_at": "2029-12-31T23:59:59Z"},
            {"created_at": "2030-01-01T00:01:00Z", "updated_at": "2030-01-01T00:01:00Z"},
        ):
            with self.subTest(fields=fields), patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})), self.assertRaises(ValueError):
                gate.check_comment(comment(gate) | fields, now=NOW + timedelta(seconds=2))
        for when in (NOW - timedelta(seconds=1), NOW + timedelta(minutes=15)):
            with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})), self.assertRaises(ValueError):
                gate.check_comment(comment(gate), now=when)

    def test_invalid_metadata_and_cli_fail_closed(self):
        for field, value in (("runId", True), ("runAttempt", 0), ("stateSerial", -1),
                             ("operatorArn", "arn:aws:sts::111111111111:assumed-role/other/session"),
                             ("planSha256", "SECRET_SENTINEL"), ("stateLineage", "bad")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                approval.ApprovalGate(context() | {field: value}, 344, now=NOW)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/pricing_bootstrap_approval.py")],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no setup executor", result.stderr)

    def test_edit_evidence_is_required_and_bound_even_with_equal_timestamps(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        original = comment(gate)
        cases = [original | {"editEvidence": None}]
        for field, value in (("id", "IC_other"), ("fullDatabaseId", 51), ("isMinimized", True),
                             ("lastEditedAt", original["created_at"]), ("editor", {"id": 42})):
            cases.append(original | {"editEvidence": original["editEvidence"] | {field: value}})
        for field in original["editEvidence"]:
            cases.append(original | {"editEvidence": {key: value for key, value in original["editEvidence"].items()
                                                      if key != field}})
        for evidence in cases:
            with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})), self.assertRaises(ValueError):
                gate.check_comment(evidence, now=NOW + timedelta(seconds=2))

    def test_gate_cannot_be_copied_serialized_or_consumed_by_fork(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        for operation in (copy.copy, copy.deepcopy, pickle.dumps):
            with self.subTest(operation=operation), self.assertRaises(TypeError):
                operation(gate)
        if "fork" not in multiprocessing.get_all_start_methods():
            return
        fork = multiprocessing.get_context("fork")
        results = fork.Queue()
        def consume_in_child():
            try:
                gate.consume(comment(gate), context(), now=NOW + timedelta(seconds=2))
            except ValueError:
                results.put("rejected")
            else:
                results.put("accepted")
        with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})):
            process = fork.Process(target=consume_in_child)
            process.start()
            process.join(5)
            try:
                self.assertFalse(process.is_alive())
                self.assertEqual(process.exitcode, 0)
                self.assertEqual(results.get(timeout=2), "rejected")
                gate.consume(comment(gate), context(), now=NOW + timedelta(seconds=3))
            finally:
                if process.is_alive():
                    process.terminate()
                    process.join(5)
                results.close()
                results.join_thread()

    def test_only_one_thread_can_consume_and_large_comment_ids_bind(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        evidence = comment(gate)
        evidence["id"] = 4157799260
        evidence["editEvidence"]["fullDatabaseId"] = str(evidence["id"])
        ready = threading.Barrier(2)
        def consume():
            ready.wait(timeout=2)
            try:
                gate.consume(evidence, context(), now=NOW + timedelta(seconds=2))
            except ValueError:
                return "rejected"
            return "accepted"
        with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})), ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: consume(), range(2)))
        self.assertEqual(sorted(results), ["accepted", "rejected"])

    def test_fresh_authenticated_comment_is_bound_and_consumed(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        rest, graphql = api_comment(gate)
        with patch.object(approval, "_github_json", side_effect=[rest, graphql]) as api, \
                patch.object(approval, "APPROVED_HUMAN_IDS", frozenset({42})), \
                patch.object(approval, "datetime", wraps=datetime) as clock:
            clock.now.return_value = NOW + timedelta(seconds=2)
            gate.fetch_and_consume(rest["id"], context())
            self.assertEqual(api.call_args_list[0].args,
                             (f"repos/{approval.REPOSITORY}/issues/comments/5931916571",))
            self.assertEqual(api.call_args_list[1].args, ("graphql",))
            self.assertEqual(api.call_args_list[1].kwargs, {"node_id": "IC_fixture"})
        self.assertTrue(gate._consumed)
        self.assertEqual(self.source.call_count, 2)  # Construction and after fresh API evidence.
        empty = approval.ApprovalGate(context(), 344, now=NOW)
        with patch.object(approval, "APPROVED_HUMAN_IDS", frozenset()), \
                patch.object(approval, "_github_json") as api, self.assertRaises(ValueError):
            empty.fetch_and_consume(rest["id"], context())
        api.assert_not_called()

    def test_comment_fetch_rejects_missing_malformed_or_disagreeing_evidence(self):
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        original, graph = api_comment(gate)
        node = graph["data"]["node"]
        cases = [(original | {"id": True}, graph), (original | {"id": 50}, graph),
                 (original | {"node_id": "bad/path"}, graph),
                 (original | {"user": None}, graph), (original, {"data": []}),
                 (original, {"data": {"node": None}})]
        for field, value in (("id", "IC_other"), ("fullDatabaseId", "50"),
                             ("fullDatabaseId", True), ("author", {"id": "U_other", "__typename": "User"}),
                             ("body", "edited"), ("createdAt", "2029-01-01T00:00:00Z"),
                             ("updatedAt", "2030-01-01T00:00:02Z")):
            cases.append((original, {"data": {"node": node | {field: value}}}))
        for field in node:
            cases.append((original, {"data": {"node": {k: v for k, v in node.items() if k != field}}}))
        for rest, graphql in cases:
            with self.subTest(rest=rest, graphql=graphql), \
                    patch.object(approval, "_github_json", side_effect=[rest, graphql]), \
                    self.assertRaises(ValueError):
                approval.read_github_comment(original["id"])
        for identity in (True, 0, "50", None):
            with patch.object(approval, "_github_json") as api, self.assertRaises(ValueError):
                approval.read_github_comment(identity)
            api.assert_not_called()

    def test_api_commands_are_fixed_host_read_only_and_errors_are_redacted(self):
        endpoint = f"repos/{approval.REPOSITORY}/issues/comments/50"
        result = subprocess.CompletedProcess([], 0, '{}', '')
        with patch.object(approval.subprocess, "run", return_value=result) as run:
            approval._github_json(endpoint)
            self.assertEqual(run.call_args.args[0],
                             ["gh", "api", "--hostname", "github.com", endpoint, "--method", "GET"])
            self.assertEqual(run.call_args.kwargs, {"capture_output": True, "text": True, "timeout": 20})
            approval._github_json("graphql", node_id="IC_fixture")
            self.assertEqual(run.call_args.args[0],
                             ["gh", "api", "--hostname", "github.com", "graphql", "--method", "POST",
                              "-f", "query=" + approval.EDIT_QUERY, "-f", "id=IC_fixture"])
        cases = [subprocess.CompletedProcess([], 1, 'SECRET_SENTINEL', 'SECRET_SENTINEL'),
                 subprocess.CompletedProcess([], 0, 'SECRET_SENTINEL', ''),
                 subprocess.CompletedProcess([], 0, '[]', ''),
                 subprocess.CompletedProcess([], 0, json.dumps({"errors": ["SECRET_SENTINEL"]}), ''),
                 subprocess.CompletedProcess([], 0, 'x' * 2_000_001, '')]
        for result in cases:
            with patch.object(approval.subprocess, "run", return_value=result), self.assertRaises(ValueError) as error:
                approval._github_json(endpoint)
            self.assertNotIn("SECRET_SENTINEL", str(error.exception))
        for error in (OSError("SECRET_SENTINEL"), subprocess.TimeoutExpired("SECRET_SENTINEL", 20)):
            with patch.object(approval.subprocess, "run", side_effect=error), self.assertRaises(ValueError) as raised:
                approval._github_json(endpoint)
            self.assertNotIn("SECRET_SENTINEL", str(raised.exception))
        for path, node_id in (("https://evil.example/", None), ("repos/other/repo/actions/workflows", None),
                              (endpoint, "IC_fixture")):
            with patch.object(approval.subprocess, "run") as run, self.assertRaises(ValueError):
                approval._github_json(path, node_id=node_id)
            run.assert_not_called()

    def test_pause_observation_checks_all_nonterminal_statuses_without_branch_or_date_filter(self):
        statuses = ("queued", "in_progress", "waiting", "pending", "requested")
        responses = [paused_workflows()] + [
            {"total_count": 1, "workflow_runs": [{"id": index + 10, "workflow_id": 1, "status": status}]}
            for index, status in enumerate(statuses)]
        with patch.object(approval, "_github_json", side_effect=responses) as api:
            observation = approval.observe_workflow_pause()
        self.assertEqual(observation["scope"], "workflow-disable-observation-only")
        self.assertEqual(set(observation), {"repository", "scope", "workflows"})
        self.assertEqual([call.args[0] for call in api.call_args_list],
                         [f"repos/{approval.REPOSITORY}/actions/workflows?per_page=100"] +
                         [f"repos/{approval.REPOSITORY}/actions/runs?status={status}&per_page=100" for status in statuses])

    def test_pause_observation_rejects_incomplete_or_unreviewed_inventory(self):
        original = paused_workflows()
        cases = [original | {"total_count": 101}, original | {"total_count": True},
                 original | {"total_count": 4}, original | {"workflows": None},
                 {"total_count": 2, "workflows": original["workflows"][1:]}]
        for fields in ({"state": "active"}, {"state": "disabled_inactivity"},
                       {"id": 1}, {"id": True}, {"path": ".github/workflows/tf-plan.yml"},
                       {"path": "https://evil.example/"}):
            changed = copy.deepcopy(original)
            changed["workflows"][2].update(fields)
            cases.append(changed)
        for inventory in cases:
            with self.subTest(inventory=inventory), \
                    patch.object(approval, "_github_json", return_value=inventory), self.assertRaises(ValueError):
                approval.observe_workflow_pause()

    def test_pause_observation_never_ignores_old_queued_writers_or_truncated_runs(self):
        statuses = ("queued", "in_progress", "waiting", "pending", "requested")
        empty = {"total_count": 0, "workflow_runs": []}
        for position, status in enumerate(statuses):
            cases = [{"total_count": 1, "workflow_runs": [
                {"id": 10, "workflow_id": 3, "status": status, "head_branch": "old-branch",
                 "created_at": "2020-01-01T00:00:00Z"}]},
                {"total_count": 101, "workflow_runs": []}, {"total_count": True, "workflow_runs": []},
                {"total_count": 1, "workflow_runs": []},
                {"total_count": 1, "workflow_runs": [{"id": 10, "workflow_id": True, "status": status}]},
                {"total_count": 1, "workflow_runs": [{"id": 10, "workflow_id": 1, "status": "completed"}]},
                {"total_count": 1, "workflow_runs": [{"workflow_id": 1, "status": status}]},
                {"total_count": 1, "workflow_runs": [{"id": True, "workflow_id": 1, "status": status}]},
                {"total_count": 1, "workflow_runs": [{"id": 0, "workflow_id": 1, "status": status}]},
                {"total_count": 2, "workflow_runs": [{"id": 10, "workflow_id": 1, "status": status}] * 2}]
            for run_list in cases:
                with self.subTest(status=status, run_list=run_list), \
                        patch.object(approval, "_github_json", side_effect=[paused_workflows()] +
                                     [empty] * position + [run_list]), self.assertRaises(ValueError):
                    approval.observe_workflow_pause()
        with patch.object(approval, "_github_json", side_effect=[paused_workflows()] + [
                {"total_count": 1, "workflow_runs": [{"id": 10, "workflow_id": 1, "status": status}]}
                for status in statuses]), self.assertRaises(ValueError):
            approval.observe_workflow_pause()


@unittest.skipUnless(hasattr(os, "memfd_create"), "Requires native Linux sealing")
class SavedPlanTests(unittest.TestCase):
    def setUp(self):
        source_patch = patch.object(approval, "verify_checkout_source")
        self.source = source_patch.start()
        self.addCleanup(source_patch.stop)
        self.directory = tempfile.TemporaryDirectory(prefix="pricing-plan-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "SECRET_SENTINEL.tfplan"
        self.data = b"private-plan-fixture" * 60000  # Cross the bounded-copy boundary.
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.path.write_bytes(self.data)
        self.path.chmod(0o600)

    def test_sealed_snapshot_is_immutable_and_closed_on_exit(self):
        with approval.sealed_saved_plan(self.path, self.digest) as fd:
            self.assertEqual(approval.saved_plan_digest(fd), self.digest)
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 0)
            self.path.unlink()
            self.path.write_bytes(b"replacement")
            self.assertEqual(os.pread(fd, len(self.data), 0), self.data)
            for mutate in (lambda: os.write(fd, b"changed"),
                           lambda: os.ftruncate(fd, 1),
                           lambda: os.ftruncate(fd, len(self.data) + 1),
                           lambda: fcntl.fcntl(fd, fcntl.F_ADD_SEALS, 0)):
                with self.assertRaises(OSError):
                    mutate()
        with self.assertRaises(OSError):
            os.fstat(fd)
        self.path.write_bytes(self.data)
        self.path.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, "body failure"):
            with approval.sealed_saved_plan(self.path, self.digest) as fd:
                raise RuntimeError("body failure")
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_reject_wrong_digest_unsafe_files_and_bounds_without_disclosure(self):
        def reject(path=self.path, digest=self.digest):
            with self.assertRaises(ValueError) as raised:
                with approval.sealed_saved_plan(path, digest):
                    self.fail("Unsafe plan accepted")
            self.assertNotIn("SECRET_SENTINEL", str(raised.exception))

        reject(digest="0" * 64)
        reject(digest=self.digest.upper())
        self.path.chmod(0o644)
        reject()
        self.path.chmod(0o600)
        linked = self.path.with_name("link")
        linked.symlink_to(self.path)
        reject(linked)
        linked.unlink()
        os.link(self.path, linked)
        reject()
        linked.unlink()
        fifo = self.path.with_name("fifo")
        os.mkfifo(fifo, 0o600)
        reject(fifo)
        reject(Path(self.directory.name))
        reject(self.path.with_name("missing"))
        with patch.object(approval, "MAX_PLAN_BYTES", len(self.data) - 1):
            reject()
        self.path.write_bytes(b"")
        reject(digest=hashlib.sha256(b"").hexdigest())

    def test_setup_interruptions_close_private_descriptor_before_yield(self):
        native_create = os.memfd_create
        for error in (KeyboardInterrupt(), SystemExit(), RuntimeError("fixture failure")):
            created = []
            def create(*args):
                fd = native_create(*args)
                created.append(fd)
                return fd
            with self.subTest(error=type(error)), \
                    patch.object(approval.os, "memfd_create", side_effect=create), \
                    patch.object(approval, "saved_plan_digest", side_effect=error), \
                    self.assertRaises(type(error)):
                with approval.sealed_saved_plan(self.path, self.digest):
                    self.fail("Interrupted setup yielded")
            self.assertEqual(len(created), 1)
            with self.assertRaises(OSError):
                os.fstat(created[0])

    def test_reject_unsealed_invalid_and_short_read_descriptors(self):
        for fd in (-1, True, "1", None):
            with self.subTest(fd=fd), self.assertRaises(ValueError):
                approval.saved_plan_digest(fd)
        fd = os.memfd_create("unsealed", os.MFD_ALLOW_SEALING)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, self.data)
            with self.assertRaises(ValueError):
                approval.saved_plan_digest(fd)
        finally:
            os.close(fd)
        with self.assertRaises(ValueError):
            approval.saved_plan_digest(fd)
        with approval.sealed_saved_plan(self.path, self.digest) as fd:
            with patch.object(approval.os, "pread", return_value=b""), self.assertRaises(ValueError):
                approval.saved_plan_digest(fd)

    def test_actual_snapshot_binds_fresh_human_approval_and_replay(self):
        current = context() | {"planSha256": self.digest}
        gate = approval.ApprovalGate(current, 344, now=NOW)
        rest, graphql = api_comment(gate)
        rest["user"]["id"] = 120040061
        with approval.sealed_saved_plan(self.path, self.digest) as fd, \
                patch.object(approval, "guard_saved_plan") as guard, \
                patch.object(approval, "_github_json", side_effect=[rest, graphql, rest, graphql]) as api, \
                patch.object(approval, "datetime", wraps=datetime) as clock:
            clock.now.return_value = NOW + timedelta(seconds=2)
            path = gate.fetch_and_consume_saved_plan(rest["id"], current, fd)
            self.assertEqual(path, f"/proc/self/fd/{fd}")
            self.assertTrue(gate._consumed)
            self.assertEqual(api.call_count, 2)
            guard.assert_called_once_with(fd, self.digest)
            self.assertEqual(self.source.call_count, 3)  # Construction, before guards, after API.
            self.assertNotIn(path, json.dumps(gate.receipt()))
            with self.assertRaises(ValueError):
                gate.fetch_and_consume_saved_plan(rest["id"], current, fd)

    def test_mismatched_snapshot_rejects_before_api_and_context_change_rejects(self):
        current = context() | {"planSha256": self.digest}
        gate = approval.ApprovalGate(current, 344, now=NOW)
        self.path.write_bytes(b"other")
        other = hashlib.sha256(b"other").hexdigest()
        with approval.sealed_saved_plan(self.path, other) as fd, \
                patch.object(approval, "_github_json") as api, self.assertRaises(ValueError):
            gate.fetch_and_consume_saved_plan(50, current, fd)
        api.assert_not_called()
        self.assertFalse(gate._consumed)
        self.path.write_bytes(self.data)
        rest, graphql = api_comment(gate)
        rest["user"]["id"] = 120040061
        with approval.sealed_saved_plan(self.path, self.digest) as fd, \
                patch.object(approval, "guard_saved_plan"), \
                patch.object(approval, "_github_json", side_effect=[rest, graphql]), \
                patch.object(approval, "datetime", wraps=datetime) as clock:
            clock.now.return_value = NOW + timedelta(seconds=2)
            with self.assertRaises(ValueError):
                gate.fetch_and_consume_saved_plan(rest["id"], current | {"stateSerial": 8}, fd)
        self.assertFalse(gate._consumed)

    def test_plan_guards_use_same_fd_and_do_not_inherit_credentials_or_log_output(self):
        show = subprocess.CompletedProcess([], 0, json.dumps(pricing_fixture()), "SECRET_SENTINEL")
        success = subprocess.CompletedProcess([], 0, "finance-steady", "")
        with approval.sealed_saved_plan(self.path, self.digest) as fd, \
                patch.object(approval.subprocess, "run", side_effect=[runtime_result(), show, success]) as run, \
                patch.dict(os.environ, {"GH_TOKEN": "SECRET_SENTINEL", "AWS_ACCESS_KEY_ID": "SECRET_SENTINEL",
                                        "TF_VAR_password": "SECRET_SENTINEL", "TF_LOG": "TRACE",
                                        "BASH_ENV": "SECRET_SENTINEL", "TF_CLI_ARGS_show": "SECRET_SENTINEL"}):
            approval.guard_saved_plan(fd, self.digest)
            self.assertEqual(run.call_count, 3)
            calls = run.call_args_list
            self.assertEqual(calls[0].args[0], ["terraform", "version", "-json"])
            self.assertEqual(calls[1].args[0], ["terraform", "show", "-json", f"/proc/self/fd/{fd}"])
            self.assertEqual(calls[2].args[0], ["bash", str(ROOT / "scripts/guard-finance-folio-kms-plan.sh"),
                                               f"/proc/self/fd/{fd}", "plan"])
            for call in calls:
                self.assertEqual(call.kwargs["pass_fds"], (fd,))
                self.assertEqual(call.kwargs["cwd"], ROOT / "infra")
                self.assertNotIn("SECRET_SENTINEL", json.dumps(call.kwargs["env"]))
                self.assertNotIn("TF_LOG", call.kwargs["env"])

    def test_guard_failure_never_consumes_approval_or_exposes_plan(self):
        current = context() | {"planSha256": self.digest}
        gate = approval.ApprovalGate(current, 344, now=NOW)
        invalid = pricing_fixture()
        invalid["resource_changes"].pop()
        outputs = [subprocess.CompletedProcess([], 1, "SECRET_SENTINEL", "SECRET_SENTINEL"),
                   subprocess.CompletedProcess([], 0, "SECRET_SENTINEL", ""),
                   subprocess.CompletedProcess([], 0, json.dumps(invalid), "")]
        with approval.sealed_saved_plan(self.path, self.digest) as fd:
            for result in outputs:
                with self.subTest(result=result.returncode), \
                        patch.object(approval.subprocess, "run", side_effect=[runtime_result(), result]) as run, \
                        patch.object(approval, "_github_json") as api, self.assertRaises(ValueError) as error:
                    gate.fetch_and_consume_saved_plan(50, current, fd)
                self.assertNotIn("SECRET_SENTINEL", str(error.exception))
                self.assertEqual(run.call_count, 2)
                api.assert_not_called()
                self.assertFalse(gate._consumed)
            show = subprocess.CompletedProcess([], 0, json.dumps(pricing_fixture()), "")
            for failure in (subprocess.CompletedProcess([], 1, "SECRET_SENTINEL", "SECRET_SENTINEL"),
                            subprocess.TimeoutExpired("SECRET_SENTINEL", 120), OSError("SECRET_SENTINEL")):
                with patch.object(approval.subprocess, "run", side_effect=[runtime_result(), show, failure]), \
                        patch.object(approval, "_github_json") as api, self.assertRaises(ValueError) as error:
                    gate.fetch_and_consume_saved_plan(50, current, fd)
                self.assertNotIn("SECRET_SENTINEL", str(error.exception))
                api.assert_not_called()
                self.assertFalse(gate._consumed)


class CheckoutSourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pricing-source-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.git("init", "--quiet")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        (self.root / ".gitignore").write_text("ignored*\ninfra/.terraform/\n")
        (self.root / "source.py").write_text("reviewed fixture\n")
        (self.root / "infra").mkdir()
        (self.root / "infra/main.tf").write_text("# fixture\n")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        self.root_patch = patch.object(approval, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        api_patch = patch.object(approval, "_github_json", return_value={
            "ref": "refs/heads/main", "object": {"type": "commit", "sha": self.sha}})
        self.api = api_patch.start()
        self.addCleanup(api_patch.stop)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True,
                              capture_output=True, text=True).stdout

    def reject(self):
        with self.assertRaisesRegex(ValueError, "raw output withheld") as error:
            approval.verify_checkout_source(self.sha)
        self.assertNotIn("SECRET_SENTINEL", str(error.exception))

    def test_actual_checkout_matches_authenticated_main_without_mutation(self):
        before = self.git("status", "--porcelain=v1")
        approval.verify_checkout_source(self.sha)
        self.api.assert_called_once_with(f"repos/{approval.REPOSITORY}/git/ref/heads/main")
        self.assertEqual(self.git("status", "--porcelain=v1"), before)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.sha)

    def test_hidden_edits_index_changes_missing_modes_links_and_extra_files_reject(self):
        source = self.root / "source.py"
        original = source.read_bytes()
        for flag in ("--assume-unchanged", "--skip-worktree"):
            self.git("update-index", flag, "source.py")
            source.write_text("SECRET_SENTINEL\n")
            self.reject()
            source.write_bytes(original)
            self.git("update-index", "--no-" + flag[2:], "source.py")
        source.write_text("SECRET_SENTINEL\n")
        self.git("add", "source.py")
        self.reject()
        source.write_bytes(original)
        self.git("add", "source.py")
        source.chmod(0o755)
        self.reject()
        source.chmod(0o644)
        source.unlink()
        self.reject()
        source.symlink_to(self.root / "infra/main.tf")
        self.reject()
        source.unlink()
        source.write_bytes(original)
        linked = self.root / "hardlink"
        os.link(source, linked)
        self.reject()
        linked.unlink()
        for name in ("untracked", "ignoredSECRET_SENTINEL", "infra/override.tf"):
            extra = self.root / name
            extra.write_text("SECRET_SENTINEL")
            self.reject()
            extra.unlink()
        extra = self.root / "infra/override.tf"
        extra.write_text("SECRET_SENTINEL")
        self.git("add", "-N", "infra/override.tf")
        self.assertEqual(self.git("diff", "--cached", "--name-only", self.sha), "")
        self.reject()
        self.git("update-index", "--force-remove", "infra/override.tf")
        extra.unlink()
        self.git("config", "diff.ignoreSubmodules", "all")
        self.git("update-index", "--add", "--cacheinfo", "160000," + self.sha + ",extra-module")
        self.reject()
        self.git("update-index", "--force-remove", "extra-module")
        runtime = self.root / "infra/.terraform"
        runtime.mkdir()
        (runtime / "provider-fixture").write_text("not runtime admission evidence")
        approval.verify_checkout_source(self.sha)

    def test_wrong_head_root_main_or_unavailable_metadata_reject(self):
        for sha in ("0" * 40, self.sha.upper(), None, "SECRET_SENTINEL"):
            with self.assertRaises(ValueError):
                approval.verify_checkout_source(sha)
        for result in ({}, {"ref": "refs/heads/other", "object": {"type": "commit", "sha": self.sha}},
                       {"ref": "refs/heads/main", "object": {"type": "tree", "sha": self.sha}},
                       {"ref": "refs/heads/main", "object": {"type": "commit", "sha": "0" * 40}}):
            self.api.return_value = result
            self.reject()
        self.api.side_effect = ValueError("SECRET_SENTINEL")
        self.reject()
        with patch.object(approval, "ROOT", self.root / "infra"):
            self.reject()

    def test_executable_source_requires_owner_execute_not_only_group_or_other(self):
        source = self.root / "source.py"
        source.chmod(0o755)
        self.git("add", "source.py")
        self.git("commit", "--quiet", "-m", "executable fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        self.api.return_value["object"]["sha"] = self.sha
        approval.verify_checkout_source(self.sha)
        for mode in (0o654, 0o645, 0o644):
            source.chmod(mode)
            self.reject()

    def test_case_only_extra_source_rejects_even_with_ignore_case_configured(self):
        extra = self.root / "infra/MAIN.tf"
        if extra.exists():
            self.skipTest("Requires case-sensitive filesystem")
        self.git("config", "core.ignoreCase", "true")
        extra.write_text("SECRET_SENTINEL")
        self.assertEqual(self.git("ls-files", "--others", "--exclude-standard"), "")
        self.reject()

    def test_git_environment_is_fixed_and_failures_do_not_expose_private_output(self):
        native = subprocess.run
        calls = []
        def run(*args, **kwargs):
            self.assertIn("core.ignoreCase=false", args[0])
            calls.append(kwargs)
            return native(*args, **kwargs)
        with patch.dict(os.environ, {"GIT_DIR": "SECRET_SENTINEL", "GIT_WORK_TREE": "SECRET_SENTINEL",
                                     "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.fsmonitor",
                                     "GIT_CONFIG_VALUE_0": "SECRET_SENTINEL", "AWS_ACCESS_KEY_ID": "SECRET_SENTINEL"}), \
                patch.object(approval.subprocess, "run", side_effect=run):
            approval.verify_checkout_source(self.sha)
        self.assertEqual(len(calls), 6)
        for call in calls:
            self.assertNotIn("SECRET_SENTINEL", json.dumps(call["env"]))
            self.assertEqual(call["env"]["GIT_NO_REPLACE_OBJECTS"], "1")
        for error in (OSError("SECRET_SENTINEL"), subprocess.TimeoutExpired("SECRET_SENTINEL", 20)):
            with patch.object(approval.subprocess, "run", side_effect=error):
                self.reject()

    def test_source_failure_blocks_receipt_and_late_failure_does_not_consume(self):
        current = context() | {"sourceSha": self.sha}
        gate = approval.ApprovalGate(current, 344, now=NOW)
        with patch.object(approval, "verify_checkout_source", side_effect=lambda _: current.update(sourceSha="0" * 40)):
            captured = approval.ApprovalGate(current, 344, now=NOW)
        self.assertEqual(captured.receipt()["receipt"]["context"]["sourceSha"], self.sha)
        current["sourceSha"] = self.sha
        with patch.object(approval, "verify_checkout_source", side_effect=ValueError("source rejected")), \
                self.assertRaises(ValueError):
            approval.ApprovalGate(current, 344, now=NOW)
        with patch.object(approval, "read_github_comment", return_value=comment(gate)), \
                patch.object(approval, "verify_checkout_source", side_effect=ValueError("source rejected")), \
                self.assertRaises(ValueError):
            gate.fetch_and_consume(50, current)
        self.assertFalse(gate._consumed)
        with patch.object(approval, "verify_checkout_source", side_effect=ValueError("source rejected")), \
                patch.object(approval, "guard_saved_plan") as guard, \
                patch.object(approval, "read_github_comment") as read, self.assertRaises(ValueError):
            gate.fetch_and_consume_saved_plan(50, current, 123)
        guard.assert_not_called()
        read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
