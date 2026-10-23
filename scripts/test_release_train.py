#!/usr/bin/env python3
"""Release train deploy (VAY-2311): request trust, admission modes, deploy identity, verification."""

import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("release_train", ROOT / "scripts" / "release_train.py")
train = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(train)

SHA = "a" * 40
NEWER = "b" * 40
DIGEST = "sha256:" + "1" * 64


def dispatch_event(**overrides):
    payload = {
        "schemaVersion": 1,
        "release": {"sha": SHA, "artifactId": 12, "manifestId": "m", "manifestSha256": "c" * 64,
                    "publishedRecordSha256": "d" * 64},
        "summary": "VAY-1 thing",
        "dryRun": False,
        "admission": "push",
        "appRun": {"id": 42, "url": "https://github.com/vayada-marketplace/vayada/actions/runs/42"},
    }
    payload.update(overrides)
    return {"client_payload": payload}


class RequestTests(unittest.TestCase):
    def test_repository_dispatch_payload(self):
        request = train.read_request("repository_dispatch", dispatch_event())
        self.assertEqual(request["sha"], SHA)
        self.assertEqual(request["artifactId"], 12)
        self.assertEqual((request["dryRun"], request["admission"], request["appRunId"]), (False, "push", 42))

    def test_manual_inputs_default_to_a_dry_run(self):
        request = train.read_request("workflow_dispatch", {"inputs": {
            "sha": SHA, "published_artifact_id": "12", "manifest_sha256": "c" * 64,
            "published_record_sha256": "d" * 64, "summary": "resume", "dry_run": "true", "admission": "pr",
        }})
        self.assertEqual((request["artifactId"], request["dryRun"], request["appRunId"]), (12, True, None))
        no_flag = train.read_request("workflow_dispatch", {"inputs": {
            "sha": SHA, "published_artifact_id": "12", "manifest_sha256": "c" * 64,
            "published_record_sha256": "d" * 64, "summary": "resume",
        }})
        self.assertTrue(no_flag["dryRun"])
        self.assertEqual(no_flag["admission"], "pr")

    def test_malformed_requests_are_refused(self):
        bad = [
            dispatch_event(schemaVersion=2),
            dispatch_event(release={"sha": "abc", "artifactId": 12, "manifestSha256": "c" * 64, "publishedRecordSha256": "d" * 64}),
            dispatch_event(release={"sha": SHA, "artifactId": True, "manifestSha256": "c" * 64, "publishedRecordSha256": "d" * 64}),
            dispatch_event(release={"sha": SHA, "artifactId": 12, "manifestSha256": "C" * 64, "publishedRecordSha256": "d" * 64}),
            dispatch_event(summary="two\nlines"),
            dispatch_event(dryRun="false"),
            dispatch_event(admission="merge"),
            dispatch_event(appRun={}),
        ]
        for event in bad:
            with self.subTest(event=event), self.assertRaises(train.TrainError):
                train.read_request("repository_dispatch", event)
        with self.assertRaises(train.TrainError):
            train.read_request("push", {})

    def test_only_the_app_release_train_on_main_may_send_a_release(self):
        good = {"path": ".github/workflows/release-train.yml", "head_branch": "main", "event": "workflow_dispatch",
                "repository": {"full_name": "vayada-marketplace/vayada"}}
        self.assertEqual(train.app_run_problems(good), [])
        for field, value in (("path", ".github/workflows/pr-checks.yml"), ("head_branch", "fm/x"),
                             ("event", "push"), ("repository", {"full_name": "someone/fork"})):
            with self.subTest(field=field):
                self.assertEqual(len(train.app_run_problems({**good, field: value})), 1)


def run_git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, text=True, capture_output=True).stdout


