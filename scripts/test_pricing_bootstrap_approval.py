import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
