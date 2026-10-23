#!/usr/bin/env python3
"""Release train deploy (VAY-2311): request trust, admission modes, deploy identity, verification."""

import argparse
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
        self.assertEqual(no_flag["admission"], "push")

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

    def test_push_mode_works_from_a_shallow_checkout_while_main_moves(self):
        # The admit job checks out main at depth 1, as actions/checkout does by default.
        shallow = self.directory / "shallow"
        run_git(self.directory, "clone", "-q", "--depth", "1", f"file://{self.remote}", str(shallow))
        self.assertEqual(run_git(shallow, "rev-parse", "--is-shallow-repository").strip(), "true")
        other = self.directory / "other"
        run_git(self.directory, "clone", "-q", str(self.remote), str(other))

        def someone_pushes(root):
            if train.run_list_tests.call_count == 1:
                (other / "README").write_text("moved\n")
                run_git(other, "add", ".")
                run_git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "moved")
                run_git(other, "push", "-q", "origin", "HEAD:main")

        train.run_list_tests.side_effect = someone_pushes
        train.admit(self.request, DIGEST, root=shallow, run_url="u", wait_minutes=1)
        self.assertEqual(run_git(self.remote, "show", "main:README"), "moved\n")
        for name in train.LISTS:
            self.assertEqual(self.remote_list(name).count(DIGEST), 1)

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


# The jobs of deploy run 39978053401: the first real release train's ordinary deploy (2026-10-23).
FIRST_REAL_DEPLOY_JOBS = [
    ("Validate and plan full release", "success"),
    ("Reconcile API and verify readiness", "success"),
    ("Admit the API image automatically", "skipped"),
    ("Reconcile next-booking-frontend", "success"),
    ("Reconcile next-booking-admin", "success"),
    ("Reconcile next-pms-frontend", "success"),
    ("Reconcile next-marketplace-admin", "success"),
    ("Report per-service durable result", "success"),
]


class DeployOutcomeTests(unittest.TestCase):
    def test_an_ordinary_deploy_may_skip_only_the_automatic_admission(self):
        self.assertEqual(train.deploy_problems("success", FIRST_REAL_DEPLOY_JOBS), [])
        skipped_frontend = [(name, "skipped" if name == "Reconcile next-pms-frontend" else state)
                            for name, state in FIRST_REAL_DEPLOY_JOBS]
        self.assertEqual(train.deploy_problems("success", skipped_frontend), ["Reconcile next-pms-frontend: skipped"])
        failed_api = [(name, "failure" if name.startswith("Reconcile API") else state) for name, state in FIRST_REAL_DEPLOY_JOBS]
        self.assertEqual(train.deploy_problems("failure", failed_api),
                         ["run failure", "Reconcile API and verify readiness: failure"])
        failed_admit = [(name, "failure" if name.startswith("Admit") else state) for name, state in FIRST_REAL_DEPLOY_JOBS]
        self.assertEqual(train.deploy_problems("success", failed_admit), ["Admit the API image automatically: failure"])
        self.assertEqual(train.deploy_problems("success", []), ["no job detail"])

    def test_the_allowed_skip_is_the_deploy_workflows_repository_dispatch_only_job(self):
        workflow = (ROOT / ".github/workflows/deploy-coordinated-release.yml").read_text()
        for name in train.SKIPPED_ON_DISPATCH:
            body = re.split(r"\n  [a-z][a-z-]*:\n", workflow.split(f"    name: {name}\n", 1)[1])[0]
            self.assertRegex(body, r"(?m)^    if: github\.event_name == 'repository_dispatch' && ", name)


