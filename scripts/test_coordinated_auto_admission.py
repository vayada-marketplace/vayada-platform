#!/usr/bin/env python3
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("coordinated_auto_admission", ROOT / "scripts/coordinated_auto_admission.py")
admission = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(admission)

SHA = "a" * 40
ADMITTED_SHA = "b" * 40
DIGEST = "sha256:" + "c" * 64
ADMITTED = [(ADMITTED_SHA, "sha256:" + "d" * 64)]
PLAN = {"order": "new", "sourceSha": SHA, "artifactId": 42, "manifestSha256": "e" * 64, "publishedRecordSha256": "f" * 64}


def pr_checks(*extra_suites, drop=(), shards="platform, pms, pricing, hotel-setup"):
    """A PR Checks workflow shaped like the app's: jobs, matrices, named steps and suite lists."""
    suites = [f"src/domains/suite{i}.integration.test.ts" for i in range(120) if i not in drop] + list(extra_suites)
    return "\n".join([
        "jobs:", "  frontend:", "    steps:", "      - name: Typecheck", "        run: npm run typecheck",
        "  api_postgres:", "    strategy:", "      matrix:", '        postgres: [16, 17]', f"        shard: [{shards}]",
        "    steps:", "      - name: Run PMS TypeScript PostgreSQL integration", "        run: >-",
        "          npm --workspace vayada-api run test --", *(f"          {suite}" for suite in suites), ""])


def full_jobs(conclusion="success"):
    names = ["Select checks", "Frontend Test, Typecheck, Lint", "Frontend Build and App Tests",
             "First-Party Auth Contracts", "PMS Web Browser Specs (1/2)", "PMS Web Browser Specs (2/2)",
             "Booking Web Browser Specs", "Booking Admin Browser Specs", "TypeScript API and Package Unit Suites",
             "Backend Tests (booking-api)", "Backend Tests (pms-api)", "Required Checks"]
    for version in (16, 17):
        names += [f"TypeScript API PostgreSQL Integration (PG{version}, {leg})"
                  for leg in ("platform", "pms", "pms-migrations", "pricing", "hotel-setup")]
        names.append(f"Setup Draft Reset PostgreSQL {version} Integration")
    return [{"name": name, "conclusion": conclusion} for name in names]


class FakeGitHub:
    """The app repository's API: a full green queue run on SHA, no hold, one ordinary change."""

    def __init__(self):
        self.runs = [{"id": 7, "run_attempt": 2, "head_sha": SHA, "conclusion": "success", "event": "merge_group",
                      "path": ".github/workflows/pr-checks.yml", "updated_at": "2026-10-18T20:09:00Z",
                      "repository": {"full_name": "vayada-marketplace/vayada"}}]
        self.jobs = full_jobs()
        self.holds = []
        # Directory listings per commit: the same migrations, PR Checks definition and scripts/ci.
        self.trees = {commit: {"packages/backend-migration": {"migrations": "m1", "src": "s" + commit[0]},
                               ".github/workflows": {"pr-checks.yml": "p1", "deploy.yml": "d" + commit[0]},
                               "scripts/ci": {"pr-checks.mjs": "c1", "pr-checks.test.mjs": "t" + commit[0]}}
                      for commit in (SHA, ADMITTED_SHA)}
        self.workflows = {SHA: pr_checks("src/new.integration.test.ts"), ADMITTED_SHA: pr_checks()}
        self.paths = []

    def __call__(self, path, raw=False):
        self.paths.append(path)
        match = re.fullmatch(r"/contents/\.github/workflows/pr-checks\.yml\?ref=([0-9a-f]{40})", path)
        if match:
            assert raw, path
            return self.workflows[match.group(1)]
        assert not raw, path
        if path.startswith("/actions/workflows/pr-checks.yml/runs?"):
            self.assert_query(path, event="merge_group", head_sha=SHA, status="success")
            return {"workflow_runs": self.runs}
        if path.startswith("/actions/runs/"):
            run, attempt = re.match(r"/actions/runs/(\d+)/attempts/(\d+)/jobs", path).groups()
            assert (int(run), int(attempt)) == (7, 2), path
            return {"jobs": self.jobs}
        if path.startswith("/issues?"):
            self.assert_query(path, state="open", labels="release-train-hold")
            return self.holds
        match = re.fullmatch(r"/contents/(.+)\?ref=([0-9a-f]{40})", path)
        if match and match.group(1) in self.trees[match.group(2)]:
            return [{"name": name, "sha": sha} for name, sha in self.trees[match.group(2)][match.group(1)].items()]
        raise AssertionError(f"unexpected GitHub call {path}")

    @staticmethod
    def assert_query(path, **expected):
        query = dict(part.split("=", 1) for part in path.split("?", 1)[1].split("&"))
        for key, value in expected.items():
            assert query.get(key) == value, (path, key)


