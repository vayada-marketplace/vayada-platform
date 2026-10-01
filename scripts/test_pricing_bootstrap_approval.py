import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import multiprocessing
from pathlib import Path
import pickle
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("approval", ROOT / "scripts/pricing_bootstrap_approval.py")
approval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approval)
NOW = datetime(2030, 1, 1, tzinfo=timezone.utc)


def context():
    return {"sourceSha": "a" * 40, "runId": 123, "runAttempt": 1,
            "operatorArn": "arn:aws:sts::269416271598:assumed-role/reviewed-fixture/session",
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


class ApprovalTests(unittest.TestCase):
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

    def test_no_human_is_authorized_by_default(self):
        self.assertEqual(approval.APPROVED_HUMAN_IDS, frozenset())
        gate = approval.ApprovalGate(context(), 344, now=NOW)
        with self.assertRaises(ValueError):
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
                                "operatorArn": "arn:aws:sts::269416271598:assumed-role/reviewed-fixture/other-session",
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
        empty = approval.ApprovalGate(context(), 344, now=NOW)
        with patch.object(approval, "_github_json") as api, self.assertRaises(ValueError):
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


if __name__ == "__main__":
    unittest.main()