class AdmissionTests(unittest.TestCase):
    """A real git checkout and remote; only the list test suites are stubbed."""

    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.remote = self.directory / "remote.git"
        self.root = self.directory / "checkout"
        run_git(self.directory, "init", "-q", "--bare", "-b", "main", str(self.remote))
        run_git(self.directory, "clone", "-q", str(self.remote), str(self.root))
        (self.root / "scripts").mkdir()
        for name in train.LISTS:
            (self.root / name).write_text(f"# reviewed admissions\n{'0' * 40} sha256:{'9' * 64}\n")
        run_git(self.root, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".")
        run_git(self.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
        run_git(self.root, "push", "-q", "origin", "HEAD:main")
        self.enterContext(mock.patch.object(train, "run_list_tests"))
        self.enterContext(mock.patch.object(train, "summary"))
        self.request = {"sha": SHA, "summary": "VAY-1 thing", "dryRun": False, "admission": "push", "appRunUrl": None}

    def remote_list(self, name, ref="main"):
        return run_git(self.remote, "show", f"{ref}:{name}")

    def test_dry_run_and_already_admitted_change_nothing(self):
        before = run_git(self.remote, "rev-parse", "main")
        result = train.admit({**self.request, "dryRun": True}, DIGEST, root=self.root, run_url="u", wait_minutes=1)
        self.assertIn("dry run: would admit", result)
        result = train.admit(self.request, "sha256:" + "9" * 64, root=self.root, run_url="u", wait_minutes=1)
        self.assertIn("already admitted", result)
        self.assertEqual(run_git(self.remote, "rev-parse", "main"), before)
        self.assertEqual(run_git(self.root, "status", "--porcelain"), "")

    def test_push_mode_commits_both_lists_to_main_after_the_list_tests(self):
        result = train.admit(self.request, DIGEST, root=self.root, run_url="https://run", wait_minutes=1)
        self.assertIn("admitted", result)
        train.run_list_tests.assert_called_once_with(self.root)
        for name in train.LISTS:
            self.assertTrue(self.remote_list(name).endswith(f"{SHA} {DIGEST}\n"))
        message = run_git(self.remote, "log", "-1", "--format=%an%n%B", "main")
        self.assertIn("github-actions[bot]", message)
        self.assertIn(f"Admit next-{SHA[:9]}", message)
        self.assertIn("Release train run https://run", message)

    def test_push_mode_replays_on_a_main_that_moved(self):
        other = self.directory / "other"
        run_git(self.directory, "clone", "-q", str(self.remote), str(other))

        def someone_pushes(root):
            # Main moves while the first attempt runs its list tests, so its push is rejected.
            if train.run_list_tests.call_count == 1:
                (other / "README").write_text("moved\n")
                run_git(other, "add", ".")
                run_git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "moved")
                run_git(other, "push", "-q", "origin", "HEAD:main")

        train.run_list_tests.side_effect = someone_pushes
        train.admit(self.request, DIGEST, root=self.root, run_url="u", wait_minutes=1)
        self.assertEqual(run_git(self.remote, "show", "main:README"), "moved\n")
        self.assertIn(DIGEST, self.remote_list(train.LISTS[0]))
        self.assertEqual(self.remote_list(train.LISTS[0]).count(DIGEST), 1)
        self.assertEqual(train.run_list_tests.call_count, 2)

    def test_pr_mode_pushes_a_branch_and_waits_for_a_person_to_merge_it(self):
        request = {**self.request, "admission": "pr"}
        branch = train.admission_branch(SHA)
        clock = {"now": 0.0, "polls": 0}

        def sleep(seconds):
            clock["now"] += seconds
            clock["polls"] += 1
            if clock["polls"] == 2:  # the person merges the PR
                run_git(self.remote, "update-ref", "refs/heads/main", f"refs/heads/{branch}")

        result = train.admit(request, DIGEST, root=self.root, run_url="u", wait_minutes=30,
                             sleep=sleep, now=lambda: clock["now"])
        self.assertIn(f"admission PR from {branch}", result)
        self.assertIn(DIGEST, self.remote_list(train.LISTS[1], f"refs/heads/{branch}"))
        self.assertIn("compare/main...release-train/admit-aaaaaaaaa", train.summary.call_args[0][0])

    def test_pr_mode_gives_up_at_its_deadline_and_reuses_the_branch_on_rerun(self):
        request = {**self.request, "admission": "pr"}
        clock = {"now": 0.0}

        def sleep(seconds):
            clock["now"] += seconds

        with self.assertRaisesRegex(train.TrainError, "merge the admission PR, then rerun"):
            train.admit(request, DIGEST, root=self.root, run_url="u", wait_minutes=1, sleep=sleep, now=lambda: clock["now"])
        tip = run_git(self.remote, "rev-parse", f"refs/heads/{train.admission_branch(SHA)}")
        with self.assertRaises(train.TrainError):
            train.admit(request, DIGEST, root=self.root, run_url="u", wait_minutes=1, sleep=sleep, now=lambda: clock["now"])
        self.assertEqual(run_git(self.remote, "rev-parse", f"refs/heads/{train.admission_branch(SHA)}"), tip)
        self.assertEqual(train.run_list_tests.call_count, 1)