class DecisionTests(unittest.TestCase):
    def decide(self, github, plan=PLAN, admitted=ADMITTED, digest=DIGEST):
        return admission.decide(github, plan, SHA, digest, admitted)

    def test_full_green_queue_run_without_hold_or_migration_admits(self):
        self.assertEqual(self.decide(FakeGitHub()), [])

    def test_an_open_release_hold_refuses(self):
        github = FakeGitHub()
        github.holds = [{"state": "open", "html_url": "https://github.com/x/issues/1"},
                        {"state": "open", "html_url": "https://github.com/x/pull/2", "pull_request": {}}]
        self.assertEqual(self.decide(github), ["release-train-hold open: https://github.com/x/issues/1"])

    def test_a_queue_run_that_skipped_or_failed_any_job_refuses(self):
        for conclusion in ("skipped", "failure", "cancelled", None):
            github = FakeGitHub()
            github.jobs[3]["conclusion"] = conclusion
            problems = self.decide(github)
            self.assertEqual(problems, [f"run 7: First-Party Auth Contracts: {conclusion}"], conclusion)

    def test_missing_legs_too_few_jobs_or_no_queue_run_refuse(self):
        github = FakeGitHub()
        github.jobs = [job for job in github.jobs if job["name"] != "TypeScript API PostgreSQL Integration (PG17, pricing)"]
        self.assertEqual(self.decide(github), ["run 7: missing PG17 pricing leg"])
        github.jobs = github.jobs[:10]
        self.assertIn("run 7: only 10 jobs ran (expected at least 22)", self.decide(github))
        for runs in ([], [{**FakeGitHub().runs[0], "event": "pull_request"}],
                     [{**FakeGitHub().runs[0], "head_sha": "9" * 40}],
                     [{**FakeGitHub().runs[0], "path": ".github/workflows/other.yml"}],
                     [{**FakeGitHub().runs[0], "repository": {"full_name": "someone/fork"}}]):
            github = FakeGitHub()
            github.runs = runs
            self.assertEqual(self.decide(github), [f"no green merge-queue run of PR Checks on {SHA}"])

    def test_the_newest_green_queue_run_counts(self):
        github = FakeGitHub()
        github.runs = [{**github.runs[0], "id": 3, "run_attempt": 1, "updated_at": "2026-10-18T18:00:00Z"}, github.runs[0]]
        self.assertEqual(self.decide(github), [])

    def test_a_migration_change_since_the_last_admission_refuses(self):
        github = FakeGitHub()
        github.trees[SHA]["packages/backend-migration"]["migrations"] = "changed"
        self.assertEqual(self.decide(github), [f"packages/backend-migration/migrations changed since {ADMITTED_SHA}"])
        # Other files next to the migrations may change.
        github = FakeGitHub()
        self.assertNotEqual(github.trees[SHA]["packages/backend-migration"]["src"],
                            github.trees[ADMITTED_SHA]["packages/backend-migration"]["src"])
        self.assertEqual(self.decide(github), [])

    def test_pr_checks_may_gain_checks_but_not_lose_any(self):
        workflow = ".github/workflows/pr-checks.yml"
        cases = {
            "a dropped suite": (pr_checks(drop=(7,)), [f"{workflow} no longer names test 'src/domains/suite7.integration.test.ts'"]),
            "a renamed step": (pr_checks().replace("- name: Typecheck", "- name: Types"), [f"{workflow} no longer names step 'Typecheck'"]),
            "a removed shard": (pr_checks(shards="platform, pms, hotel-setup"), [f"{workflow} no longer names shard 'pricing'"]),
            "a removed job": (pr_checks().replace("  frontend:\n", ""), [f"{workflow} no longer names job 'frontend'"]),
            "a changed npm script": (pr_checks().replace("npm run typecheck", "npm run typecheck:fast"),
                                     [f"{workflow} no longer names run 'npm run typecheck'"]),
        }
        for label, (text, expected) in cases.items():
            github = FakeGitHub()
            github.workflows[SHA] = text
            self.assertEqual([p.split(" (since")[0] for p in self.decide(github)], expected, label)
        github = FakeGitHub()
        github.workflows[SHA] = pr_checks("src/a.integration.test.ts", shards="platform, pms, pms-migrations, pricing, hotel-setup")
        self.assertEqual(self.decide(github), [])
        github.workflows[ADMITTED_SHA] = "jobs:\n  frontend:\n"
        self.assertIn(f"{workflow} at {ADMITTED_SHA} names only 1 checks", self.decide(github))

    def test_an_unreadable_or_missing_tree_raises_instead_of_admitting(self):
        github = FakeGitHub()
        del github.trees[SHA]["packages/backend-migration"]["migrations"]
        with self.assertRaisesRegex(ValueError, "migrations is missing"):
            self.decide(github)

    def test_already_admitted_or_not_new_releases_are_left_alone_without_calls(self):
        github = FakeGitHub()
        self.assertEqual(self.decide(github, digest=ADMITTED[0][1]), [f"{ADMITTED[0][1]} is already admitted"])
        for order in ("duplicate", "stale", "explicit-resume"):
            self.assertEqual(self.decide(github, plan={**PLAN, "order": order}), [f"plan order is {order}, not new"])
        self.assertEqual(github.paths, [])

    def test_nothing_admitted_yet_refuses(self):
        self.assertEqual(self.decide(FakeGitHub(), admitted=[]), ["no admitted commit to compare against"])