class DeployVerifyCommandTests(unittest.TestCase):
    """command_deploy_verify end to end with GitHub, AWS and the clock replaced."""

    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.bundle = self.directory / "bundle"
        self.bundle.mkdir()
        services = {key: {"digest": f"sha256:{str(index) * 64}"} for index, key in enumerate(release_services(), 1)}
        self.own = {key: image["digest"] for key, image in services.items()}
        (self.bundle / "manifest.json").write_text(json.dumps({"source": {"sha": SHA}, "services": services}))
        self.request = {"sha": SHA, "artifactId": 12512032371, "manifestSha256": "c" * 64,
                        "publishedRecordSha256": "d" * 64, "summary": "s", "dryRun": False, "admission": "push",
                        "appRunId": 42, "appRunUrl": "u"}
        (self.bundle / "request.json").write_text(json.dumps(self.request))
        self.summary = self.directory / "summary.md"
        self.summary.write_text("")
        self.enterContext(mock.patch.dict(train.os.environ, {
            "GITHUB_REPOSITORY": "vayada-marketplace/vayada-platform", "GH_TOKEN": "t",
            "COORDINATED_RELEASE_READ_TOKEN": "t", "GITHUB_STEP_SUMMARY": str(self.summary)}))
        self.enterContext(mock.patch.object(train.release, "Aws"))
        self.app = mock.Mock()
        self.enterContext(mock.patch.object(train.release, "GitHub", return_value=self.app))
        self.enterContext(mock.patch.object(train, "PlatformGitHub"))
        self.enterContext(mock.patch.object(train.time, "sleep"))
        # With sleep patched out, an unexpected real wait would spin until its deadline: fail fast.
        self.enterContext(mock.patch.object(train, "wait_run", side_effect=AssertionError("unexpected deploy wait")))
        self.enterContext(mock.patch.object(train, "find_deploy_run", return_value={
            "id": 39978053401, "html_url": "https://run/39978053401", "created_at": "2026-10-23T15:24:52Z"}))
        self.enterContext(mock.patch.object(train, "plan_of", return_value={
            "artifactId": 12512032371, "sourceSha": SHA, "manifestSha256": "c" * 64,
            "publishedRecordSha256": "d" * 64, "order": "new", "acceptance": "accepted"}))
        self.enterContext(mock.patch.object(train, "count_log_events", return_value=0))
        self.enterContext(mock.patch.object(train, "health_status", return_value=200))
        self.old = {"sourceSha": NEWER.replace("b", "0"), "acceptedAt": "2026-10-23T11:52:24Z", "artifactId": 1}

    def run_command(self, *, conclusion, jobs, desired_after, live_after=None):
        """jobs and live_after may be an exception: the read fails after its retries."""
        old_live = {key: "sha256:" + "f" * 64 for key in self.own}
        if live_after is None:
            live_after = self.own if conclusion == "success" else old_live
        jobs_mock = {"side_effect": jobs} if isinstance(jobs, Exception) else {"return_value": jobs}
        with mock.patch.object(train, "wait_run", return_value={
                 "id": 39978053401, "run_attempt": 1, "conclusion": conclusion, "html_url": "https://run/39978053401"}), \
             mock.patch.object(train, "run_jobs", **jobs_mock), \
             mock.patch.object(train, "desired_release", side_effect=[self.old, desired_after]), \
             mock.patch.object(train, "live_digests", side_effect=[old_live, live_after]):
            train.command_deploy_verify(argparse.Namespace(bundle=str(self.bundle), deploy_minutes=90))

    def rows(self):
        return {line.split("|")[1].strip(): line.split("|")[2].strip()
                for line in self.summary.read_text().splitlines() if line.startswith("| ") and "---" not in line}

    def test_the_first_real_deploy_verifies_digests_logs_and_health(self):
        self.run_command(conclusion="success", jobs=FIRST_REAL_DEPLOY_JOBS,
                         desired_after={"sourceSha": SHA, "acceptedAt": "2026-10-23T15:25:34Z", "artifactId": 12512032371})
        self.assertEqual(self.rows(), {"Step": "Result", "deploy": "done", "live digests": "done", "logs": "done", "health": "done"})

    def test_a_failed_deploy_still_reports_what_is_live_then_fails(self):
        jobs = [(name, "failure" if name == "Reconcile next-pms-frontend" else state) for name, state in FIRST_REAL_DEPLOY_JOBS]
        self.app.compare.return_value = "behind"
        with self.assertRaisesRegex(train.TrainError, "not verified"):
            self.run_command(conclusion="failure", jobs=jobs, desired_after=self.old)
        rows = self.rows()
        self.assertEqual((rows["deploy"], rows["live digests"], rows["logs"], rows["health"]),
                         ("failed", "failed", "done", "done"))
        self.assertIn("Reconcile next-pms-frontend: failure", self.summary.read_text())

    def test_a_release_contained_in_a_newer_accepted_identical_one_only_verifies(self):
        # The rerun of 39977836231: desired-release had moved to 396cf265c (same images), so it
        # dispatched an ordinary deploy that skipped every service as stale.
        newer = {"sourceSha": NEWER, "acceptedAt": "2026-10-23T15:55:41Z", "artifactId": 12513000000}
        self.app.compare.return_value = "ahead"
        with mock.patch.object(train, "desired_release", return_value=newer), \
             mock.patch.object(train, "live_digests", return_value=dict(self.own)):
            train.command_deploy_verify(argparse.Namespace(bundle=str(self.bundle), deploy_minutes=90))
        train.PlatformGitHub.assert_not_called()
        train.find_deploy_run.assert_not_called()
        self.app.compare.assert_called_once_with(SHA, NEWER)
        self.assertEqual(self.rows(), {"Step": "Result", "deploy": "done", "live digests": "done",
                                       "logs": "done", "health": "done"})
        self.assertIn(f"desired-release {NEWER[:9]} contains this sha", self.summary.read_text())
        # The re-verify of 6fbc174a8 (run 39992892475) printed the raw filter syntax, which readers lost.
        self.assertIn("| logs | done | 0 x `42501`, 0 x `permission denied`, 0 x `level >= 50` "
                      "since 2026-10-23T15:54:41Z |\n", self.summary.read_text())
        self.assertNotRegex(self.summary.read_text(), r"[${}\"]")

    def test_log_hits_fail_the_logs_row_with_a_count_per_pattern(self):
        newer = {"sourceSha": NEWER, "acceptedAt": "2026-10-23T15:55:41Z", "artifactId": 12513000000}
        self.app.compare.return_value = "ahead"
        hits = {'"42501"': 2, '"permission denied"': 0, "{ $.level >= 50 }": 1}
        with mock.patch.object(train, "desired_release", return_value=newer), \
             mock.patch.object(train, "live_digests", return_value=dict(self.own)), \
             mock.patch.object(train, "count_log_events", side_effect=lambda pattern, *_: hits[pattern]), \
             self.assertRaisesRegex(train.TrainError, "not verified"):
            train.command_deploy_verify(argparse.Namespace(bundle=str(self.bundle), deploy_minutes=90))
        self.assertIn("| logs | failed | 2 x `42501`, 0 x `permission denied`, 1 x `level >= 50` "
                      "since 2026-10-23T15:54:41Z |\n", self.summary.read_text())

    # CodeRabbit on #636: a read that fails after its retries is a failed row, never an abort.
    def test_unreadable_deploy_jobs_fail_the_deploy_row_and_verification_goes_on(self):
        new = {"sourceSha": SHA, "acceptedAt": "2026-10-23T15:25:34Z", "artifactId": 12512032371}
        with self.assertRaisesRegex(train.TrainError, "not verified"):
            self.run_command(conclusion="success", jobs=train.TrainError("GET jobs: HTTP 502"), desired_after=new)
        rows = self.rows()
        self.assertEqual((rows["deploy"], rows["live digests"], rows["logs"], rows["health"]),
                         ("failed", "done", "done", "done"))
        self.assertIn("could not read the deploy jobs: GET jobs: HTTP 502", self.summary.read_text())

    def test_an_unreadable_live_state_is_a_failed_row_not_the_old_snapshot(self):
        new = {"sourceSha": SHA, "acceptedAt": "2026-10-23T15:25:34Z", "artifactId": 12512032371}
        with self.assertRaisesRegex(train.TrainError, "not verified"):
            self.run_command(conclusion="success", jobs=FIRST_REAL_DEPLOY_JOBS, desired_after=new,
                             live_after=train.TrainError("read live next-pms-frontend: throttled"))
        rows = self.rows()
        self.assertEqual((rows["deploy"], rows["live digests"], rows["logs"], rows["health"]),
                         ("done", "failed", "done", "done"))
        self.assertIn("could not read the live state after the deploy", self.summary.read_text())