class DeployIdentityTests(unittest.TestCase):
    def setUp(self):
        self.request = {"sha": SHA, "artifactId": 12, "manifestSha256": "c" * 64, "publishedRecordSha256": "d" * 64}

    def test_the_deploy_run_must_have_planned_this_exact_publication(self):
        plan = {"artifactId": 12, "sourceSha": SHA, "manifestSha256": "c" * 64, "publishedRecordSha256": "d" * 64}
        train.check_plan(plan, self.request)
        for field, value in (("artifactId", 13), ("sourceSha", NEWER), ("manifestSha256", "e" * 64)):
            with self.subTest(field=field), self.assertRaises(train.TrainError):
                train.check_plan({**plan, field: value}, self.request)

    def test_only_runs_the_workflow_token_started_count(self):
        github = mock.Mock()
        github.get.return_value = {"workflow_runs": [
            {"id": 1, "created_at": "2026-10-23T12:00:05Z", "triggering_actor": {"login": "FlamurMaliqi"}},
            {"id": 2, "created_at": "2026-10-23T12:00:03Z", "triggering_actor": {"login": "github-actions[bot]"}},
        ]}
        self.assertEqual(train.find_deploy_run(github, 12, "2026-10-23T11:59:00Z", sleep=lambda _: None)["id"], 2)
        github.get.return_value = {"workflow_runs": []}
        self.assertIsNone(train.find_deploy_run(github, 12, "2026-10-23T11:59:00Z", polls=2, sleep=lambda _: None))


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"source": {"sha": SHA}, "services": {"next-target-backend": {"digest": DIGEST},
                                                             "next-pms-frontend": {"digest": "sha256:" + "2" * 64}}}
        self.newer = {"source": {"sha": NEWER}, "services": {"next-target-backend": {"digest": DIGEST},
                                                            "next-pms-frontend": {"digest": "sha256:" + "3" * 64}}}

    def test_a_deployed_release_must_be_live_itself(self):
        for desired in (None, {"sourceSha": SHA}):
            expected, against = train.expected_digests("new", self.manifest, desired, mock.Mock(), mock.Mock())
            self.assertEqual(expected["next-pms-frontend"], "sha256:" + "2" * 64)
            self.assertEqual(against, "this release")

    def test_a_superseded_release_must_be_contained_in_the_live_one(self):
        compare = mock.Mock(return_value="ahead")
        expected, against = train.expected_digests("stale", self.manifest, {"sourceSha": NEWER, "artifactId": 9},
                                                    compare, lambda record: self.newer)
        compare.assert_called_once_with(SHA, NEWER)
        self.assertEqual(expected["next-pms-frontend"], "sha256:" + "3" * 64)
        self.assertEqual(against, f"superseded by {NEWER[:9]}")
        for order in ("behind", "diverged"):
            with self.subTest(order=order), self.assertRaisesRegex(train.TrainError, "does not contain"):
                train.expected_digests("stale", self.manifest, {"sourceSha": NEWER}, lambda *_: order, mock.Mock())

    def test_unreadable_logs_are_reported_not_counted_as_clean(self):
        denied = subprocess.CompletedProcess([], 254, "", "An error occurred (AccessDeniedException) when calling FilterLogEvents")
        with mock.patch.object(train.subprocess, "run", return_value=denied):
            self.assertIsNone(train.count_log_events('"42501"', 0, "eu-west-1"))
        found = subprocess.CompletedProcess([], 0, json.dumps(["e1", "e2"]), "")
        with mock.patch.object(train.subprocess, "run", return_value=found):
            self.assertEqual(train.count_log_events('"42501"', 0, "eu-west-1"), 2)
        broken = subprocess.CompletedProcess([], 255, "", "Could not connect to the endpoint URL")
        with mock.patch.object(train.subprocess, "run", return_value=broken), self.assertRaises(train.TrainError):
            train.count_log_events('"42501"', 0, "eu-west-1")

    def test_reads_retry_and_then_fail_with_the_cause(self):
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise OSError("connection reset")
            return "ok"

        self.assertEqual(train.retry(flaky, what="read", sleep=lambda _: None), "ok")
        with self.assertRaisesRegex(train.TrainError, "read: down"):
            train.retry(lambda: (_ for _ in ()).throw(OSError("down")), what="read", attempts=2, sleep=lambda _: None)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/release-train-deploy.yml").read_text()

    def job(self, name):
        return re.split(r"\n  [a-z-]+:\n", self.workflow.split(f"\n  {name}:\n", 1)[1])[0]

    def test_triggers_and_defaults(self):
        self.assertIn("repository_dispatch:\n    types: [release-train]", self.workflow)
        self.assertRegex(self.workflow, r"dry_run:\n(?:        .+\n)*?        default: true\n")
        self.assertRegex(self.workflow, r"admission:\n(?:        .+\n)*?        default: pr\n")
        self.assertIn("group: release-train-deploy\n  cancel-in-progress: false", self.workflow)
        self.assertIn("permissions:\n  contents: read\n", self.workflow)

    def test_each_job_gets_only_what_it_needs(self):
        validate, admit, deploy = self.job("validate"), self.job("admit"), self.job("deploy-verify")
        self.assertIn("environment: next", validate)
        self.assertNotIn("contents: write", validate)
        self.assertIn("python3 scripts/release_train.py validate --output-dir release-bundle", validate)
        # Only admission may write the repository, and it gets no AWS role.
        self.assertIn("contents: write", admit)
        self.assertNotIn("id-token", admit)
        self.assertNotIn("environment:", admit)
        self.assertIn("fetch-depth: 0", admit)
        self.assertIn("python3 scripts/release_train.py admit --bundle release-bundle", admit)
        self.assertIn("needs: [validate, admit]", deploy)
        self.assertIn("environment: next", deploy)
        self.assertIn("actions: write", deploy)
        self.assertNotIn("contents: write", deploy)
        self.assertIn("python3 scripts/release_train.py deploy-verify --bundle release-bundle", deploy)
        for body in (validate, deploy):
            self.assertIn("role/vayada-github-actions-coordinated-deploy", body)

    def test_admission_runs_the_same_list_tests_as_the_automatic_admission(self):
        admit_job = (ROOT / ".github/workflows/deploy-coordinated-release.yml").read_text()
        for command in train.LIST_TESTS:
            self.assertIn(" ".join(command), admit_job)

    def test_the_deploy_inputs_match_the_coordinated_deploy_workflow(self):
        deploy = (ROOT / ".github/workflows/deploy-coordinated-release.yml").read_text()
        for name in ("operation", "published_artifact_id", "manifest_sha256", "published_record_sha256", "service"):
            self.assertIn(f"      {name}:\n", deploy)
        self.assertIn(f"name: Deploy coordinated next release", deploy)
        self.assertIn("RELEASE_BUNDLE_ARTIFACT: coordinated-release-plan-${{ github.run_id }}-${{ github.run_attempt }}", deploy)


if __name__ == "__main__":
    unittest.main()
