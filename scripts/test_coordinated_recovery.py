"""Recovery sequences through the real reconciler, with AWS/GitHub/smoke mocked.

These checks do not prove AWS IAM, network health, workflow scheduling or locks.
All durable state is copied on read/write so failed writes cannot mutate it.
"""

import argparse
import contextlib
import copy
import datetime as dt
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import test_coordinated_release as contract

release = contract.release


class RunnerInterrupted(BaseException):
    """Simulate loss of the worker without executing its exception handler."""


class MemoryAws:
    def __init__(self, config):
        self.config = config
        self.state, self.live, self.tasks = {}, {}, {}
        self.mutations = []
        self.deny_writes = False
        self.after_update = lambda: None
        self.verify_image = mock.Mock()
        self.verify_api_split_image = mock.Mock()
        self.wait_service = mock.Mock()
        deployment = config["deployment"]
        self.arn = f"arn:aws:ecs:{deployment['region']}:{deployment['accountId']}"
        for key, physical in config["services"].items():
            task = f"{self.arn}:task-definition/{physical['taskFamily']}:1"
            self.tasks[task] = self.snapshot(key, task, "sha256:" + "9" * 64)
            self.live[key] = task

    def snapshot(self, key, task, digest):
        deployment = self.config["deployment"]
        physical = self.config["services"][key]
        return {
            "serviceArn": f"{self.arn}:service/{deployment['cluster']}/{physical['ecsService']}",
            "taskDefinitionArn": task,
            "image": f"{deployment['accountId']}.dkr.ecr.{deployment['region']}.amazonaws.com/{physical['ecrRepository']}@{digest}",
            "digest": digest,
        }

    def get_parameter(self, name):
        return copy.deepcopy(self.state.get(name))

    def put_parameter(self, name, value):
        if self.deny_writes:
            raise release.ReleaseError("simulated SSM AccessDenied")
        self.state[name] = copy.deepcopy(value)

    def service_snapshot(self, key):
        return copy.deepcopy(self.tasks[self.live[key]])

    def register_rendered_task(self, key, before, digest):
        family = self.config["services"][key]["taskFamily"]
        task = f"{self.arn}:task-definition/{family}:{len(self.tasks) + 1}"
        self.tasks[task] = self.snapshot(key, task, digest)
        return task

    def update_service(self, key, task):
        self.live[key] = task
        self.mutations.append((key, task))
        self.after_update()


class RecoverySequenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = contract.ContractTests()
        self.fixture.setUp()
        self.config = self.fixture.config
        self.manifest = self.fixture.manifest
        self.aws = MemoryAws(self.config)
        self.api = "next-target-backend"
        self.target = "next-booking-admin"
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.manifest_path = self.directory / "manifest.json"
        self.record_path = self.directory / "published-record.json"
        self.plan_path = self.directory / "plan.json"
        self.manifest_path.write_bytes(self.fixture.manifest_path.read_bytes())
        self.record_path.write_bytes(self.fixture.record_path.read_bytes())
        self.github = mock.Mock()
        self.github.download_bundle.return_value = self.fixture.artifact()
        self.github.json.side_effect = lambda path: (
            self.fixture.build_run() if "/41001/attempts/" in path else self.fixture.publisher_run()
        )
        self.github.compare.return_value = "ahead"
        self.smoke_failures = set()
        self.smoke_calls = []
        self.enterContext(mock.patch.object(release, "Aws", return_value=self.aws))
        self.enterContext(mock.patch.object(release, "GitHub", return_value=self.github))
        self.enterContext(mock.patch.object(release, "smoke_service", side_effect=self.smoke))
        self.enterContext(mock.patch.dict(release.os.environ, {
            "COORDINATED_RELEASE_READ_TOKEN": "offline-test-token", "GITHUB_STEP_SUMMARY": "",
        }))
        self.enterContext(mock.patch.object(release.subprocess, "run", side_effect=AssertionError("No subprocess in offline recovery tests")))
        self.enterContext(mock.patch.object(release.urllib.request, "urlopen", side_effect=AssertionError("No network in offline recovery tests")))
        # Frozen contract dates must remain valid when this regression runs later.
        validate = release.validate_publication
        self.enterContext(mock.patch.object(release, "validate_publication", side_effect=lambda **kwargs: validate(
            **kwargs, now=dt.datetime(2026, 9, 18, tzinfo=dt.timezone.utc))))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.aws.put_parameter(self.path("ownership-mode"), {
            "schemaVersion": 1, "mode": "batch", "changedAt": release.iso_now(), "operationId": "offline-bootstrap",
        })
        self.aws.put_parameter(self.path("desired-release"), {
            "schemaVersion": 1, "manifestId": self.manifest["previousManifestId"],
            "manifestSha256": "0" * 64, "publishedRecordSha256": "0" * 64,
            "artifactId": 1, "sourceSha": self.manifest["previousSourceSha"],
            "buildRunId": 40900, "buildRunAttempt": 1,
            "acceptedAt": release.iso_now(), "operationId": "offline-bootstrap",
        })
        barrier = self.manifest["barriers"][0]
        evidence = "offline synthetic acknowledgment"
        self.aws.put_parameter(self.path(f"checkpoints/{barrier['id']}"), {
            "schemaVersion": 1, "barrierId": barrier["id"], "kind": barrier["kind"],
            "introducedAt": barrier["introducedAt"], "checkpointManifestId": None,
            "evidenceRequirementSha256": release.sha256_bytes(barrier["evidenceRequirement"].encode()),
            "evidence": evidence, "evidenceSha256": release.sha256_bytes(evidence.encode()),
            "acknowledgedAt": release.iso_now(), "operationId": "offline-checkpoint",
        })

    def path(self, suffix):
        return release.state_path(self.config, suffix)

    def state(self, key, suffix):
        return self.aws.get_parameter(self.path(f"services/{key}/{suffix}"))

    def smoke(self, runner, config, key, source):
        self.smoke_calls.append(key)
        if key in self.smoke_failures:
            raise release.ReleaseError("simulated readiness failure")

    def prepare(self, operation_id, *, resume=None, bad_hash=False):
        args = argparse.Namespace(
            config=release.DEFAULT_CONFIG, artifact_id=93001, output_dir=self.directory,
            dispatch_json=None, operation="resume" if resume else "ordinary",
            operation_id=operation_id, service=resume,
            manifest_sha256="0" * 64 if bad_hash else release.sha256_file(self.manifest_path),
            published_record_sha256=release.sha256_file(self.record_path),
        )
        release.prepare_release(args)
        return release.read_json(self.plan_path)

    def reconcile(self, key):
        release.reconcile_service(argparse.Namespace(
            config=release.DEFAULT_CONFIG, manifest=self.manifest_path, plan=self.plan_path, service=key,
        ))

    def finalize(self):
        release.finalize_release(argparse.Namespace(
            config=release.DEFAULT_CONFIG, manifest=self.manifest_path, plan=self.plan_path,
        ))

    def publish_fixture(self):
        """Rebind synthetic publication bytes; keep the real publication validator."""
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.fixture.manifest = self.manifest
        record = self.fixture.record
        record["manifestId"] = self.manifest["manifestId"]
        record["idempotencyKey"] = self.manifest["manifestId"]
        record["manifestSha256"] = release.sha256_file(self.manifest_path)
        record["publishedArtifactName"] = (
            f"next-release-published-v1-{self.manifest['source']['sha']}-41001-2"
        )
        self.record_path.write_text(json.dumps(record))
        self.github.download_bundle.return_value = self.fixture.artifact()

    def durable_snapshot(self):
        return copy.deepcopy((self.aws.state, self.aws.live, self.aws.tasks, self.aws.mutations))

    def test_historical_publication_survives_later_build_and_publisher_attempts(self):
        build = self.fixture.build_run()
        publisher = self.fixture.publisher_run()
        publisher["status"], publisher["conclusion"] = "completed", "failure"
        historical = {
            f"/actions/runs/{build['id']}/attempts/{build['run_attempt']}": build,
            f"/actions/runs/{publisher['id']}/attempts/{publisher['run_attempt']}": publisher,
        }
        def metadata(path):
            if path in historical:
                return historical[path]
            # Latest endpoints would expose a later unsuccessful rerun.
            latest = copy.deepcopy(build if path.endswith(str(build["id"])) else publisher)
            latest["run_attempt"] += 1
            latest["conclusion"] = "failure"
            return latest
        self.github.json.side_effect = metadata
        self.prepare("redispatch-original-publication")
        for key in self.config["services"]:
            self.reconcile(key)
        self.finalize()
        self.assertEqual(self.github.json.call_args_list, [mock.call(path) for path in historical])

    def test_new_release_accepts_published_but_undelivered_baseline(self):
        # Desired A, published B never delivered, complete C was assembled from B.
        self.manifest["previousSourceSha"] = "2" * 40
        self.manifest["previousManifestId"] = "vayada-release/v1/" + "2" * 40 + "/41002/1"
        self.publish_fixture()
        plan = self.prepare("coalesced-release")
        self.assertEqual(plan["order"], "new")
        for key in self.config["services"]:
            self.reconcile(key)
        self.finalize()
        self.assertEqual(self.aws.state[self.path("desired-release")]["manifestId"], self.manifest["manifestId"])
        self.assertTrue(all(self.state(key, "provenance")["manifestId"] == self.manifest["manifestId"]
                            for key in self.config["services"]))

    def test_new_release_accepts_baseline_older_than_receiver_desired(self):
        # C planned from A while B's publication was still running; B was accepted first.
        desired = self.aws.state[self.path("desired-release")]
        desired["sourceSha"] = "2" * 40
        desired["manifestId"] = "vayada-release/v1/" + "2" * 40 + "/41002/1"
        plan = self.prepare("older-build-baseline")
        self.assertEqual(plan["order"], "new")
        for key in self.config["services"]:
            self.reconcile(key)
        self.finalize()
        self.assertEqual(self.aws.state[self.path("desired-release")]["manifestId"], self.manifest["manifestId"])

    def test_coalesced_release_cannot_skip_checkpoint_or_diverge_from_baseline(self):
        self.manifest["previousSourceSha"] = "2" * 40
        self.manifest["previousManifestId"] = "vayada-release/v1/" + "2" * 40 + "/41002/1"
        self.publish_fixture()
        del self.aws.state[self.path("checkpoints/" + self.manifest["barriers"][0]["id"])]
        before = self.durable_snapshot()
        with self.assertRaisesRegex(release.ReleaseError, "blocked by checkpoints"):
            self.prepare("unacknowledged-coalesced-release")
        self.assertEqual(self.durable_snapshot(), before)
        self.github.compare.side_effect = lambda source, target: "diverged" if source == "2" * 40 else "ahead"
        with self.assertRaisesRegex(release.ReleaseError, "previousSourceSha is not an ancestor"):
            self.prepare("divergent-build-baseline")
        self.assertEqual(self.durable_snapshot(), before)

    def test_stale_delivery_preserves_all_durable_state_and_live_tasks(self):
        desired = self.aws.state[self.path("desired-release")]
        desired["sourceSha"] = "2" * 40
        desired["manifestId"] = "vayada-release/v1/" + "2" * 40 + "/41002/1"
        self.github.compare.side_effect = lambda source, target: "behind" if source == "2" * 40 else "ahead"
        before = self.durable_snapshot()
        plan = self.prepare("stale-delivery")
        self.assertEqual(plan["order"], "stale")
        self.assertEqual({row["action"] for row in plan["services"].values()}, {"skip"})
        for key in self.config["services"]:
            self.reconcile(key)
        self.finalize()
        self.assertEqual(self.durable_snapshot(), before)
        self.assertEqual(self.smoke_calls, [])

    def test_legacy_automatic_events_remain_fenced_after_ownership_rollback(self):
        self.prepare("accepted-release")
        # Model only ownership rollback: the accepted desired record must survive.
        self.aws.state[self.path("ownership-mode")]["mode"] = "legacy"
        before = self.durable_snapshot()
        for key in self.config["services"]:
            with self.subTest(service=key):
                with self.assertRaisesRegex(release.ReleaseError, "remains fenced"):
                    release.guard_legacy(argparse.Namespace(
                        config=release.DEFAULT_CONFIG, service=key,
                        event_name="repository_dispatch", operation_id="delayed-legacy",
                    ))
                self.assertEqual(self.durable_snapshot(), before)
        self.assertEqual(self.aws.state[self.path("desired-release")]["manifestId"], self.manifest["manifestId"])

    def test_successor_cannot_skip_retained_checkpoint_evidence_or_completion(self):
        barrier = self.manifest["barriers"][0]
        barrier["requiredCheckpointManifestId"] = self.manifest["manifestId"]
        checkpoint_id = self.manifest["manifestId"]
        ack_path = self.path(f"checkpoints/{barrier['id']}")
        completion_path = self.path(f"checkpoint-completions/{barrier['id']}")
        self.aws.state[ack_path]["checkpointManifestId"] = checkpoint_id
        self.publish_fixture()
        self.prepare("checkpoint-release")
        self.reconcile(self.api)
        with self.assertRaisesRegex(release.ReleaseError, "not fully deployed"):
            self.finalize()
        self.assertNotIn(completion_path, self.aws.state)
        self.assertEqual(self.aws.state[self.path("checkpoint-obligations")]["barriers"], [barrier])
        for key in self.config["services"]:
            if key != self.api:
                self.reconcile(key)
        self.finalize()
        acknowledgment = copy.deepcopy(self.aws.state[ack_path])
        completion = copy.deepcopy(self.aws.state[completion_path])
        self.assertEqual(completion["checkpointManifestId"], checkpoint_id)
        self.assertEqual(completion["operationId"], "checkpoint-release")

        # A successor deliberately omits the barrier: durable obligations still apply.
        self.manifest["previousManifestId"] = checkpoint_id
        self.manifest["previousSourceSha"] = self.manifest["source"]["sha"]
        self.manifest["source"]["sha"] = "2" * 40
        self.manifest["manifestId"] = "vayada-release/v1/" + "2" * 40 + "/41001/2"
        self.manifest["barriers"] = []
        self.publish_fixture()
        for failure in ("missing-ack", "mismatched-ack", "missing-completion", "mismatched-completion"):
            with self.subTest(failure=failure):
                self.aws.state[ack_path] = copy.deepcopy(acknowledgment)
                self.aws.state[completion_path] = copy.deepcopy(completion)
                if failure == "missing-ack":
                    del self.aws.state[ack_path]
                elif failure == "mismatched-ack":
                    self.aws.state[ack_path]["checkpointManifestId"] = self.manifest["manifestId"]
                elif failure == "missing-completion":
                    del self.aws.state[completion_path]
                else:
                    self.aws.state[completion_path]["checkpointManifestId"] = self.manifest["manifestId"]
                before = self.durable_snapshot()
                with self.assertRaisesRegex(release.ReleaseError, "blocked by checkpoints"):
                    self.prepare(failure)
                self.assertEqual(self.durable_snapshot(), before)
        self.aws.state[ack_path] = acknowledgment
        self.aws.state[completion_path] = completion
        plan = self.prepare("checkpoint-satisfied")
        self.assertEqual(plan["order"], "new")
        self.assertEqual(self.aws.state[self.path("checkpoint-obligations")]["barriers"], [])
        for key in self.config["services"]:
            self.reconcile(key)
        self.finalize()

    def test_success_then_duplicate_verifies_without_repeating_updates(self):
        self.prepare("first")
        for key in self.config["services"]:
            self.reconcile(key)
        self.finalize()
        self.assertEqual(len(self.aws.mutations), 6)
        plan = self.prepare("duplicate")
        self.assertEqual(plan["order"], "duplicate")
        self.assertEqual({row["action"] for row in plan["services"].values()}, {"verify"})
        for key in self.config["services"]:
            self.reconcile(key)
            self.assertEqual(self.state(key, "provenance")["operationId"], "duplicate")
        self.finalize()
        self.assertEqual(len(self.aws.mutations), 6)
        self.assertEqual(len(self.smoke_calls), 12)

    def test_partial_failure_keeps_successes_and_requires_explicit_resume(self):
        original = self.aws.live[self.target]
        self.prepare("partial")
        self.smoke_failures.add(self.target)
        for key in self.config["services"]:
            if key == self.target:
                with self.assertRaisesRegex(release.ReleaseError, "readiness failure"):
                    self.reconcile(key)
            else:
                self.reconcile(key)
        self.assertEqual(self.aws.live[self.target], original)
        self.assertEqual(self.state(self.target, "pending-operation")["status"], "rolled-back-held")
        hold = self.state(self.target, "hold")
        self.assertEqual(hold["capturedTaskDefinitionArn"], original)
        with self.assertRaisesRegex(release.ReleaseError, "not fully deployed"):
            self.finalize()
        updates = list(self.aws.mutations)
        self.smoke_failures.clear()
        plan = self.prepare("ordinary-retry")
        self.assertEqual(plan["services"][self.target]["action"], "held")
        for key in self.config["services"]:
            self.reconcile(key)
        self.assertEqual(self.aws.mutations, updates)
        self.assertEqual(self.state(self.target, "hold"), hold)
        self.prepare("explicit-resume", resume=self.target)
        self.reconcile(self.api)
        self.reconcile(self.target)
        self.finalize()
        self.assertEqual(len(self.aws.mutations), len(updates) + 1)
        self.assertEqual(self.state(self.target, "hold")["status"], "cleared")
        self.assertEqual(self.state(self.target, "provenance")["operationId"], "explicit-resume")

    def test_api_failure_leaves_frontends_unmodified_and_blocks_next_plan(self):
        original = dict(self.aws.live)
        self.prepare("api-failure")
        self.smoke_failures.add(self.api)
        with self.assertRaisesRegex(release.ReleaseError, "readiness failure"):
            self.reconcile(self.api)
        # The workflow owns initial API-before-frontends scheduling (separate contract test).
        self.assertEqual(self.aws.live, original)
        self.assertEqual({key for key, _ in self.aws.mutations}, {self.api})
        plan = self.prepare("api-retry")
        self.assertEqual(plan["services"][self.api]["action"], "held")
        for key in self.config["services"]:
            if key != self.api:
                self.assertEqual(plan["services"][key]["action"], "blocked")
                with self.assertRaisesRegex(release.ReleaseError, "blocked"):
                    self.reconcile(key)
        with self.assertRaisesRegex(release.ReleaseError, "not fully deployed"):
            self.finalize()

    def test_interrupted_worker_retains_original_rollback_target(self):
        original = self.aws.live[self.target]
        self.prepare("interrupted")
        self.aws.after_update = mock.Mock(side_effect=RunnerInterrupted)
        with self.assertRaises(RunnerInterrupted):
            self.reconcile(self.target)
        self.assertEqual(self.state(self.target, "pending-operation")["status"], "mutating")
        self.assertIsNone(self.state(self.target, "provenance"))
        self.aws.after_update = lambda: None
        self.smoke_failures.add(self.target)
        plan = self.prepare("recover-interrupted")
        self.assertEqual(plan["services"][self.target]["action"], "verify")
        with self.assertRaisesRegex(release.ReleaseError, "readiness failure"):
            self.reconcile(self.target)
        self.assertEqual(self.aws.live[self.target], original)
        self.assertEqual(self.state(self.target, "hold")["capturedTaskDefinitionArn"], original)
        self.assertEqual(len(self.aws.mutations), 2)

    def test_persistent_ssm_failure_preserves_pending_state_until_recovery(self):
        original = self.aws.live[self.target]
        self.prepare("ssm-denied")
        self.aws.after_update = lambda: setattr(self.aws, "deny_writes", True)
        with self.assertRaisesRegex(release.ReleaseError, "SSM AccessDenied"):
            self.reconcile(self.target)
        pending = self.state(self.target, "pending-operation")
        self.assertEqual(pending["status"], "mutating")
        self.assertEqual(pending["rollbackTaskDefinitionArn"], original)
        self.assertEqual(self.aws.service_snapshot(self.target)["digest"], self.manifest["services"][self.target]["digest"])
        self.assertIsNone(self.state(self.target, "provenance"))
        self.assertIsNone(self.state(self.target, "hold"))
        self.assertEqual(len(self.aws.mutations), 1)  # No unrecorded rollback during the outage.
        with self.assertRaisesRegex(release.ReleaseError, "not fully deployed"):
            self.finalize()
        self.aws.deny_writes = False
        self.aws.after_update = lambda: None
        self.prepare("ssm-recovered")
        self.smoke_failures.add(self.target)
        with self.assertRaisesRegex(release.ReleaseError, "readiness failure"):
            self.reconcile(self.target)
        self.assertEqual(self.aws.live[self.target], original)
        self.assertEqual(self.state(self.target, "hold")["capturedTaskDefinitionArn"], original)
        self.assertEqual(self.state(self.target, "pending-operation")["status"], "rolled-back-held")

    def test_tamper_and_missing_checkpoint_reject_before_state_changes(self):
        original = copy.deepcopy(self.aws.state)
        with self.assertRaisesRegex(release.ReleaseError, "manifestSha256"):
            self.prepare("tampered", bad_hash=True)
        self.assertEqual(self.aws.state, original)
        del self.aws.state[self.path("checkpoints/booking-ledger-backfill")]
        original = copy.deepcopy(self.aws.state)
        with self.assertRaisesRegex(release.ReleaseError, "blocked by checkpoints"):
            self.prepare("missing-checkpoint")
        self.assertEqual(self.aws.state, original)
        self.assertEqual(self.aws.mutations, [])
        self.assertFalse(self.plan_path.exists())


if __name__ == "__main__":
    unittest.main()