class LogDetailTests(unittest.TestCase):
    def test_every_pattern_has_a_plain_label(self):
        self.assertEqual(set(train.LOG_LABELS), set(train.LOG_PATTERNS))
        for label in train.LOG_LABELS.values():
            self.assertNotRegex(label, r"[${}\"|`]")

    def test_the_row_counts_each_pattern_by_its_label(self):
        start_ms = int(train.dt.datetime(2026, 10, 23, 16, 57, 18, tzinfo=train.dt.timezone.utc).timestamp() * 1000)
        counts = {'"42501"': 0, '"permission denied"': 0, "{ $.level >= 50 }": 0}
        self.assertEqual(train.log_detail(counts, start_ms),
                         "0 x `42501`, 0 x `permission denied`, 0 x `level >= 50` since 2026-10-23T16:57:18Z")


class AlreadyLiveTests(unittest.TestCase):
    """2026-10-23: 6fbc174a8 was live when 396cf265c (tests only, byte-identical images) was accepted."""

    own = {"next-target-backend": DIGEST, "next-pms-frontend": "sha256:" + "2" * 64}

    def test_this_sha_or_a_containing_newer_release_with_these_live_images_needs_no_deploy(self):
        never = mock.Mock(side_effect=AssertionError("no compare needed"))
        self.assertIn("names this sha", train.already_live(SHA, self.own, {"sourceSha": SHA}, dict(self.own), never))
        compare = mock.Mock(return_value="ahead")
        reason = train.already_live(SHA, self.own, {"sourceSha": NEWER}, dict(self.own), compare)
        compare.assert_called_once_with(SHA, NEWER)
        self.assertIn(f"desired-release {NEWER[:9]} contains this sha", reason)

    def test_anything_else_still_deploys(self):
        other_live = {**self.own, "next-pms-frontend": "sha256:" + "3" * 64}
        never = mock.Mock(side_effect=AssertionError("no compare needed"))
        self.assertIsNone(train.already_live(SHA, self.own, None, dict(self.own), never))
        self.assertIsNone(train.already_live(SHA, self.own, {"sourceSha": SHA}, other_live, never))
        self.assertIsNone(train.already_live(SHA, self.own, {"sourceSha": NEWER}, other_live, never))
        for order in ("behind", "diverged"):
            with self.subTest(order=order):
                self.assertIsNone(train.already_live(SHA, self.own, {"sourceSha": NEWER}, dict(self.own),
                                                     lambda *_: order))


def release_services():
    return list(train.release.load_config()["services"])


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
        self.assertRegex(self.workflow, r"admission:\n(?:        .+\n)*?        default: push\n")
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
        # A shallow checkout: AdmissionTests prove admission works from one.
        self.assertNotIn("fetch-depth", admit)
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
