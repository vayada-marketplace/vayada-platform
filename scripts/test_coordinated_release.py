#!/usr/bin/env python3

import argparse
import copy
import datetime as dt
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("coordinated_release", ROOT / "scripts" / "coordinated_release.py")
release = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(release)


class GitHubDownloadTests(unittest.TestCase):
    def test_bundle_checksum_formats_and_tampering(self):
        fixtures = ROOT / "deployment" / "contract" / "fixtures"
        payloads = {stem: (fixtures / f"{stem}-v1.valid.json").read_bytes()
                    for stem in ("manifest", "published-record")}
        for stem in payloads:
            digest = release.sha256_bytes(payloads[stem])
            cases = [
                (digest, True),
                (f"{digest}  {stem}.json", True),
                (f"{'0' * 64}  {stem}.json", False),
                (f"{digest}  other.json", False),
                (f"{digest}  ../{stem}.json", False),
                (f"{digest}  {stem}.json\n{digest}", False),
            ]
            for checksum, valid in cases:
                with self.subTest(stem=stem, checksum=checksum), tempfile.TemporaryDirectory() as directory:
                    archive = io.BytesIO()
                    with zipfile.ZipFile(archive, "w") as zipped:
                        for name, content in payloads.items():
                            zipped.writestr(f"{name}.json", content)
                            value = checksum if name == stem else release.sha256_bytes(content)
                            zipped.writestr(f"{name}.sha256", value + "\n")
                    github = release.GitHub("owner/repo", "test-token")
                    with mock.patch.object(github, "json", return_value={"id": 1}), \
                         mock.patch.object(github, "request", return_value=archive.getvalue()):
                        if valid:
                            self.assertEqual(github.download_bundle(1, Path(directory)), {"id": 1})
                            self.assertEqual((Path(directory) / f"{stem}.json").read_bytes(), payloads[stem])
                        else:
                            with self.assertRaisesRegex(release.ReleaseError, "does not bind"):
                                github.download_bundle(1, Path(directory))

    def test_api_authentication_is_not_forwarded_to_signed_downloads(self):
        def open_request(request, *, timeout):
            self.assertEqual(timeout, 30)
            self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
            redirect = release.urllib.request.HTTPRedirectHandler().redirect_request(
                request, None, 302, "Found", {},
                "https://storage.example/artifact?signature=test",
            )
            self.assertIsNone(redirect.get_header("Authorization"))
            self.assertEqual(redirect.get_header("Accept"), "application/vnd.github+json")
            return io.BytesIO(b"artifact bytes")

        with mock.patch.object(release.urllib.request, "urlopen", side_effect=open_request):
            result = release.GitHub("owner/repo", "test-token").request("/actions/artifacts/1/zip")
        self.assertEqual(result, b"artifact bytes")


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.config = release.load_config()
        fixtures = ROOT / "deployment" / "contract" / "fixtures"
        self.manifest_path = fixtures / "manifest-v1.valid.json"
        self.record_path = fixtures / "published-record-v1.valid.json"
        self.manifest = release.read_json(self.manifest_path)
        self.record = release.read_json(self.record_path)

    def dispatch(self):
        build = self.manifest["build"]
        publisher = self.record["publisher"]
        return {
            "schemaVersion": 1,
            "manifestId": self.manifest["manifestId"],
            "manifestSha256": release.sha256_file(self.manifest_path),
            "publishedRecordSha256": release.sha256_file(self.record_path),
            "sourceSha": self.manifest["source"]["sha"],
            "repository": self.manifest["repository"],
            "workflowName": build["workflowName"],
            "workflowPath": build["workflowPath"],
            "runId": build["runId"],
            "runAttempt": build["runAttempt"],
            "publishedArtifactId": 93001,
            "publishedArtifactName": self.record["publishedArtifactName"],
            "publisherRunId": publisher["runId"],
            "publisherRunAttempt": publisher["runAttempt"],
            "idempotencyKey": self.record["idempotencyKey"],
        }

    def build_run(self):
        build = self.manifest["build"]
        return {
            "id": build["runId"],
            "run_attempt": build["runAttempt"],
            "path": build["workflowPath"],
            "head_sha": self.manifest["source"]["sha"],
            "head_branch": "main",
            "status": "completed",
            "conclusion": "success",
            "event": self.manifest["build"]["event"],
        }

    def publisher_run(self):
        publisher = self.record["publisher"]
        return {
            "id": publisher["runId"],
            "run_attempt": publisher["runAttempt"],
            "path": publisher["workflowPath"],
            "head_sha": "2" * 40,
            "head_branch": "main",
            "status": "completed",
            "conclusion": "success",
            "event": "workflow_run",
            "repository": {"full_name": self.manifest["repository"]},
            "head_repository": {"full_name": self.manifest["repository"]},
        }

    def artifact(self):
        return {
            "id": 93001,
            "name": self.record["publishedArtifactName"],
            "expired": False,
            "created_at": "2026-09-17T06:00:05Z",
            "expires_at": "2026-12-16T06:00:05Z",
            "workflow_run": {"id": self.record["publisher"]["runId"]},
        }

    def validate(self, **overrides):
        values = {
            "manifest_path": self.manifest_path,
            "record_path": self.record_path,
            "dispatch": self.dispatch(),
            "artifact": self.artifact(),
            "build_run": self.build_run(),
            "publisher_run": self.publisher_run(),
            "config": self.config,
            "now": dt.datetime(2026, 9, 18, tzinfo=dt.timezone.utc),
        }
        values.update(overrides)
        return release.validate_publication(**values)

    def test_frozen_fixture_hashes_and_contract_validate(self):
        self.assertEqual(release.sha256_file(self.manifest_path), "6360c61c601c1c043ce032e2dd2fa22c709204fc45debd026417d09d0be84382")
        self.assertEqual(release.sha256_file(self.record_path), "96882677caea9450ba1f94c55e3996f32a30098fa90876697c97a73a57bbe16a")
        manifest, record = self.validate()
        self.assertEqual(manifest["manifestId"], record["manifestId"])

    def test_publication_verification_checks_real_contract_without_state_or_ecs_access(self):
        for order, bad_hash in (("ahead", False), ("diverged", False), ("ahead", True)):
            with self.subTest(order=order, bad_hash=bad_hash), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                (output / "manifest.json").write_bytes(self.manifest_path.read_bytes())
                (output / "published-record.json").write_bytes(self.record_path.read_bytes())
                github = mock.Mock()
                github.download_bundle.return_value = self.artifact()
                github.json.side_effect = [self.build_run(), self.publisher_run()]
                github.compare.return_value = order
                aws = mock.Mock()
                args = argparse.Namespace(config=release.DEFAULT_CONFIG, artifact_id=93001,
                    output_dir=directory, dispatch_json=None, operation="verify",
                    manifest_sha256="0" * 64 if bad_hash else release.sha256_file(self.manifest_path),
                    published_record_sha256=release.sha256_file(self.record_path))
                with mock.patch.dict(release.os.environ, {"COORDINATED_RELEASE_READ_TOKEN": "test-token"}), \
                     mock.patch.object(release, "GitHub", return_value=github), \
                     mock.patch.object(release, "Aws", return_value=aws):
                    if bad_hash or order == "diverged":
                        with self.assertRaises(release.ReleaseError):
                            release.prepare_release(args)
                        self.assertEqual(aws.method_calls, [])
                        self.assertFalse((output / "verification.json").exists())
                    else:
                        release.prepare_release(args)
                        self.assertEqual(aws.method_calls, [mock.call.verify_image(key, image)
                            for key, image in self.manifest["services"].items()])
                        self.assertEqual(release.read_json(output / "verification.json")["deploymentReadiness"], "not-checked")
                    self.assertFalse((output / "plan.json").exists())

    def test_producer_invalid_repository_fixture_is_rejected(self):
        invalid = release.read_json(ROOT / "deployment" / "contract" / "fixtures" / "manifest-v1.invalid-wrong-repository.json")
        with self.assertRaisesRegex(release.ReleaseError, "repository"):
            release.validate_manifest(invalid, self.config)

    def test_unknown_manifest_field_is_rejected(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["issuedAt"] = "2026-09-17T00:00:00Z"
        with self.assertRaisesRegex(release.ReleaseError, "fields must be exactly"):
            release.validate_manifest(manifest, self.config)

    def test_wrong_service_repository_and_digest_are_rejected(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["services"]["next-booking-admin"]["ecrRepository"] = "vayada-next-api"
        with self.assertRaisesRegex(release.ReleaseError, "repository"):
            release.validate_manifest(manifest, self.config)
        manifest = copy.deepcopy(self.manifest)
        manifest["services"]["next-booking-admin"]["digest"] = "latest"
        with self.assertRaisesRegex(release.ReleaseError, "immutable"):
            release.validate_manifest(manifest, self.config)

    def test_tampered_manifest_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            tampered = copy.deepcopy(self.manifest)
            tampered["services"]["next-target-backend"]["digest"] = "sha256:" + "9" * 64
            path.write_text(json.dumps(tampered, indent=2) + "\n")
            with self.assertRaisesRegex(release.ReleaseError, "Manifest bytes"):
                self.validate(manifest_path=path)

    def test_wrong_or_failed_source_run_is_rejected(self):
        run = self.build_run()
        run["run_attempt"] += 1
        with self.assertRaisesRegex(release.ReleaseError, "exact run attempt"):
            self.validate(build_run=run)
        run = self.build_run()
        run["conclusion"] = "failure"
        with self.assertRaisesRegex(release.ReleaseError, "successfully completed"):
            self.validate(build_run=run)

    def test_wrong_publisher_artifact_and_expiration_are_rejected(self):
        artifact = self.artifact()
        artifact["workflow_run"]["id"] += 1
        with self.assertRaisesRegex(release.ReleaseError, "publisher run"):
            self.validate(artifact=artifact)
        artifact = self.artifact()
        artifact["expired"] = True
        with self.assertRaisesRegex(release.ReleaseError, "expired"):
            self.validate(artifact=artifact)
        with self.assertRaisesRegex(release.ReleaseError, "expired"):
            self.validate(now=dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc))

    def test_active_and_post_upload_failed_publisher_runs_are_trusted(self):
        active = self.publisher_run()
        active.update(status="in_progress", conclusion=None)
        self.validate(publisher_run=active)

        failed_after_upload = self.publisher_run()
        failed_after_upload["conclusion"] = "failure"
        self.validate(publisher_run=failed_after_upload)

        newer_main_publisher = self.publisher_run()
        self.assertNotEqual(newer_main_publisher["head_sha"], self.manifest["source"]["sha"])
        self.validate(publisher_run=newer_main_publisher)

    def test_untrusted_publisher_identity_or_lifecycle_is_rejected(self):
        wrong_repository = self.publisher_run()
        wrong_repository["repository"] = {"full_name": "attacker/fork"}
        with self.assertRaisesRegex(release.ReleaseError, "repository"):
            self.validate(publisher_run=wrong_repository)

        invalid_head = self.publisher_run()
        invalid_head["head_sha"] = "main"
        with self.assertRaisesRegex(release.ReleaseError, "head_sha"):
            self.validate(publisher_run=invalid_head)

        cancelled = self.publisher_run()
        cancelled["conclusion"] = "cancelled"
        with self.assertRaisesRegex(release.ReleaseError, "lifecycle"):
            self.validate(publisher_run=cancelled)

    def test_dispatch_cannot_substitute_artifact_or_attempt(self):
        dispatch = self.dispatch()
        dispatch["runAttempt"] += 1
        with self.assertRaisesRegex(release.ReleaseError, "runAttempt"):
            self.validate(dispatch=dispatch)
        dispatch = self.dispatch()
        dispatch["publishedArtifactId"] += 1
        with self.assertRaisesRegex(release.ReleaseError, "Artifact metadata ID"):
            self.validate(dispatch=dispatch)


class OrderingAndBarrierTests(unittest.TestCase):
    def setUp(self):
        self.config = release.load_config()
        self.manifest = release.read_json(ROOT / "deployment" / "contract" / "fixtures" / "manifest-v1.valid.json")

    def test_source_ancestry_orders_ordinary_releases(self):
        desired = {"sourceSha": "0" * 40}
        self.assertEqual(release.assess_order("1" * 40, desired, "ahead"), "new")
        self.assertEqual(release.assess_order("1" * 40, desired, "behind"), "stale")
        with self.assertRaisesRegex(release.ReleaseError, "diverges"):
            release.assess_order("1" * 40, desired, "diverged")

    def test_duplicate_source_is_not_reordered_by_time(self):
        desired = {"sourceSha": "1" * 40}
        self.assertEqual(release.assess_order("1" * 40, desired, None), "duplicate")

    def test_missing_and_corrupt_ownership_state_fail_safely(self):
        class State:
            def __init__(self, value):
                self.value = value

            def get_parameter(self, _):
                return self.value

        self.assertEqual(release.ownership_mode(State(None), self.config), "legacy")
        with self.assertRaisesRegex(release.ReleaseError, "corrupt"):
            release.ownership_mode(State({"mode": "batch"}), self.config)

    def test_corrupt_desired_state_fails_closed(self):
        with self.assertRaisesRegex(release.ReleaseError, "fields must be exactly"):
            release.validate_desired_record({"schemaVersion": 1, "sourceSha": "1" * 40})

    def test_checkpoint_missing_and_corrupt_acknowledgments_block(self):
        blockers = release.barrier_blockers(self.manifest, {"booking-ledger-backfill": None})
        self.assertIn("acknowledgment missing", blockers[0])
        blockers = release.barrier_blockers(self.manifest, {"booking-ledger-backfill": {"schemaVersion": 1}})
        self.assertTrue(any("fields are corrupt" in item for item in blockers))

    def test_evidence_bound_checkpoint_allows_release(self):
        barrier = self.manifest["barriers"][0]
        evidence = "https://github.com/vayada-marketplace/vayada/actions/runs/50001"
        ack = {
            "schemaVersion": 1,
            "barrierId": barrier["id"],
            "kind": barrier["kind"],
            "introducedAt": barrier["introducedAt"],
            "checkpointManifestId": None,
            "evidenceRequirementSha256": release.sha256_bytes(barrier["evidenceRequirement"].encode()),
            "evidence": evidence,
            "evidenceSha256": release.sha256_bytes(evidence.encode()),
            "acknowledgedAt": "2026-09-18T00:00:00Z",
            "operationId": "control-50001-1",
        }
        self.assertEqual(release.barrier_blockers(self.manifest, {barrier["id"]: ack}), [])

    def test_exact_checkpoint_manifest_can_run_before_ack(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["barriers"][0]["requiredCheckpointManifestId"] = manifest["manifestId"]
        self.assertEqual(release.barrier_blockers(manifest, {}), [])

    def test_checkpoint_obligation_survives_when_successor_omits_barrier(self):
        checkpoint = copy.deepcopy(self.manifest)
        barrier = checkpoint["barriers"][0]
        barrier["requiredCheckpointManifestId"] = checkpoint["manifestId"]
        retained = release.remaining_checkpoint_obligations([barrier], {}, {})
        self.assertEqual(retained, [barrier])

        successor = copy.deepcopy(checkpoint)
        successor["manifestId"] = "vayada-release/v1/" + "2" * 40 + "/2/1"
        successor["barriers"] = release.merge_checkpoint_barriers(retained, {**successor, "barriers": []})
        missing = release.barrier_blockers(successor, {barrier["id"]: None}, {})
        self.assertTrue(any("acknowledgment missing" in item for item in missing))

        evidence = "https://github.com/vayada-marketplace/vayada/actions/runs/50001"
        acknowledgment = {
            "schemaVersion": 1,
            "barrierId": barrier["id"],
            "kind": barrier["kind"],
            "introducedAt": barrier["introducedAt"],
            "checkpointManifestId": barrier["requiredCheckpointManifestId"],
            "evidenceRequirementSha256": release.sha256_bytes(barrier["evidenceRequirement"].encode()),
            "evidence": evidence,
            "evidenceSha256": release.sha256_bytes(evidence.encode()),
            "acknowledgedAt": "2026-09-18T00:00:00Z",
            "operationId": "control-50001-1",
        }
        missing_completion = release.barrier_blockers(
            successor, {barrier["id"]: acknowledgment}, {}
        )
        self.assertTrue(any("completion missing" in item for item in missing_completion))
        completion = {
            "schemaVersion": 1,
            "barrierId": barrier["id"],
            "checkpointManifestId": barrier["requiredCheckpointManifestId"],
            "evidenceRequirementSha256": release.sha256_bytes(barrier["evidenceRequirement"].encode()),
            "completedAt": "2026-09-18T00:01:00Z",
            "operationId": "release-50001-1",
        }
        self.assertEqual(
            release.barrier_blockers(
                successor,
                {barrier["id"]: acknowledgment},
                {barrier["id"]: completion},
            ),
            [],
        )

    def test_full_manifest_retry_and_noop_actions_use_live_state(self):
        desired = "sha256:" + "a" * 64
        self.assertEqual(
            release.planned_action(
                operation="ordinary", order="duplicate", selected=True, hold=None,
                live_digest=desired, desired_digest=desired,
            )[0],
            "verify",
        )
        self.assertEqual(
            release.planned_action(
                operation="ordinary", order="duplicate", selected=True, hold=None,
                live_digest="sha256:" + "b" * 64, desired_digest=desired,
            )[0],
            "deploy",
        )

    def test_stale_ordinary_skips_but_explicit_resume_keeps_exact_target(self):
        ordinary = release.planned_action(
            operation="ordinary", order="stale", selected=True, hold=None,
            live_digest=None, desired_digest="sha256:" + "a" * 64,
        )
        resume = release.planned_action(
            operation="resume", order="stale", selected=True,
            hold={"reason": "rollback"}, live_digest=None,
            desired_digest="sha256:" + "a" * 64,
        )
        self.assertEqual(ordinary[0], "skip")
        self.assertEqual(resume[0], "deploy")

    def test_api_hold_blocks_only_frontends_that_would_run(self):
        plan = {
            key: {"action": "deploy", "reason": "drift"}
            for key in self.config["services"]
        }
        plan["next-booking-admin"] = {"action": "held", "reason": "manual"}
        release.apply_api_hold_gate(plan, self.config, True)
        self.assertEqual(plan["next-target-backend"]["action"], "deploy")
        self.assertEqual(plan["next-booking-admin"]["action"], "held")
        self.assertTrue(all(
            value["action"] == "blocked"
            for key, value in plan.items()
            if self.config["services"][key]["phase"] == "frontend" and key != "next-booking-admin"
        ))

    def test_incompatible_api_hold_blocks_even_when_live_digest_matches(self):
        hold = {"dependentFrontendsCompatible": False}
        self.assertTrue(release.incompatible_api_hold_blocks_frontends(
            hold,
            operation="ordinary",
            selected_service=None,
            api_service="next-target-backend",
        ))
        self.assertTrue(release.incompatible_api_hold_blocks_frontends(
            hold,
            operation="resume",
            selected_service="next-booking-admin",
            api_service="next-target-backend",
        ))
        self.assertFalse(release.incompatible_api_hold_blocks_frontends(
            hold,
            operation="resume",
            selected_service="next-target-backend",
            api_service="next-target-backend",
        ))

    def test_resume_reports_unselected_services_without_changing_their_state(self):
        status = release.final_service_status(
            operation="resume", order="explicit-resume", planned="skip",
            live_matches=False, proven=False, held=True,
        )
        self.assertEqual(status, "not-selected")

    def test_interrupted_mutation_retains_a_recoverable_rollback_target(self):
        service = "next-target-backend"
        physical = self.config["services"][service]
        manifest = self.manifest
        pending = {
            "schemaVersion": 1,
            "operationId": "release-10-1",
            "service": service,
            "manifestId": manifest["manifestId"],
            "desiredDigest": manifest["services"][service]["digest"],
            "rollbackTaskDefinitionArn": (
                "arn:aws:ecs:eu-west-1:269416271598:task-definition/"
                f"{physical['taskFamily']}:4"
            ),
            "rollbackImage": (
                "269416271598.dkr.ecr.eu-west-1.amazonaws.com/"
                f"{physical['ecrRepository']}@sha256:" + "9" * 64
            ),
            "startedAt": "2026-09-18T00:00:00Z",
            "status": "mutating",
        }
        self.assertIs(
            release.recoverable_pending_operation(pending, self.config, service, manifest),
            pending,
        )
        pending["status"] = "succeeded"
        self.assertIsNone(release.recoverable_pending_operation(pending, self.config, service, manifest))


class PhysicalIdentityTests(unittest.TestCase):
    def setUp(self):
        self.config = release.load_config()

    class Runner:
        def __init__(self, config, *, bad_service=False, bad_image=False, missing_source_tag=False):
            self.config = config
            self.bad_service = bad_service
            self.bad_image = bad_image
            self.missing_source_tag = missing_source_tag
            self.registered = None

        def run(self, *args, input_value=None):
            operation = args[2]
            physical = self.config["services"]["next-target-backend"]
            deployment = self.config["deployment"]
            digest = "sha256:" + "a" * 64
            if operation == "describe-services":
                name = "wrong-service" if self.bad_service else physical["ecsService"]
                return json.dumps({
                    "services": [{
                        "serviceArn": f"arn:aws:ecs:{deployment['region']}:{deployment['accountId']}:service/{deployment['cluster']}/{name}",
                        "taskDefinition": f"arn:aws:ecs:{deployment['region']}:{deployment['accountId']}:task-definition/{physical['taskFamily']}:7",
                    }],
                    "failures": [],
                })
            if operation == "describe-task-definition":
                repository = physical["ecrRepository"] + ("-evil" if self.bad_image else "")
                return json.dumps({"taskDefinition": {
                    "taskDefinitionArn": f"arn:aws:ecs:{deployment['region']}:{deployment['accountId']}:task-definition/{physical['taskFamily']}:7",
                    "family": physical["taskFamily"],
                    "revision": 7,
                    "status": "ACTIVE",
                    "networkMode": "awsvpc",
                    "executionRoleArn": "arn:aws:iam::269416271598:role/ecsTaskExecutionRole",
                    "containerDefinitions": [{
                        "name": physical["containerName"],
                        "image": f"269416271598.dkr.ecr.eu-west-1.amazonaws.com/{repository}@{digest}",
                    }],
                }})
            if operation == "describe-images":
                tags = [] if self.missing_source_tag else [f"next-{'1' * 40}"]
                return json.dumps({"imageDetails": [{"imageDigest": digest, "imageTags": tags}]})
            if operation == "register-task-definition":
                file_arg = next(item for item in args if item.startswith("file://"))
                self.registered = json.loads(Path(file_arg[7:]).read_text())
                return json.dumps({"taskDefinition": {"taskDefinitionArn": f"arn:aws:ecs:{deployment['region']}:{deployment['accountId']}:task-definition/{physical['taskFamily']}:8"}})
            raise AssertionError(args)

    def test_live_service_must_match_fixed_physical_arn(self):
        aws = release.Aws(self.Runner(self.config, bad_service=True), self.config)
        with self.assertRaisesRegex(release.ReleaseError, "Physical ECS identity"):
            aws.service_snapshot("next-target-backend")

    def test_prefix_confusable_ecr_repository_is_rejected(self):
        aws = release.Aws(self.Runner(self.config, bad_image=True), self.config)
        with self.assertRaisesRegex(release.ReleaseError, "exact configured ECR repository"):
            aws.service_snapshot("next-target-backend")

    def test_malformed_api_smoke_response_is_a_release_failure(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _):
                return b"[]"

        with mock.patch.object(release.urllib.request, "urlopen", return_value=Response()):
            with self.assertRaisesRegex(release.ReleaseError, "status=ok"):
                release.smoke_service(
                    release.CommandRunner(), self.config, "next-target-backend", "1" * 40
                )

    def test_ecr_digest_must_carry_declared_source_tag(self):
        aws = release.Aws(self.Runner(self.config, missing_source_tag=True), self.config)
        with self.assertRaisesRegex(release.ReleaseError, "next-"):
            aws.verify_image("next-target-backend", {
                "ecrRepository": "vayada-next-api",
                "digest": "sha256:" + "a" * 64,
                "imageSourceSha": "1" * 40,
            })

    def test_preparation_tag_binds_the_same_exact_source_and_digest(self):
        image = {"ecrRepository": "vayada-next-api", "digest": "sha256:" + "a" * 64,
                 "imageSourceSha": "1" * 40}
        aws = release.Aws(self.Runner(self.config), self.config)
        for source in ("1" * 40, "2" * 40):
            with mock.patch.object(aws, "json", return_value={"imageDetails": [{
                "imageDigest": image["digest"], "imageTags": ["next-prepare-" + source]}]}):
                if source == image["imageSourceSha"]:
                    aws.verify_image("next-target-backend", image)
                else:
                    with self.assertRaises(release.ReleaseError):
                        aws.verify_image("next-target-backend", image)

    def test_task_render_changes_only_allowlisted_container_image(self):
        runner = self.Runner(self.config)
        aws = release.Aws(runner, self.config)
        snapshot = aws.service_snapshot("next-target-backend")
        arn = aws.register_rendered_task("next-target-backend", snapshot, "sha256:" + "b" * 64)
        self.assertTrue(arn.endswith(":8"))
        self.assertNotIn("taskDefinitionArn", runner.registered)
        self.assertEqual(runner.registered["networkMode"], "awsvpc")
        self.assertTrue(runner.registered["containerDefinitions"][0]["image"].endswith("@sha256:" + "b" * 64))

    def test_api_split_guard_uses_real_attestations(self):
        attested = next(line.split()[1] for line in
                        (ROOT / "scripts/next-api-split-compatible-images.txt").read_text().splitlines()
                        if line.strip() and not line.startswith("#"))
        aws = release.Aws(release.CommandRunner(), self.config)
        for digest, allowed in ((attested, True), ("sha256:" + "a" * 64, False)):
            with mock.patch.object(aws, "json", return_value={"imageDetails": [{"imageDigest": digest}]}):
                if allowed:
                    aws.verify_api_split_image("next-target-backend", digest)
                else:
                    with self.assertRaisesRegex(release.ReleaseError, "no reviewed immutable"):
                        aws.verify_api_split_image("next-target-backend", digest)
        with mock.patch.object(aws, "json") as ecr:
            aws.verify_api_split_image("next-booking-admin", "not-an-api-digest")
            ecr.assert_not_called()


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.config = release.load_config()
        self.key = "next-booking-admin"
        self.manifest = release.read_json(ROOT / "deployment/contract/fixtures/manifest-v1.valid.json")
        self.snapshot = {"digest": "sha256:" + "a" * 64, "taskDefinitionArn": "live-task"}
        self.aws = mock.Mock()
        self.aws.get_parameter.return_value = None
        self.aws.json.return_value = {"imageDetails": [{"imageDigest": self.snapshot["digest"],
            "imageTags": ["next-" + "1" * 40]}]}
        self.github = mock.Mock()
        self.run = {"head_sha": "1" * 40, "head_branch": "main", "event": "push",
            "status": "completed", "conclusion": "success", "id": 42, "run_attempt": 1,
            "path": ".github/workflows/deploy-next-booking-admin.yml",
            "repository": {"full_name": "vayada-marketplace/vayada"},
            "head_repository": {"full_name": "vayada-marketplace/vayada"}}
        self.github.json.return_value = {"workflow_runs": [self.run]}
        self.github.compare.return_value = "ahead"

    def bootstrap(self):
        return release.bootstrap_evidence(self.aws, self.github, self.config, self.key, self.snapshot, self.manifest)

    def test_bootstrap_binds_live_digest_to_trusted_build(self):
        proof = self.bootstrap()
        self.assertEqual(proof["evidence"]["buildRunId"], 42)
        self.assertEqual(proof["digest"], self.snapshot["digest"])
        self.github.compare.assert_called_once_with("1" * 40, self.manifest["source"]["sha"])
        self.aws.put_parameter.assert_not_called()

    def test_bootstrap_rejects_unknown_mutable_manual_or_newer_source(self):
        self.snapshot["digest"] = None
        with self.assertRaises(release.ReleaseError):
            self.bootstrap()
        self.snapshot["digest"] = "sha256:" + "a" * 64
        for event in ("workflow_dispatch", "pull_request"):
            self.run["event"] = event
            with self.assertRaisesRegex(release.ReleaseError, "trusted automatic"):
                self.bootstrap()
        self.run["event"] = "push"
        for order in ("behind", "diverged"):
            self.github.compare.return_value = order
            with self.assertRaisesRegex(release.ReleaseError, "regress or diverge"):
                self.bootstrap()
        self.aws.json.return_value["imageDetails"][0]["imageTags"] = ["next-latest"]
        with self.assertRaisesRegex(release.ReleaseError, "unknown or ambiguous"):
            self.bootstrap()

    def test_frontend_resume_checks_exact_api_and_requests_fresh_smoke(self):
        api = {"action": "skip", "observedDigest": "old", "desiredDigest": "new"}
        with self.assertRaisesRegex(release.ReleaseError, "API digest"):
            release.require_resume_api_readiness(api, False)
        api["observedDigest"] = "new"
        with self.assertRaisesRegex(release.ReleaseError, "API digest"):
            release.require_resume_api_readiness(api, True)
        release.require_resume_api_readiness(api, False)
        self.assertEqual(api["action"], "verify")

    def test_frontend_resume_verifies_api_without_clearing_its_hold(self):
        api = "next-target-backend"
        fixture = ROOT / "deployment/contract/fixtures/manifest-v1.valid.json"
        digest = self.manifest["services"][api]["digest"]
        plan = {"schemaVersion": 1, "manifestId": self.manifest["manifestId"],
                "manifestSha256": release.sha256_file(fixture), "operation": "resume",
                "resumeService": self.key, "operationId": "resume-42",
                "services": {api: {"action": "verify"}}}
        snapshot = {"digest": digest, "taskDefinitionArn": "api-task", "image": "api-image",
                    "serviceArn": "api-service"}
        self.aws.service_snapshot.return_value = snapshot
        for api_hold in (None, {"status": "active", "dependentFrontendsCompatible": True}):
            self.aws.get_parameter.side_effect = lambda name: api_hold if name.endswith("/hold") else None
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "plan.json"
                path.write_text(json.dumps(plan))
                args = argparse.Namespace(config=release.DEFAULT_CONFIG, manifest=fixture, plan=path, service=api)
                with mock.patch.object(release, "Aws", return_value=self.aws), \
                     mock.patch.object(release, "smoke_service") as smoke, \
                     mock.patch.object(release, "clear_hold") as clear:
                    release.reconcile_service(args)
                    smoke.assert_called_once()
                    clear.assert_not_called()
                    self.aws.update_service.assert_not_called()

    def test_api_guard_rejection_prevents_all_mutation_including_resume_and_recovery(self):
        key = "next-target-backend"
        fixture = ROOT / "deployment/contract/fixtures/manifest-v1.valid.json"
        desired = self.manifest["services"][key]["digest"]
        previous = "sha256:" + "9" * 64
        plan = {"schemaVersion": 1, "manifestId": self.manifest["manifestId"],
                "manifestSha256": release.sha256_file(fixture), "operation": "resume",
                "resumeService": key, "operationId": "resume-42",
                "services": {key: {"action": "deploy"}}}
        for recovering, reject_desired in ((False, True), (False, False), (True, False)):
            with self.subTest(recovering=recovering, reject_desired=reject_desired):
                aws = mock.Mock()
                aws.service_snapshot.return_value = {
                    "digest": desired if recovering else previous,
                    "taskDefinitionArn": "live-task", "image": "repository@" + previous}
                pending = {"rollbackTaskDefinitionArn": "previous-task", "rollbackImage": "repository@" + previous} if recovering else None
                aws.verify_api_split_image.side_effect = release.ReleaseError("unattested") if reject_desired else [None, release.ReleaseError("unattested rollback")]
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "plan.json"
                    path.write_text(json.dumps(plan))
                    args = argparse.Namespace(config=release.DEFAULT_CONFIG, manifest=fixture, plan=path, service=key)
                    with mock.patch.object(release, "Aws", return_value=aws), \
                         mock.patch.object(release, "recoverable_pending_operation", return_value=pending), \
                         mock.patch.object(release, "clear_hold") as clear:
                        with self.assertRaisesRegex(release.ReleaseError, "unattested"):
                            release.reconcile_service(args)
                        aws.verify_api_split_image.assert_has_calls(
                            [mock.call(key, desired)] if reject_desired else [mock.call(key, desired), mock.call(key, previous)])
                        aws.put_parameter.assert_not_called()
                        aws.register_rendered_task.assert_not_called()
                        aws.update_service.assert_not_called()
                        clear.assert_not_called()

    def test_legacy_stale_events_remain_fenced_after_system_rollback(self):
        args = argparse.Namespace(config=release.DEFAULT_CONFIG, service=self.key, event_name="repository_dispatch")
        def state(name):
            if name.endswith("ownership-mode"):
                return {"schemaVersion": 1, "mode": "legacy", "changedAt": "2026-09-20T00:00:00Z", "operationId": "rollback-1"}
            return {"manifestId": "retained-release"}
        self.aws.get_parameter.side_effect = state
        with mock.patch.object(release, "Aws", return_value=self.aws):
            with self.assertRaisesRegex(release.ReleaseError, "remains fenced"):
                release.guard_legacy(args)
        self.aws.update_service.assert_not_called()

    def test_legacy_before_first_activation_still_works(self):
        args = argparse.Namespace(config=release.DEFAULT_CONFIG, service=self.key, event_name="repository_dispatch")
        with mock.patch.object(release, "Aws", return_value=self.aws):
            release.guard_legacy(args)
        self.aws.update_service.assert_not_called()


class WorkflowContractTests(unittest.TestCase):
    def test_batch_lock_api_gate_parallel_frontends_and_independent_failures(self):
        workflow = (ROOT / ".github" / "workflows" / "deploy-coordinated-release.yml").read_text()
        self.assertIn("group: production-ecs-mutations", workflow)
        self.assertIn("needs: [prepare, api]", workflow)
        self.assertIn("if: needs.api.result == 'success'", workflow)
        self.assertIn("fail-fast: false", workflow)
        self.assertIn("NEXT_BOOKING_CANARY_URL: ${{ vars.NEXT_BOOKING_CANARY_URL }}", workflow)
        self.assertIn("NEXT_BOOKING_CANARY_NAME: ${{ vars.NEXT_BOOKING_CANARY_NAME }}", workflow)
        for service in release.load_config()["services"]:
            self.assertIn(service, workflow)

    def test_legacy_and_manual_paths_are_guarded_without_touching_canary(self):
        workflow = (ROOT / ".github" / "workflows" / "deploy.yml").read_text()
        self.assertIn("guard-legacy", workflow)
        self.assertIn("hold-before-rollback", workflow)
        self.assertIn('next-target-backend) expected_repository="vayada-next-api"', workflow)
        self.assertIn("vay1480-staging-canary", workflow)
        self.assertIn("'production-ecs-mutations'", workflow)

    def test_terraform_shares_lock_and_cannot_manage_runtime_records(self):
        terraform_workflow = (ROOT / ".github" / "workflows" / "tf-apply.yml").read_text()
        iam = (ROOT / "infra" / "coordinated_deployments.tf").read_text()
        roll_forward = (ROOT / "scripts" / "roll-forward-auth-gateways.sh").read_text()
        self.assertIn("group: production-ecs-mutations", terraform_workflow)
        self.assertIn("hold-before-rollback", roll_forward)
        self.assertIn("parameter/vayada/prod/coordinated-deployments/v1/*", iam)
        self.assertNotIn("ssm:DeleteParameter", iam)
        self.assertNotIn('resource "aws_ssm_parameter"', iam)

    def test_control_workflow_does_not_resume_without_exact_release_workflow(self):
        control = (ROOT / ".github" / "workflows" / "manage-coordinated-release.yml").read_text()
        deployment = (ROOT / ".github" / "workflows" / "deploy-coordinated-release.yml").read_text()
        self.assertIn("options: [hold, acknowledge, set-legacy-mode]", control)
        self.assertIn("options: [ordinary, resume, activate, verify]", deployment)
        self.assertIn("needs.prepare.result == 'success' && inputs.operation != 'verify'", deployment)
        self.assertIn("published_record_sha256", deployment)


if __name__ == "__main__":
    unittest.main()