class BundleAndListTests(unittest.TestCase):
    def bundle(self, directory, plan=PLAN, sha=SHA, digest=DIGEST):
        bundle = Path(directory)
        (bundle / "plan.json").write_text(json.dumps(plan))
        (bundle / "manifest.json").write_text(json.dumps({
            "source": {"sha": sha, "branch": "main"}, "services": {"next-target-backend": {"digest": digest}}}))
        return bundle

    def test_release_identity_comes_from_the_validated_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(admission.release_identity(self.bundle(directory)), (PLAN, SHA, DIGEST))
        for kwargs in ({"sha": "a" * 39}, {"plan": {**PLAN, "sourceSha": "b" * 40}}, {"digest": "sha256:bad"}, {"digest": None}):
            with self.subTest(**{k: str(v)[:12] for k, v in kwargs.items()}), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    admission.release_identity(self.bundle(directory, **kwargs))

    def test_append_adds_one_pair_to_both_lists_and_refuses_a_second_time(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.bundle(directory)
            split, ongoing = Path(directory) / "split.txt", Path(directory) / "ongoing.txt"
            for path in (split, ongoing):
                path.write_text(f"# source revision  immutable ECR digest\n{ADMITTED_SHA} {ADMITTED[0][1]}\n")
            with mock.patch.object(admission, "SPLIT_LIST", split), mock.patch.object(admission, "ONGOING_EXPORT_LIST", ongoing), \
                    mock.patch("sys.argv", ["coordinated_auto_admission.py", "append", "--bundle", str(bundle)]):
                admission.main()
                for path in (split, ongoing):
                    self.assertEqual(admission.entries(path), [ADMITTED[0], (SHA, DIGEST)])
                with self.assertRaises(SystemExit):
                    admission.main()
                self.assertEqual(len(admission.entries(split)), 2)

    def test_check_turns_any_error_into_admit_false(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.bundle(directory)
            output = Path(directory) / "output"
            argv = ["coordinated_auto_admission.py", "check", "--bundle", str(bundle)]
            for env, fetch in (({"COORDINATED_RELEASE_READ_TOKEN": ""}, FakeGitHub()),
                               ({"COORDINATED_RELEASE_READ_TOKEN": "t"}, mock.Mock(side_effect=RuntimeError("HTTP 502")))):
                output.write_text("")
                with mock.patch("sys.argv", argv), mock.patch.dict("os.environ", {**env, "GITHUB_OUTPUT": str(output)}), \
                        mock.patch.object(admission, "github_fetch", return_value=fetch):
                    admission.main()
                self.assertEqual(output.read_text(), "admit=false\n")
            output.write_text("")
            with mock.patch("sys.argv", argv), mock.patch.dict("os.environ", {"COORDINATED_RELEASE_READ_TOKEN": "t", "GITHUB_OUTPUT": str(output)}), \
                    mock.patch.object(admission, "github_fetch", return_value=FakeGitHub()), \
                    mock.patch.object(admission, "entries", return_value=ADMITTED):
                admission.main()
            self.assertEqual(output.read_text(), "admit=true\n")

    def test_the_real_lists_parse_as_pairs(self):
        for path in (admission.SPLIT_LIST, admission.ONGOING_EXPORT_LIST):
            for sha, digest in admission.entries(path):
                self.assertRegex(sha, admission.SHA)
                self.assertRegex(digest, admission.DIGEST)


class WorkflowContractTests(unittest.TestCase):
    workflow = (ROOT / ".github/workflows/deploy-coordinated-release.yml").read_text()

    def admit_job(self):
        return re.split(r"\n  [a-z]+:\n", self.workflow.split("\n  admit:\n", 1)[1])[0]

    def test_admission_is_off_unless_the_variable_is_set_and_follows_only_skipped_automatic_events(self):
        job = self.admit_job()
        self.assertIn("    needs: prepare\n", job)
        self.assertIn("    if: github.event_name == 'repository_dispatch' && needs.prepare.result == 'success' && "
                      "needs.prepare.outputs.auto_skip == 'true' && vars.AUTO_ADMIT_NEXT_API_IMAGES == 'true'\n", job)
        self.assertIn("    permissions:\n      contents: write\n      actions: write\n    steps:\n", job)
        self.assertNotIn("id-token", job)
        self.assertNotIn("configure-aws-credentials", job)

    def test_admission_is_tested_pushed_and_dispatched_only_after_the_gates(self):
        job = self.admit_job()
        order = ["Require preparation in this attempt", "ref: main", "name: ${{ env.RELEASE_BUNDLE_ARTIFACT }}",
                 "coordinated_auto_admission.py check --bundle release-bundle",
                 "python3 scripts/test-next-api-split-compatible-image.py",
                 "python3 -m unittest scripts/test_coordinated_release.py",
                 "python3 scripts/test-target-database-split-deployment-ready.py",
                 "python3 scripts/test-finance-export-once.py",
                 "node --test scripts/test-legacy-migration-oneoff.mjs",
                 "coordinated_auto_admission.py append --bundle release-bundle", "check_lists\n",
                 "git push origin HEAD:main", "git pull --rebase origin main\n            check_lists",
                 "gh workflow run deploy-coordinated-release.yml"]
        positions = [job.index(text) for text in order]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(job.count("if: steps.gates.outputs.admit == 'true'"), 2)
        dispatch = job.split("gh workflow run deploy-coordinated-release.yml", 1)[1]
        for text in ("-f operation=ordinary", "jq -r .artifactId release-bundle/plan.json",
                     "jq -r .manifestSha256 release-bundle/plan.json",
                     "jq -r .publishedRecordSha256 release-bundle/plan.json", "-f service=none"):
            self.assertIn(text, dispatch)


if __name__ == "__main__":
    unittest.main()
