#!/usr/bin/env python3
"""Validate and reconcile coordinated next-stack release manifests.

The module intentionally uses only the Python standard library and the AWS CLI.
Pure validation/planning helpers are kept separate from the command adapters so
the trust and recovery rules can be regression-tested without AWS credentials.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "deployment" / "coordinated-release-v1.json"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
SAFE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
IMAGE_TAG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
TASK_DEFINITION_READ_ONLY_FIELDS = {
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
}
BARRIER_FIELDS = {
    "id",
    "kind",
    "introducedAt",
    "requiredCheckpointManifestId",
    "evidenceRequirement",
}


class ReleaseError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ReleaseError(message)


def read_json(path: str | Path) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"Cannot read JSON {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"Expected a JSON object in {path}")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: str | Path) -> str:
    try:
        return sha256_bytes(Path(path).read_bytes())
    except OSError as exc:
        fail(f"Cannot hash {path}: {exc}")


def parse_time(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str):
        fail(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{field} must be an ISO-8601 timestamp")
    if parsed.tzinfo is None:
        fail(f"{field} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def exact_keys(value: Any, expected: set[str], field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{field} must be an object")
    actual = set(value)
    if actual != expected:
        fail(f"{field} fields must be exactly {sorted(expected)}; got {sorted(actual)}")
    return value


def positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        fail(f"{field} must be a positive integer")
    return value


def require_sha(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        fail(f"{field} must be a lowercase 40-character git SHA")
    return value


def require_digest(value: Any, field: str) -> str:
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        fail(f"{field} must be an immutable sha256 digest")
    return value


def require_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        fail(f"{field} contains unsupported characters or length")
    return value


def validate_ecr_image_reference(value: Any, repository_uri: str, field: str) -> str | None:
    if not isinstance(value, str):
        fail(f"{field} must be an image in the configured ECR repository")
    if value.startswith(repository_uri + "@"):
        digest = value[len(repository_uri) + 1 :]
        return require_digest(digest, field)
    if value.startswith(repository_uri + ":"):
        tag = value[len(repository_uri) + 1 :]
        if IMAGE_TAG_RE.fullmatch(tag):
            return None
    fail(f"{field} must use the exact configured ECR repository")


def validate_barrier_definition(barrier: Any, field: str) -> str:
    barrier = exact_keys(barrier, BARRIER_FIELDS, field)
    barrier_id = barrier["id"]
    if not isinstance(barrier_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", barrier_id):
        fail(f"{field}.id is invalid")
    if barrier["kind"] not in {"migration", "backfill", "application"}:
        fail(f"{field}.kind is unknown")
    require_sha(barrier["introducedAt"], f"{field}.introducedAt")
    checkpoint = barrier["requiredCheckpointManifestId"]
    if checkpoint is not None and not re.fullmatch(
        r"vayada-release/v1/[0-9a-f]{40}/[1-9][0-9]*/[1-9][0-9]*", checkpoint
    ):
        fail(f"{field}.requiredCheckpointManifestId is invalid")
    if not isinstance(barrier["evidenceRequirement"], str) or not barrier["evidenceRequirement"].strip():
        fail(f"{field}.evidenceRequirement must be non-empty")
    return barrier_id


def load_config(path: str | Path = DEFAULT_CONFIG) -> dict[str, Any]:
    config = read_json(path)
    exact_keys(config, {"schemaVersion", "producer", "deployment", "services"}, "config")
    if config["schemaVersion"] != 1:
        fail("Only coordinated deployment config schemaVersion 1 is supported")
    producer = exact_keys(
        config["producer"],
        {
            "repository",
            "branch",
            "buildWorkflowName",
            "buildWorkflowPath",
            "publisherWorkflowName",
            "publisherWorkflowPath",
            "artifactNamePrefix",
            "minimumRetentionDays",
        },
        "config.producer",
    )
    deployment = exact_keys(
        config["deployment"], {"accountId", "region", "cluster", "statePrefix"}, "config.deployment"
    )
    if producer["repository"] != "vayada-marketplace/vayada" or producer["branch"] != "main":
        fail("Producer repository and branch are immutable in v1")
    if not re.fullmatch(r"[0-9]{12}", str(deployment["accountId"])):
        fail("Deployment accountId must be a 12-digit AWS account")
    if not isinstance(config["services"], dict) or len(config["services"]) != 6:
        fail("The v1 physical map must contain exactly six services")
    phases = []
    for key, service in config["services"].items():
        if not SAFE_COMPONENT_RE.fullmatch(key):
            fail(f"Invalid configured service key {key!r}")
        exact_keys(
            service,
            {"phase", "ecrRepository", "ecsService", "taskFamily", "containerName", "smoke"},
            f"config.services.{key}",
        )
        if service["phase"] not in {"api", "frontend"}:
            fail(f"Unsupported phase for {key}")
        phases.append(service["phase"])
        for field in ("ecrRepository", "ecsService", "taskFamily", "containerName"):
            if not SAFE_COMPONENT_RE.fullmatch(service[field]):
                fail(f"Invalid {field} for {key}")
    if phases.count("api") != 1 or phases.count("frontend") != 5:
        fail("The v1 physical map must contain one API and five frontends")
    return config


def validate_manifest(manifest: dict[str, Any], config: dict[str, Any]) -> None:
    exact_keys(
        manifest,
        {
            "schemaVersion",
            "manifestId",
            "repository",
            "source",
            "build",
            "previousManifestId",
            "previousSourceSha",
            "compatibility",
            "barriers",
            "services",
        },
        "manifest",
    )
    if manifest["schemaVersion"] != 1:
        fail("Only manifest schemaVersion 1 is supported")
    producer = config["producer"]
    if manifest["repository"] != producer["repository"]:
        fail("Manifest repository is not trusted")
    source = exact_keys(manifest["source"], {"sha", "branch"}, "manifest.source")
    source_sha = require_sha(source["sha"], "manifest.source.sha")
    if source["branch"] != producer["branch"]:
        fail("Manifest source branch is not trusted")
    build = exact_keys(
        manifest["build"],
        {"workflowName", "workflowPath", "runId", "runAttempt", "event"},
        "manifest.build",
    )
    if build["workflowName"] != producer["buildWorkflowName"]:
        fail("Manifest build workflow name is not trusted")
    if build["workflowPath"] != producer["buildWorkflowPath"]:
        fail("Manifest build workflow path is not trusted")
    positive_int(build["runId"], "manifest.build.runId")
    positive_int(build["runAttempt"], "manifest.build.runAttempt")
    if build["event"] not in {"push", "workflow_dispatch"}:
        fail("Manifest build event is not trusted")
    expected_id = f"vayada-release/v1/{source_sha}/{build['runId']}/{build['runAttempt']}"
    if manifest["manifestId"] != expected_id:
        fail("manifestId does not bind source SHA and exact build run attempt")
    previous_id = manifest["previousManifestId"]
    previous_sha = manifest["previousSourceSha"]
    if (previous_id is None) != (previous_sha is None):
        fail("Previous manifest ID and source SHA must both be present or both be null")
    if previous_id is not None:
        if not re.fullmatch(r"vayada-release/v1/[0-9a-f]{40}/[1-9][0-9]*/[1-9][0-9]*", previous_id):
            fail("manifest.previousManifestId is invalid")
        require_sha(previous_sha, "manifest.previousSourceSha")
        if previous_sha == source_sha:
            fail("Previous source SHA must differ from the current source SHA")
    compatibility = exact_keys(
        manifest["compatibility"],
        {"mode", "apiBackwardCompatible", "frontendBackwardCompatible"},
        "manifest.compatibility",
    )
    if compatibility != {
        "mode": "ordinary",
        "apiBackwardCompatible": True,
        "frontendBackwardCompatible": True,
    }:
        fail("v1 accepts only ordinary releases with bidirectional API/frontend overlap")
    if not isinstance(manifest["barriers"], list):
        fail("manifest.barriers must be an array")
    barrier_ids: set[str] = set()
    for index, barrier in enumerate(manifest["barriers"]):
        field = f"manifest.barriers[{index}]"
        barrier_id = validate_barrier_definition(barrier, field)
        if barrier_id in barrier_ids:
            fail(f"{field}.id must be unique and safe as one state path component")
        barrier_ids.add(barrier_id)
    services = manifest["services"]
    if not isinstance(services, dict) or set(services) != set(config["services"]):
        fail("Manifest services must exactly match the six configured service keys")
    for key, image in services.items():
        exact_keys(image, {"ecrRepository", "digest", "imageSourceSha"}, f"manifest.services.{key}")
        expected_repo = config["services"][key]["ecrRepository"]
        if image["ecrRepository"] != expected_repo:
            fail(f"Manifest repository for {key} must be {expected_repo}")
        require_digest(image["digest"], f"manifest.services.{key}.digest")
        require_sha(image["imageSourceSha"], f"manifest.services.{key}.imageSourceSha")


def validate_published_record(record: dict[str, Any], manifest: dict[str, Any], config: dict[str, Any]) -> None:
    exact_keys(
        record,
        {
            "schemaVersion",
            "manifestId",
            "manifestSha256",
            "candidateArtifactId",
            "candidateArtifactName",
            "producer",
            "publisher",
            "publishedArtifactName",
            "publishedAt",
            "expiresAt",
            "retentionDays",
            "idempotencyKey",
        },
        "publishedRecord",
    )
    if record["schemaVersion"] != 1:
        fail("Only published record schemaVersion 1 is supported")
    if record["manifestId"] != manifest["manifestId"] or record["idempotencyKey"] != manifest["manifestId"]:
        fail("Published record does not bind the manifest identity")
    producer = exact_keys(
        record["producer"],
        {"repository", "workflowName", "workflowPath", "runId", "runAttempt"},
        "publishedRecord.producer",
    )
    publisher = exact_keys(
        record["publisher"],
        {"repository", "workflowName", "workflowPath", "runId", "runAttempt"},
        "publishedRecord.publisher",
    )
    expected_producer = {
        "repository": manifest["repository"],
        "workflowName": manifest["build"]["workflowName"],
        "workflowPath": manifest["build"]["workflowPath"],
        "runId": manifest["build"]["runId"],
        "runAttempt": manifest["build"]["runAttempt"],
    }
    if producer != expected_producer:
        fail("Published record producer does not bind the manifest build")
    if publisher["repository"] != config["producer"]["repository"]:
        fail("Published record publisher repository is not trusted")
    if publisher["workflowName"] != config["producer"]["publisherWorkflowName"]:
        fail("Published record publisher workflow name is not trusted")
    if publisher["workflowPath"] != config["producer"]["publisherWorkflowPath"]:
        fail("Published record publisher workflow path is not trusted")
    for field in ("candidateArtifactId", "retentionDays"):
        positive_int(record[field], f"publishedRecord.{field}")
    for field in ("runId", "runAttempt"):
        positive_int(publisher[field], f"publishedRecord.publisher.{field}")
    expected_candidate_name = f"next-release-candidate-v1-{manifest['build']['runId']}-{manifest['build']['runAttempt']}"
    if record["candidateArtifactName"] != expected_candidate_name:
        fail("Published record candidate artifact name does not bind the build attempt")
    expected_published_name = (
        f"next-release-published-v1-{manifest['source']['sha']}-"
        f"{manifest['build']['runId']}-{manifest['build']['runAttempt']}"
    )
    if record["publishedArtifactName"] != expected_published_name:
        fail("Published artifact name does not bind the manifest source/build")
    if not re.fullmatch(r"[0-9a-f]{64}", str(record["manifestSha256"])):
        fail("publishedRecord.manifestSha256 is invalid")
    published = parse_time(record["publishedAt"], "publishedRecord.publishedAt")
    expires = parse_time(record["expiresAt"], "publishedRecord.expiresAt")
    if record["retentionDays"] != config["producer"]["minimumRetentionDays"]:
        fail("Published release retention does not match the frozen v1 contract")
    if expires <= published:
        fail("Published record expiration must be after publication")


def validate_dispatch(dispatch: dict[str, Any], manifest: dict[str, Any], record: dict[str, Any]) -> None:
    exact_keys(
        dispatch,
        {
            "schemaVersion",
            "manifestId",
            "manifestSha256",
            "publishedRecordSha256",
            "sourceSha",
            "repository",
            "workflowName",
            "workflowPath",
            "runId",
            "runAttempt",
            "publishedArtifactId",
            "publishedArtifactName",
            "publisherRunId",
            "publisherRunAttempt",
            "idempotencyKey",
        },
        "dispatch",
    )
    build = manifest["build"]
    expected = {
        "schemaVersion": 1,
        "manifestId": manifest["manifestId"],
        "manifestSha256": record["manifestSha256"],
        "sourceSha": manifest["source"]["sha"],
        "repository": manifest["repository"],
        "workflowName": build["workflowName"],
        "workflowPath": build["workflowPath"],
        "runId": build["runId"],
        "runAttempt": build["runAttempt"],
        "publishedArtifactName": record["publishedArtifactName"],
        "publisherRunId": record["publisher"]["runId"],
        "publisherRunAttempt": record["publisher"]["runAttempt"],
        "idempotencyKey": manifest["manifestId"],
    }
    for field, value in expected.items():
        if dispatch.get(field) != value:
            fail(f"Dispatch {field} does not match the immutable published record")
    positive_int(dispatch["publishedArtifactId"], "dispatch.publishedArtifactId")
    for field in ("manifestSha256", "publishedRecordSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(dispatch[field])):
            fail(f"dispatch.{field} is invalid")


def validate_run(
    run: dict[str, Any], *, workflow_path: str, sha: str, branch: str, run_id: int, attempt: int, event: str
) -> None:
    if run.get("id") != run_id or run.get("run_attempt") != attempt:
        fail("GitHub run metadata does not match the exact run attempt")
    if run.get("path") != workflow_path:
        fail("GitHub run workflow path is not trusted")
    if run.get("head_sha") != sha or run.get("head_branch") != branch:
        fail("GitHub run source does not match the trusted manifest source")
    if run.get("event") != event:
        fail("GitHub run event does not match the manifest")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        fail("GitHub source run is not successfully completed")


def validate_publisher_run(
    run: dict[str, Any], *, repository: str, workflow_path: str, branch: str, run_id: int, attempt: int
) -> None:
    if run.get("id") != run_id or run.get("run_attempt") != attempt:
        fail("GitHub publisher metadata does not match the exact run attempt")
    if (run.get("repository") or {}).get("full_name") != repository:
        fail("GitHub publisher repository is not trusted")
    if (run.get("head_repository") or {}).get("full_name") != repository:
        fail("GitHub publisher head repository is not trusted")
    if run.get("path") != workflow_path or run.get("head_branch") != branch:
        fail("GitHub publisher workflow or branch is not trusted")
    require_sha(run.get("head_sha"), "publisherRun.head_sha")
    if run.get("event") != "workflow_run":
        fail("GitHub publisher event is not trusted")
    lifecycle = (run.get("status"), run.get("conclusion"))
    if lifecycle not in {("in_progress", None), ("completed", "success"), ("completed", "failure")}:
        fail("GitHub publisher run lifecycle is not trusted")


def validate_publication(
    *,
    manifest_path: Path,
    record_path: Path,
    dispatch: dict[str, Any],
    artifact: dict[str, Any],
    build_run: dict[str, Any],
    publisher_run: dict[str, Any],
    config: dict[str, Any],
    now: dt.datetime | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = read_json(manifest_path)
    record = read_json(record_path)
    validate_manifest(manifest, config)
    validate_published_record(record, manifest, config)
    validate_dispatch(dispatch, manifest, record)
    manifest_hash = sha256_file(manifest_path)
    record_hash = sha256_file(record_path)
    if manifest_hash != dispatch["manifestSha256"] or manifest_hash != record["manifestSha256"]:
        fail("Manifest bytes do not match the published SHA-256")
    if record_hash != dispatch["publishedRecordSha256"]:
        fail("Published record bytes do not match the dispatch SHA-256")
    if artifact.get("id") != dispatch["publishedArtifactId"]:
        fail("Artifact metadata ID does not match dispatch")
    if artifact.get("name") != record["publishedArtifactName"]:
        fail("Artifact name does not match the published record")
    if artifact.get("expired") is not False:
        fail("Published release artifact is expired or unavailable")
    artifact_created = parse_time(artifact.get("created_at"), "artifact.created_at")
    artifact_expires = parse_time(artifact.get("expires_at"), "artifact.expires_at")
    record_published = parse_time(record["publishedAt"], "publishedRecord.publishedAt")
    record_expires = parse_time(record["expiresAt"], "publishedRecord.expiresAt")
    if abs((artifact_created - record_published).total_seconds()) > 3600:
        fail("Published artifact creation time does not match the record")
    if artifact_expires < record_expires:
        fail("Published artifact retention is shorter than the record")
    workflow_run = artifact.get("workflow_run") or {}
    if workflow_run.get("id") != record["publisher"]["runId"]:
        fail("Published artifact is not owned by the recorded publisher run")
    source = manifest["source"]
    build = manifest["build"]
    validate_run(
        build_run,
        workflow_path=build["workflowPath"],
        sha=source["sha"],
        branch=source["branch"],
        run_id=build["runId"],
        attempt=build["runAttempt"],
        event=build["event"],
    )
    validate_publisher_run(
        publisher_run,
        repository=manifest["repository"],
        workflow_path=record["publisher"]["workflowPath"],
        branch=source["branch"],
        run_id=record["publisher"]["runId"],
        attempt=record["publisher"]["runAttempt"],
    )
    current = now or dt.datetime.now(dt.timezone.utc)
    if record_published > current + dt.timedelta(minutes=5):
        fail("Published release record is dated in the future")
    if record_expires <= current:
        fail("Published release record has expired")
    return manifest, record


def assess_order(current_sha: str, desired: dict[str, Any] | None, compare_status: str | None) -> str:
    if desired is None:
        return "new"
    desired_sha = desired.get("sourceSha")
    if desired_sha == current_sha:
        return "duplicate"
    if compare_status == "ahead":
        return "new"
    if compare_status == "behind":
        return "stale"
    if compare_status == "identical":
        return "duplicate"
    fail("Release source history diverges from the accepted desired release")


def validate_checkpoint_obligations(value: dict[str, Any] | None) -> list[dict[str, Any]]:
    if value is None:
        return []
    exact_keys(
        value,
        {"schemaVersion", "barriers", "updatedAt", "operationId"},
        "checkpoint-obligations",
    )
    if value["schemaVersion"] != 1 or not isinstance(value["barriers"], list):
        fail("checkpoint-obligations state is corrupt")
    parse_time(value["updatedAt"], "checkpoint-obligations.updatedAt")
    require_id(value["operationId"], "checkpoint-obligations.operationId")
    seen: set[str] = set()
    for index, barrier in enumerate(value["barriers"]):
        barrier_id = validate_barrier_definition(barrier, f"checkpoint-obligations.barriers[{index}]")
        if barrier_id in seen:
            fail("checkpoint-obligations contains duplicate barrier IDs")
        seen.add(barrier_id)
    return value["barriers"]


def merge_checkpoint_barriers(
    retained: list[dict[str, Any]], manifest: dict[str, Any]
) -> list[dict[str, Any]]:
    merged = {barrier["id"]: barrier for barrier in retained}
    for barrier in manifest["barriers"]:
        previous = merged.get(barrier["id"])
        if previous is not None and previous != barrier:
            fail(f"Barrier {barrier['id']} conflicts with its durable checkpoint obligation")
        merged[barrier["id"]] = barrier
    return list(merged.values())


def incompatible_api_hold_blocks_frontends(
    hold: dict[str, Any] | None, *, operation: str, selected_service: str | None, api_service: str
) -> bool:
    return bool(
        hold
        and not (operation == "resume" and selected_service == api_service)
        and not hold.get("dependentFrontendsCompatible")
    )


def barrier_blockers(
    manifest: dict[str, Any],
    acknowledgments: dict[str, dict[str, Any] | None],
    completions: dict[str, dict[str, Any] | None] | None = None,
) -> list[str]:
    blockers = []
    completions = completions or {}
    for barrier in manifest["barriers"]:
        checkpoint = barrier["requiredCheckpointManifestId"]
        if checkpoint == manifest["manifestId"]:
            continue
        ack = acknowledgments.get(barrier["id"])
        requirement_hash = sha256_bytes(barrier["evidenceRequirement"].encode())
        if not ack:
            blockers.append(f"{barrier['id']}: acknowledgment missing")
            continue
        expected_fields = {
            "schemaVersion",
            "barrierId",
            "kind",
            "introducedAt",
            "checkpointManifestId",
            "evidenceRequirementSha256",
            "evidence",
            "evidenceSha256",
            "acknowledgedAt",
            "operationId",
        }
        if set(ack) != expected_fields:
            blockers.append(f"{barrier['id']}: acknowledgment fields are corrupt")
            continue
        expected = {
            "schemaVersion": 1,
            "barrierId": barrier["id"],
            "kind": barrier["kind"],
            "introducedAt": barrier["introducedAt"],
            "checkpointManifestId": checkpoint,
            "evidenceRequirementSha256": requirement_hash,
        }
        if any(ack.get(key) != value for key, value in expected.items()):
            blockers.append(f"{barrier['id']}: acknowledgment does not bind the required checkpoint/evidence")
        evidence = ack.get("evidence")
        if not isinstance(evidence, str) or not evidence.strip() or ack.get("evidenceSha256") != sha256_bytes(evidence.encode()):
            blockers.append(f"{barrier['id']}: acknowledgment evidence is missing or corrupt")
        try:
            parse_time(ack.get("acknowledgedAt"), f"acknowledgment.{barrier['id']}.acknowledgedAt")
            require_id(ack.get("operationId"), f"acknowledgment.{barrier['id']}.operationId")
        except ReleaseError as exc:
            blockers.append(f"{barrier['id']}: {exc}")
        if checkpoint is not None:
            completion = completions.get(barrier["id"])
            expected_completion = {
                "schemaVersion": 1,
                "barrierId": barrier["id"],
                "checkpointManifestId": checkpoint,
                "evidenceRequirementSha256": requirement_hash,
            }
            if not completion:
                blockers.append(f"{barrier['id']}: checkpoint deployment completion missing")
            elif set(completion) != {
                "schemaVersion",
                "barrierId",
                "checkpointManifestId",
                "evidenceRequirementSha256",
                "completedAt",
                "operationId",
            }:
                blockers.append(f"{barrier['id']}: checkpoint deployment completion is corrupt")
            elif any(completion.get(key) != value for key, value in expected_completion.items()):
                blockers.append(f"{barrier['id']}: checkpoint deployment completion does not bind the barrier")
            else:
                try:
                    parse_time(completion.get("completedAt"), f"completion.{barrier['id']}.completedAt")
                    require_id(completion.get("operationId"), f"completion.{barrier['id']}.operationId")
                except ReleaseError as exc:
                    blockers.append(f"{barrier['id']}: {exc}")
    return blockers


def remaining_checkpoint_obligations(
    barriers: list[dict[str, Any]],
    acknowledgments: dict[str, dict[str, Any] | None],
    completions: dict[str, dict[str, Any] | None],
) -> list[dict[str, Any]]:
    unresolved = []
    for barrier in barriers:
        synthetic = {"manifestId": "successor", "barriers": [barrier]}
        if barrier_blockers(synthetic, acknowledgments, completions):
            unresolved.append(barrier)
    return unresolved


def planned_action(
    *,
    operation: str,
    order: str,
    selected: bool,
    hold: dict[str, Any] | None,
    live_digest: str | None,
    desired_digest: str,
) -> tuple[str, str]:
    if order == "stale" and operation == "ordinary":
        return "skip", "stale source ancestry"
    if not selected:
        return "skip", "not the explicitly selected resume service"
    if hold and operation != "resume":
        return "held", str(hold.get("reason") or "active service hold")
    if live_digest == desired_digest:
        return "verify", "live digest already matches desired state"
    return "deploy", "live digest differs from desired state"


def apply_api_hold_gate(
    plan_services: dict[str, dict[str, Any]], config: dict[str, Any], api_blocked: bool
) -> None:
    if not api_blocked:
        return
    for key, physical in config["services"].items():
        if physical["phase"] == "frontend" and plan_services[key]["action"] not in {"held", "skip"}:
            plan_services[key]["action"] = "blocked"
            plan_services[key]["reason"] = "API hold does not prove compatibility with dependent frontends"


def require_resume_api_readiness(api: dict[str, Any], blocked: bool) -> None:
    if blocked or api["observedDigest"] != api["desiredDigest"]:
        fail("Frontend resume requires the selected manifest API digest and no incompatible API hold")
    api.update(action="verify", reason="verify API readiness before frontend resume")


def final_service_status(
    *, operation: str, order: str, planned: str, live_matches: bool, proven: bool, held: bool
) -> str:
    if operation == "resume" and planned == "skip":
        return "not-selected"
    if planned == "skip" and order == "stale":
        return "superseded"
    if held:
        return "held"
    return "succeeded" if live_matches and proven else "failed"


class CommandRunner:
    def run(self, *args: str, input_value: str | None = None) -> str:
        result = subprocess.run(
            args,
            input=input_value,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode:
            detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
            fail(f"Command failed ({' '.join(args[:3])}): {detail}")
        return result.stdout


class Aws:
    def __init__(self, runner: CommandRunner, config: dict[str, Any]):
        self.runner = runner
        self.config = config
        self.region = config["deployment"]["region"]

    def json(self, service: str, operation: str, *args: str) -> Any:
        output = self.runner.run("aws", service, operation, *args, "--region", self.region, "--output", "json")
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            fail(f"AWS {service} {operation} returned invalid JSON")

    def text(self, service: str, operation: str, *args: str) -> str:
        return self.runner.run("aws", service, operation, *args, "--region", self.region, "--output", "text").strip()

    def get_parameter(self, name: str) -> dict[str, Any] | None:
        result = subprocess.run(
            ["aws", "ssm", "get-parameter", "--name", name, "--region", self.region, "--output", "json"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode:
            if "ParameterNotFound" in result.stderr:
                return None
            fail(f"Cannot read deployment state {name}: {result.stderr.strip()}")
        try:
            parsed = json.loads(result.stdout)["Parameter"]["Value"]
            value = json.loads(parsed)
        except (KeyError, json.JSONDecodeError):
            fail(f"Deployment state {name} is corrupt")
        if not isinstance(value, dict):
            fail(f"Deployment state {name} is corrupt")
        return value

    def put_parameter(self, name: str, value: dict[str, Any]) -> None:
        encoded = canonical_json(value)
        if len(encoded.encode()) > 4096:
            fail(f"Deployment state {name} exceeds the SSM standard parameter limit")
        self.runner.run(
            "aws",
            "ssm",
            "put-parameter",
            "--name",
            name,
            "--type",
            "String",
            "--value",
            encoded,
            "--overwrite",
            "--region",
            self.region,
        )

    def service_snapshot(self, key: str) -> dict[str, Any]:
        physical = self.config["services"][key]
        cluster = self.config["deployment"]["cluster"]
        account = self.config["deployment"]["accountId"]
        response = self.json("ecs", "describe-services", "--cluster", cluster, "--services", physical["ecsService"])
        services = response.get("services") or []
        if len(services) != 1 or response.get("failures"):
            fail(f"ECS did not return exactly one physical service for {key}")
        service = services[0]
        expected_service_arn = f"arn:aws:ecs:{self.region}:{account}:service/{cluster}/{physical['ecsService']}"
        if service.get("serviceArn") != expected_service_arn:
            fail(f"Physical ECS identity mismatch for {key}")
        task_arn = service.get("taskDefinition")
        prefix = f"arn:aws:ecs:{self.region}:{account}:task-definition/{physical['taskFamily']}:"
        if not isinstance(task_arn, str) or not task_arn.startswith(prefix):
            fail(f"Task family mismatch for {key}")
        task = self.json("ecs", "describe-task-definition", "--task-definition", task_arn).get("taskDefinition")
        if not isinstance(task, dict) or task.get("family") != physical["taskFamily"]:
            fail(f"Task definition identity mismatch for {key}")
        containers = [item for item in task.get("containerDefinitions", []) if item.get("name") == physical["containerName"]]
        if len(containers) != 1:
            fail(f"Expected one configured container for {key}")
        image = containers[0].get("image")
        repository_uri = (
            f"{account}.dkr.ecr.{self.region}.amazonaws.com/{physical['ecrRepository']}"
        )
        digest = validate_ecr_image_reference(image, repository_uri, f"live image for {key}")
        return {
            "serviceArn": service["serviceArn"],
            "taskDefinitionArn": task_arn,
            "taskDefinition": task,
            "image": image,
            "digest": digest,
        }

    def verify_image(self, key: str, image: dict[str, Any]) -> None:
        physical = self.config["services"][key]
        if image["ecrRepository"] != physical["ecrRepository"]:
            fail(f"Unapproved ECR repository for {key}")
        response = self.json(
            "ecr",
            "describe-images",
            "--repository-name",
            physical["ecrRepository"],
            "--image-ids",
            f"imageDigest={image['digest']}",
        )
        details = response.get("imageDetails") or []
        if len(details) != 1 or details[0].get("imageDigest") != image["digest"]:
            fail(f"ECR does not contain the immutable desired image for {key}")
        tags = details[0].get("imageTags") or []
        expected_source_tag = f"next-{image['imageSourceSha']}"
        preparation_tag = f"next-prepare-{image['imageSourceSha']}"
        if expected_source_tag not in tags and preparation_tag not in tags:
            fail(f"ECR digest for {key} is not tagged with {expected_source_tag}")

    def register_rendered_task(self, key: str, snapshot: dict[str, Any], digest: str) -> str:
        physical = self.config["services"][key]
        task = {name: value for name, value in snapshot["taskDefinition"].items() if name not in TASK_DEFINITION_READ_ONLY_FIELDS}
        containers = task.get("containerDefinitions") or []
        matches = 0
        registry = f"{self.config['deployment']['accountId']}.dkr.ecr.{self.region}.amazonaws.com"
        desired_uri = f"{registry}/{physical['ecrRepository']}@{digest}"
        for container in containers:
            if container.get("name") == physical["containerName"]:
                container["image"] = desired_uri
                matches += 1
        if matches != 1:
            fail(f"Cannot safely render task definition for {key}")
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(task, handle, separators=(",", ":"))
            temp_path = handle.name
        try:
            response = self.json("ecs", "register-task-definition", "--cli-input-json", f"file://{temp_path}")
        finally:
            Path(temp_path).unlink(missing_ok=True)
        arn = (response.get("taskDefinition") or {}).get("taskDefinitionArn")
        prefix = (
            f"arn:aws:ecs:{self.region}:{self.config['deployment']['accountId']}:"
            f"task-definition/{physical['taskFamily']}:"
        )
        if not isinstance(arn, str) or not arn.startswith(prefix):
            fail(f"Registered task definition identity mismatch for {key}")
        return arn

    def verify_api_split_image(self, key: str, digest: str) -> None:
        if key != "next-target-backend":
            return
        repository = self.config["services"][key]["ecrRepository"]
        require_digest(digest, "API split image")
        details = self.json("ecr", "describe-images", "--repository-name", repository,
                            "--image-ids", f"imageDigest={digest}")
        with tempfile.TemporaryDirectory() as directory:
            document = Path(directory) / "image.json"
            document.write_text(json.dumps(details))
            self.runner.run(sys.executable, str(ROOT / "scripts/assert-next-api-split-compatible-image.py"),
                            key, repository, digest, str(document))

    def update_service(self, key: str, task_definition: str) -> None:
        physical = self.config["services"][key]
        cluster = self.config["deployment"]["cluster"]
        self.runner.run(
            "aws",
            "ecs",
            "update-service",
            "--cluster",
            cluster,
            "--service",
            physical["ecsService"],
            "--task-definition",
            task_definition,
            "--region",
            self.region,
        )
        self.wait_service(key)

    def wait_service(self, key: str) -> None:
        physical = self.config["services"][key]
        cluster = self.config["deployment"]["cluster"]
        self.runner.run(
            "aws",
            "ecs",
            "wait",
            "services-stable",
            "--cluster",
            cluster,
            "--services",
            physical["ecsService"],
            "--region",
            self.region,
        )


class GitHub:
    def __init__(self, repository: str, token: str):
        self.repository = repository
        self.token = token

    def request(self, path: str, *, accept: str = "application/vnd.github+json") -> bytes:
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repository}{path}",
            headers={
                "Accept": accept,
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "vayada-coordinated-release-v1",
            },
        )
        # Signed artifact URLs authenticate themselves; never forward the GitHub token.
        request.add_unredirected_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read(2_000_001)
        except urllib.error.HTTPError as exc:
            fail(f"GitHub API {path} failed with HTTP {exc.code}")
        except urllib.error.URLError as exc:
            fail(f"GitHub API {path} failed: {exc.reason}")
        if len(data) > 2_000_000:
            fail("GitHub response exceeds the bounded release artifact limit")
        return data

    def json(self, path: str) -> dict[str, Any]:
        try:
            value = json.loads(self.request(path))
        except json.JSONDecodeError:
            fail(f"GitHub API {path} returned invalid JSON")
        if not isinstance(value, dict):
            fail(f"GitHub API {path} returned an unexpected payload")
        return value

    def download_bundle(self, artifact_id: int, output: Path) -> dict[str, Any]:
        artifact = self.json(f"/actions/artifacts/{artifact_id}")
        archive = self.request(f"/actions/artifacts/{artifact_id}/zip", accept="application/vnd.github+json")
        try:
            zipped = zipfile.ZipFile(io.BytesIO(archive))
        except zipfile.BadZipFile:
            fail("Published release artifact is not a valid zip archive")
        expected = {"manifest.json", "manifest.sha256", "published-record.json", "published-record.sha256"}
        names = set(zipped.namelist())
        if names != expected:
            fail(f"Published release artifact must contain exactly {sorted(expected)}")
        output.mkdir(parents=True, exist_ok=True)
        for name in expected:
            data = zipped.read(name)
            if len(data) > 512_000:
                fail(f"Published artifact member {name} is too large")
            (output / name).write_bytes(data)
        for stem in ("manifest", "published-record"):
            checksum = (output / f"{stem}.sha256").read_text().strip()
            digest = sha256_file(output / f"{stem}.json")
            # The producer's sha256sum output includes the exact JSON basename.
            if checksum not in (digest, f"{digest}  {stem}.json"):
                fail(f"{stem}.sha256 does not bind {stem}.json")
        return artifact

    def compare(self, base: str, head: str) -> str:
        require_sha(base, "compare base")
        require_sha(head, "compare head")
        value = self.json(f"/compare/{base}...{head}").get("status")
        if value not in {"ahead", "behind", "identical", "diverged"}:
            fail("GitHub compare returned an unknown ancestry result")
        return value


def state_path(config: dict[str, Any], suffix: str) -> str:
    return f"{config['deployment']['statePrefix']}/{suffix}"


def validate_desired_record(value: dict[str, Any]) -> None:
    exact_keys(
        value,
        {
            "schemaVersion",
            "manifestId",
            "manifestSha256",
            "publishedRecordSha256",
            "artifactId",
            "sourceSha",
            "buildRunId",
            "buildRunAttempt",
            "acceptedAt",
            "operationId",
        },
        "desired-release",
    )
    if value["schemaVersion"] != 1:
        fail("desired-release schemaVersion is unknown")
    if not re.fullmatch(r"vayada-release/v1/[0-9a-f]{40}/[1-9][0-9]*/[1-9][0-9]*", str(value["manifestId"])):
        fail("desired-release.manifestId is invalid")
    require_sha(value["sourceSha"], "desired-release.sourceSha")
    positive_int(value["artifactId"], "desired-release.artifactId")
    positive_int(value["buildRunId"], "desired-release.buildRunId")
    positive_int(value["buildRunAttempt"], "desired-release.buildRunAttempt")
    for field in ("manifestSha256", "publishedRecordSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(value[field])):
            fail(f"desired-release.{field} is invalid")
    parse_time(value["acceptedAt"], "desired-release.acceptedAt")
    require_id(value["operationId"], "desired-release.operationId")


def validate_hold(value: dict[str, Any], config: dict[str, Any], service: str) -> None:
    base_fields = {
        "schemaVersion",
        "status",
        "service",
        "physicalIdentity",
        "reason",
        "operationId",
        "manifestId",
        "capturedTaskDefinitionArn",
        "capturedImage",
        "dependentFrontendsCompatible",
        "createdAt",
    }
    cleared_fields = {"clearedAt", "clearedByOperationId", "resumedManifestId"}
    status = value.get("status")
    exact_keys(value, base_fields | (cleared_fields if status == "cleared" else set()), f"hold.{service}")
    if value["schemaVersion"] != 1 or value["service"] != service or status not in {"active", "cleared"}:
        fail(f"Hold state for {service} is corrupt")
    physical = config["services"][service]
    expected_identity = {
        "accountId": config["deployment"]["accountId"],
        "region": config["deployment"]["region"],
        "cluster": config["deployment"]["cluster"],
        "ecsService": physical["ecsService"],
    }
    if value["physicalIdentity"] != expected_identity:
        fail(f"Hold physical identity for {service} is corrupt")
    if not isinstance(value["reason"], str) or not value["reason"].strip():
        fail(f"Hold reason for {service} is corrupt")
    require_id(value["operationId"], f"hold.{service}.operationId")
    if value["manifestId"] is not None:
        require_id(value["manifestId"], f"hold.{service}.manifestId")
    task_prefix = (
        f"arn:aws:ecs:{config['deployment']['region']}:{config['deployment']['accountId']}:"
        f"task-definition/{physical['taskFamily']}:"
    )
    if not str(value["capturedTaskDefinitionArn"]).startswith(task_prefix):
        fail(f"Hold rollback task identity for {service} is corrupt")
    repository_uri = (
        f"{config['deployment']['accountId']}.dkr.ecr.{config['deployment']['region']}.amazonaws.com/"
        f"{physical['ecrRepository']}"
    )
    validate_ecr_image_reference(value["capturedImage"], repository_uri, f"hold.{service}.capturedImage")
    if not isinstance(value["dependentFrontendsCompatible"], bool):
        fail(f"Hold compatibility for {service} is corrupt")
    parse_time(value["createdAt"], f"hold.{service}.createdAt")
    if status == "cleared":
        parse_time(value["clearedAt"], f"hold.{service}.clearedAt")
        require_id(value["clearedByOperationId"], f"hold.{service}.clearedByOperationId")
        require_id(value["resumedManifestId"], f"hold.{service}.resumedManifestId")


def ownership_mode(aws: Aws, config: dict[str, Any]) -> str:
    record = aws.get_parameter(state_path(config, "ownership-mode"))
    if record is None:
        return "legacy"
    if set(record) != {"schemaVersion", "mode", "changedAt", "operationId"} or record.get("schemaVersion") != 1:
        fail("Deployment ownership mode is corrupt")
    if record.get("mode") not in {"legacy", "batch"}:
        fail("Deployment ownership mode is unknown")
    if record.get("schemaVersion") != 1:
        fail("Deployment ownership mode schemaVersion is unknown")
    parse_time(record.get("changedAt"), "ownership-mode.changedAt")
    require_id(record.get("operationId"), "ownership-mode.operationId")
    return record["mode"]


def active_hold(aws: Aws, config: dict[str, Any], service: str) -> dict[str, Any] | None:
    hold = aws.get_parameter(state_path(config, f"services/{service}/hold"))
    if hold is None:
        return None
    validate_hold(hold, config, service)
    return hold if hold["status"] == "active" else None


def write_hold(
    aws: Aws,
    config: dict[str, Any],
    service: str,
    snapshot: dict[str, Any],
    *,
    reason: str,
    operation_id: str,
    manifest_id: str | None,
) -> dict[str, Any]:
    require_id(operation_id, "operationId")
    if not reason.strip():
        fail("A non-empty hold reason is required")
    physical = config["services"][service]
    hold = {
        "schemaVersion": 1,
        "status": "active",
        "service": service,
        "physicalIdentity": {
            "accountId": config["deployment"]["accountId"],
            "region": config["deployment"]["region"],
            "cluster": config["deployment"]["cluster"],
            "ecsService": physical["ecsService"],
        },
        "reason": reason.strip(),
        "operationId": operation_id,
        "manifestId": manifest_id,
        "capturedTaskDefinitionArn": snapshot["taskDefinitionArn"],
        "capturedImage": snapshot["image"],
        "dependentFrontendsCompatible": False,
        "createdAt": iso_now(),
    }
    aws.put_parameter(state_path(config, f"services/{service}/hold"), hold)
    return hold


def bootstrap_evidence(aws: Aws, github: GitHub, config: dict[str, Any], key: str,
                       snapshot: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """Prove the live source before first ownership; unknown/manual images require holds."""
    digest = require_digest(snapshot["digest"], f"bootstrap.{key}.liveDigest")
    provenance = validate_provenance(
        aws.get_parameter(state_path(config, f"services/{key}/provenance")), config, key
    )
    if provenance:
        if (provenance["digest"] != digest or
                provenance["taskDefinitionArn"] != snapshot["taskDefinitionArn"]):
            fail(f"Bootstrap provenance differs from live service {key}; establish an explicit hold")
        source = provenance["sourceSha"]
        evidence = {"provenance": provenance}
    else:
        workflow = {
            "next-target-backend": "deploy-next-api.yml",
            "next-pms-frontend": "deploy-next-pms-web.yml",
            "next-booking-frontend": "deploy-next-booking-web.yml",
            "next-booking-admin": "deploy-next-booking-admin.yml",
            "next-marketplace-frontend": "deploy-next-marketplace-web.yml",
            "next-marketplace-admin": "deploy-next-vayada-admin.yml",
        }[key]
        details = aws.json("ecr", "describe-images", "--repository-name",
                           config["services"][key]["ecrRepository"], "--image-ids", f"imageDigest={digest}")
        images = details.get("imageDetails") or []
        if len(images) != 1 or images[0].get("imageDigest") != digest:
            fail(f"Bootstrap live digest is missing from ECR for {key}")
        sources = [tag[5:] for tag in images[0].get("imageTags", [])
                   if tag.startswith("next-") and SHA_RE.fullmatch(tag[5:])]
        if len(sources) != 1:
            fail(f"Bootstrap live source is unknown or ambiguous for {key}; establish an explicit hold")
        source = sources[0]
        runs = github.json(f"/actions/workflows/{workflow}/runs?head_sha={source}&branch=main&event=push&status=success&per_page=100")
        trusted = [run for run in runs.get("workflow_runs", [])
                   if run.get("head_sha") == source and run.get("head_branch") == "main"
                   and run.get("path") == f".github/workflows/{workflow}"
                   and run.get("event") == "push" and run.get("status") == "completed"
                   and run.get("conclusion") == "success"
                   and (run.get("repository") or {}).get("full_name") == config["producer"]["repository"]
                   and (run.get("head_repository") or {}).get("full_name") == config["producer"]["repository"]]
        if not trusted:
            fail(f"Bootstrap has no successful trusted automatic image build for {key}; establish an explicit hold")
        evidence = {"buildRunId": trusted[0]["id"], "buildRunAttempt": trusted[0]["run_attempt"],
                    "workflowPath": trusted[0]["path"]}
    if github.compare(source, manifest["source"]["sha"]) not in {"ahead", "identical"}:
        fail(f"Bootstrap target would regress or diverge from live {key}")
    return {"digest": digest, "sourceSha": source, "taskDefinitionArn": snapshot["taskDefinitionArn"],
            "evidence": evidence}


def prepare_release(args: argparse.Namespace) -> None:
    prepare_started_at = iso_now()
    config = load_config(args.config)
    token = os.environ.get("COORDINATED_RELEASE_READ_TOKEN", "")
    if not token:
        fail("COORDINATED_RELEASE_READ_TOKEN is required")
    github = GitHub(config["producer"]["repository"], token)
    artifact_id = positive_int(args.artifact_id, "artifactId")
    output = Path(args.output_dir)
    artifact = github.download_bundle(artifact_id, output)
    manifest = read_json(output / "manifest.json")
    record = read_json(output / "published-record.json")
    if args.dispatch_json:
        dispatch = read_json(args.dispatch_json)
    else:
        if not args.manifest_sha256 or not args.published_record_sha256:
            fail("Manual reconciliation requires both immutable content hashes")
        dispatch = {
            "schemaVersion": 1,
            "manifestId": manifest.get("manifestId"),
            "manifestSha256": args.manifest_sha256,
            "publishedRecordSha256": args.published_record_sha256,
            "sourceSha": (manifest.get("source") or {}).get("sha"),
            "repository": manifest.get("repository"),
            "workflowName": (manifest.get("build") or {}).get("workflowName"),
            "workflowPath": (manifest.get("build") or {}).get("workflowPath"),
            "runId": (manifest.get("build") or {}).get("runId"),
            "runAttempt": (manifest.get("build") or {}).get("runAttempt"),
            "publishedArtifactId": artifact_id,
            "publishedArtifactName": record.get("publishedArtifactName"),
            "publisherRunId": (record.get("publisher") or {}).get("runId"),
            "publisherRunAttempt": (record.get("publisher") or {}).get("runAttempt"),
            "idempotencyKey": manifest.get("manifestId"),
        }
    build_run = github.json(f"/actions/runs/{manifest.get('build', {}).get('runId', 0)}")
    publisher_run = github.json(f"/actions/runs/{(record.get('publisher') or {}).get('runId', 0)}")
    manifest, record = validate_publication(
        manifest_path=output / "manifest.json",
        record_path=output / "published-record.json",
        dispatch=dispatch,
        artifact=artifact,
        build_run=build_run,
        publisher_run=publisher_run,
        config=config,
    )
    if args.operation == "verify":
        # End before ownership/state access: verification must not become activation.
        aws = Aws(CommandRunner(), config)
        target = manifest["source"]["sha"]
        for source in {image["imageSourceSha"] for image in manifest["services"].values()}:
            if github.compare(source, target) not in {"ahead", "identical"}:
                fail("Published image source is not an ancestor of the release")
        for key, image in manifest["services"].items():
            aws.verify_image(key, image)
        result = {"manifestId": manifest["manifestId"], "sourceSha": target,
                  "verification": "publication-ancestry-images", "deploymentReadiness": "not-checked"}
        (output / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        return
    runner = CommandRunner()
    aws = Aws(runner, config)
    mode = ownership_mode(aws, config)
    if args.operation == "ordinary" and mode != "batch":
        fail("Coordinated automatic ownership is not activated; receiver support is installed in legacy mode")
    if args.operation == "activate" and mode != "legacy":
        fail("Activation requires legacy mode and one explicitly selected bootstrap release")
    if args.operation == "resume" and args.service not in config["services"]:
        fail("Resume must name one configured physical service")
    desired = aws.get_parameter(state_path(config, "desired-release"))
    if desired is not None:
        validate_desired_record(desired)
    if args.operation == "ordinary" and desired is None:
        fail("Batch ownership has no desired-release bootstrap record; fail closed")
    compare_status = None
    if desired and desired.get("sourceSha") != manifest["source"]["sha"]:
        desired_sha = require_sha(desired.get("sourceSha"), "desired-release.sourceSha")
        compare_status = github.compare(desired_sha, manifest["source"]["sha"])
    order = assess_order(manifest["source"]["sha"], desired, compare_status)
    if args.operation == "activate" and order == "stale":
        fail("Activation target is older than the retained desired release")
    if order == "duplicate" and desired and desired.get("manifestId") != manifest["manifestId"]:
        fail("A different manifest already exists for this source revision")
    # previousManifestId names the producer build baseline, not receiver acceptance.
    # Complete publications may coalesce undelivered releases or use an older baseline.
    # Source ancestry orders delivery; durable checkpoint obligations below remain binding.
    previous_sha = manifest["previousSourceSha"]
    if previous_sha is not None and github.compare(previous_sha, manifest["source"]["sha"]) not in {"ahead", "identical"}:
        fail("Manifest previousSourceSha is not an ancestor of its source")
    retained_barriers = validate_checkpoint_obligations(
        aws.get_parameter(state_path(config, "checkpoint-obligations"))
    )
    checkpoint_barriers = merge_checkpoint_barriers(retained_barriers, manifest)
    barrier_manifest = dict(manifest)
    barrier_manifest["barriers"] = checkpoint_barriers
    acknowledgments = {
        barrier["id"]: aws.get_parameter(state_path(config, f"checkpoints/{barrier['id']}"))
        for barrier in checkpoint_barriers
    }
    completions = {
        barrier["id"]: aws.get_parameter(
            state_path(config, f"checkpoint-completions/{barrier['id']}")
        )
        for barrier in checkpoint_barriers
        if barrier["requiredCheckpointManifestId"] is not None
    }
    blockers = barrier_blockers(barrier_manifest, acknowledgments, completions)
    if blockers:
        fail("Release is blocked by checkpoints: " + "; ".join(blockers))
    remaining_barriers = remaining_checkpoint_obligations(
        checkpoint_barriers, acknowledgments, completions
    )
    if args.operation == "resume":
        hold = active_hold(aws, config, args.service)
        if not hold:
            fail(f"Resume requires an active hold for {args.service}")
    snapshots: dict[str, dict[str, Any]] = {}
    plan_services: dict[str, dict[str, Any]] = {}
    api_key = next(key for key, value in config["services"].items() if value["phase"] == "api")
    api_blocked = False
    bootstrap = {}
    for key in config["services"]:
        image = manifest["services"][key]
        aws.verify_image(key, image)
        snapshot = aws.service_snapshot(key)
        snapshots[key] = snapshot
        hold = active_hold(aws, config, key)
        if args.operation == "activate":
            bootstrap[key] = {"hold": hold} if hold else bootstrap_evidence(aws, github, config, key, snapshot, manifest)
        selected = args.operation in {"ordinary", "activate"} or key == args.service
        action, reason = planned_action(
            operation=args.operation,
            order=order,
            selected=selected,
            hold=hold,
            live_digest=snapshot["digest"],
            desired_digest=image["digest"],
        )
        if key == api_key and incompatible_api_hold_blocks_frontends(
            hold,
            operation=args.operation,
            selected_service=args.service,
            api_service=api_key,
        ):
            api_blocked = True
        plan_services[key] = {
            "action": action,
            "reason": reason,
            "observedDigest": snapshot["digest"],
            "observedTaskDefinitionArn": snapshot["taskDefinitionArn"],
            "desiredDigest": image["digest"],
        }
    if args.operation == "resume" and args.service != api_key:
        require_resume_api_readiness(plan_services[api_key], api_blocked)
    apply_api_hold_gate(plan_services, config, api_blocked)
    operation_id = require_id(args.operation_id, "operationId")
    plan = {
        "schemaVersion": 1,
        "operation": args.operation,
        "resumeService": args.service if args.operation == "resume" else None,
        "operationId": operation_id,
        "manifestId": manifest["manifestId"],
        "manifestSha256": sha256_file(output / "manifest.json"),
        "publishedRecordSha256": sha256_file(output / "published-record.json"),
        "sourceSha": manifest["source"]["sha"],
        "artifactId": artifact_id,
        "publishedAt": record["publishedAt"],
        "prepareStartedAt": prepare_started_at,
        "order": "explicit-resume" if args.operation == "resume" else order,
        "preparedAt": iso_now(),
        "services": plan_services,
        "bootstrap": bootstrap,
    }
    if args.operation in {"ordinary", "activate"} and order != "stale":
        aws.put_parameter(
            state_path(config, "checkpoint-obligations"),
            {
                "schemaVersion": 1,
                "barriers": remaining_barriers,
                "updatedAt": iso_now(),
                "operationId": operation_id,
            },
        )
        desired_record = {
            "schemaVersion": 1,
            "manifestId": manifest["manifestId"],
            "manifestSha256": plan["manifestSha256"],
            "publishedRecordSha256": plan["publishedRecordSha256"],
            "artifactId": artifact_id,
            "sourceSha": manifest["source"]["sha"],
            "buildRunId": manifest["build"]["runId"],
            "buildRunAttempt": manifest["build"]["runAttempt"],
            "acceptedAt": iso_now(),
            "operationId": operation_id,
        }
        aws.put_parameter(state_path(config, "desired-release"), desired_record)
        if args.operation == "activate":
            for key, evidence in bootstrap.items():
                aws.put_parameter(state_path(config, f"services/{key}/bootstrap"),
                                  {"schemaVersion": 1, "operationId": operation_id, "verifiedAt": iso_now(), **evidence})
            aws.put_parameter(
                state_path(config, "ownership-mode"),
                {"schemaVersion": 1, "mode": "batch", "changedAt": iso_now(), "operationId": operation_id},
            )
    (output / "plan.json").write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"manifestId": manifest["manifestId"], "order": order, "services": plan_services}, indent=2))


def smoke_service(runner: CommandRunner, config: dict[str, Any], key: str, image_source_sha: str) -> None:
    smoke = config["services"][key]["smoke"]
    if smoke == "api":
        request = urllib.request.Request("https://next-api.vayada.com/health", headers={"User-Agent": "vayada-release-smoke-v1"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = json.loads(response.read(100_001))
                status = response.status
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            fail(f"API health smoke failed: {exc}")
        if not isinstance(body, dict) or status != 200 or body.get("status") != "ok":
            fail("API health smoke did not return status=ok")
    elif smoke == "auth":
        runner.run("bash", str(ROOT / "scripts" / "smoke-auth-gateway.sh"), key)
    elif smoke == "booking-public":
        env = os.environ.copy()
        env["EXPECTED_BUILD_SHA"] = image_source_sha
        result = subprocess.run(
            ["bash", str(ROOT / "scripts" / "smoke-next-booking-public.sh"), key],
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode:
            fail(result.stderr.strip() or result.stdout.strip() or "Booking public smoke failed")
    else:
        fail(f"Unknown smoke policy for {key}")


def write_provenance(
    aws: Aws,
    config: dict[str, Any],
    key: str,
    manifest: dict[str, Any],
    snapshot: dict[str, Any],
    operation_id: str,
) -> None:
    image = manifest["services"][key]
    provenance = {
        "schemaVersion": 1,
        "service": key,
        "physicalServiceArn": snapshot["serviceArn"],
        "manifestId": manifest["manifestId"],
        "sourceSha": manifest["source"]["sha"],
        "digest": image["digest"],
        "imageSourceSha": image["imageSourceSha"],
        "taskDefinitionArn": snapshot["taskDefinitionArn"],
        "operationId": operation_id,
        "verifiedAt": iso_now(),
    }
    aws.put_parameter(state_path(config, f"services/{key}/provenance"), provenance)


def validate_provenance(
    value: dict[str, Any] | None, config: dict[str, Any], service: str
) -> dict[str, Any] | None:
    if value is None:
        return None
    exact_keys(
        value,
        {
            "schemaVersion",
            "service",
            "physicalServiceArn",
            "manifestId",
            "sourceSha",
            "digest",
            "imageSourceSha",
            "taskDefinitionArn",
            "operationId",
            "verifiedAt",
        },
        f"provenance.{service}",
    )
    if value["schemaVersion"] != 1 or value["service"] != service:
        fail(f"Provenance for {service} is corrupt")
    physical = config["services"][service]
    expected_service_arn = (
        f"arn:aws:ecs:{config['deployment']['region']}:{config['deployment']['accountId']}:"
        f"service/{config['deployment']['cluster']}/{physical['ecsService']}"
    )
    task_prefix = (
        f"arn:aws:ecs:{config['deployment']['region']}:{config['deployment']['accountId']}:"
        f"task-definition/{physical['taskFamily']}:"
    )
    if value["physicalServiceArn"] != expected_service_arn or not str(value["taskDefinitionArn"]).startswith(task_prefix):
        fail(f"Provenance physical identity for {service} is corrupt")
    require_id(value["manifestId"], f"provenance.{service}.manifestId")
    require_sha(value["sourceSha"], f"provenance.{service}.sourceSha")
    require_digest(value["digest"], f"provenance.{service}.digest")
    require_sha(value["imageSourceSha"], f"provenance.{service}.imageSourceSha")
    require_id(value["operationId"], f"provenance.{service}.operationId")
    parse_time(value["verifiedAt"], f"provenance.{service}.verifiedAt")
    return value


def clear_hold(aws: Aws, config: dict[str, Any], key: str, manifest_id: str, operation_id: str) -> None:
    previous = active_hold(aws, config, key)
    if not previous:
        fail(f"Cannot clear absent hold for {key}")
    cleared = dict(previous)
    cleared.update(
        {
            "status": "cleared",
            "clearedAt": iso_now(),
            "clearedByOperationId": operation_id,
            "resumedManifestId": manifest_id,
        }
    )
    aws.put_parameter(state_path(config, f"services/{key}/hold"), cleared)


def recoverable_pending_operation(
    value: dict[str, Any] | None, config: dict[str, Any], service: str, manifest: dict[str, Any]
) -> dict[str, Any] | None:
    if value is None:
        return None
    required = {
        "schemaVersion",
        "operationId",
        "service",
        "manifestId",
        "desiredDigest",
        "rollbackTaskDefinitionArn",
        "rollbackImage",
        "startedAt",
        "status",
    }
    if not required.issubset(value):
        fail(f"Pending operation for {service} is corrupt")
    if value["schemaVersion"] != 1 or value["service"] != service:
        fail(f"Pending operation for {service} is corrupt")
    require_id(value["operationId"], f"pending.{service}.operationId")
    require_digest(value["desiredDigest"], f"pending.{service}.desiredDigest")
    parse_time(value["startedAt"], f"pending.{service}.startedAt")
    physical = config["services"][service]
    task_prefix = (
        f"arn:aws:ecs:{config['deployment']['region']}:{config['deployment']['accountId']}:"
        f"task-definition/{physical['taskFamily']}:"
    )
    repository_uri = (
        f"{config['deployment']['accountId']}.dkr.ecr.{config['deployment']['region']}.amazonaws.com/"
        f"{physical['ecrRepository']}"
    )
    if not str(value["rollbackTaskDefinitionArn"]).startswith(task_prefix):
        fail(f"Pending rollback task for {service} is corrupt")
    validate_ecr_image_reference(value["rollbackImage"], repository_uri, f"pending.{service}.rollbackImage")
    if value["status"] not in {"prepared", "mutating", "failed", "succeeded", "rolled-back-held"}:
        fail(f"Pending operation status for {service} is corrupt")
    if (
        value["manifestId"] == manifest["manifestId"]
        and value["desiredDigest"] == manifest["services"][service]["digest"]
        and value["status"] in {"prepared", "mutating", "failed"}
    ):
        return value
    return None


def reconcile_service(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    manifest = read_json(args.manifest)
    plan = read_json(args.plan)
    runner = CommandRunner()
    aws = Aws(runner, config)
    reconcile_service_with_dependencies(
        args, config, manifest, plan, aws, runner, smoke_service, validate_manifest
    )


def reconcile_service_with_dependencies(
    args: argparse.Namespace,
    config: dict[str, Any],
    manifest: dict[str, Any],
    plan: dict[str, Any],
    aws: Aws,
    runner: CommandRunner,
    smoke: Callable[[CommandRunner, dict[str, Any], str, str], None],
    validate: Callable[[dict[str, Any], dict[str, Any]], None],
) -> None:
    validate(manifest, config)
    key = args.service
    if key not in config["services"]:
        fail("Unknown physical service")
    if plan.get("schemaVersion") != 1 or plan.get("manifestId") != manifest["manifestId"]:
        fail("Plan does not bind the manifest")
    if plan.get("manifestSha256") != sha256_file(args.manifest):
        fail("Plan manifest hash changed after preparation")
    service_plan = (plan.get("services") or {}).get(key)
    if not isinstance(service_plan, dict):
        fail("Plan does not contain the selected service")
    action = service_plan.get("action")
    if action in {"skip", "held"}:
        print(f"{key}: {action} ({service_plan.get('reason')})")
        return
    if action == "blocked":
        fail(f"{key} is blocked: {service_plan.get('reason')}")
    if action not in {"verify", "deploy"}:
        fail(f"Unknown plan action for {key}")
    image = manifest["services"][key]
    aws.verify_image(key, image)
    aws.verify_api_split_image(key, image["digest"])
    before = aws.service_snapshot(key)
    if action == "verify" and before["digest"] != image["digest"]:
        fail(f"{key} changed after preparation; verify-only cannot mutate it")
    operation_id = require_id(plan["operationId"], "plan.operationId")
    operation_path = state_path(config, f"operations/{operation_id}/{key}")
    pending_path = state_path(config, f"services/{key}/pending-operation")
    pending = recoverable_pending_operation(aws.get_parameter(pending_path), config, key, manifest)
    rollback_task_definition = before["taskDefinitionArn"]
    rollback_image = before["image"]
    recovering_mutation = False
    if pending and before["digest"] == image["digest"]:
        rollback_task_definition = pending["rollbackTaskDefinitionArn"]
        rollback_image = pending["rollbackImage"]
        recovering_mutation = rollback_task_definition != before["taskDefinitionArn"]
    if before["digest"] != image["digest"] or recovering_mutation:
        # Check the retained pre-mutation image as well, including interrupted retries.
        aws.verify_api_split_image(key, rollback_image.rsplit("@", 1)[-1])
    operation = {
        "schemaVersion": 1,
        "operationId": operation_id,
        "service": key,
        "manifestId": manifest["manifestId"],
        "desiredDigest": image["digest"],
        "rollbackTaskDefinitionArn": rollback_task_definition,
        "rollbackImage": rollback_image,
        "startedAt": iso_now(),
        "status": "prepared",
    }
    aws.put_parameter(operation_path, operation)
    aws.put_parameter(pending_path, operation)
    deployed_task = None
    mutation_started = False
    try:
        if before["digest"] != image["digest"]:
            deployed_task = aws.register_rendered_task(key, before, image["digest"])
            operation.update({"status": "mutating", "deployedTaskDefinitionArn": deployed_task})
            aws.put_parameter(operation_path, operation)
            aws.put_parameter(pending_path, operation)
            latest = aws.service_snapshot(key)
            if latest["taskDefinitionArn"] != before["taskDefinitionArn"]:
                fail(f"{key} changed after preparation; refusing to overwrite it")
            mutation_started = True
            aws.update_service(key, deployed_task)
        else:
            aws.wait_service(key)
        observed = aws.service_snapshot(key)
        if observed["digest"] != image["digest"]:
            fail(f"{key} did not converge to the desired immutable digest")
        smoke(runner, config, key, image["imageSourceSha"])
        write_provenance(aws, config, key, manifest, observed, operation_id)
        operation.update(
            {
                "status": "succeeded",
                "completedAt": iso_now(),
                "observedTaskDefinitionArn": observed["taskDefinitionArn"],
            }
        )
        aws.put_parameter(operation_path, operation)
        aws.put_parameter(pending_path, operation)
        if plan.get("operation") == "resume" and plan.get("resumeService") == key:
            clear_hold(aws, config, key, manifest["manifestId"], operation_id)
        print(f"{key}: succeeded at {image['digest']}")
    except Exception as error:
        original = (
            error
            if isinstance(error, ReleaseError)
            else ReleaseError(f"Unexpected reconciliation failure ({type(error).__name__}): {error}")
        )
        operation.update({"status": "failed", "failedAt": iso_now(), "error": str(original)[:500]})
        aws.put_parameter(operation_path, operation)
        aws.put_parameter(pending_path, operation)
        if mutation_started or recovering_mutation:
            rollback_snapshot = dict(before)
            rollback_snapshot["taskDefinitionArn"] = rollback_task_definition
            rollback_snapshot["image"] = rollback_image
            write_hold(
                aws,
                config,
                key,
                rollback_snapshot,
                reason=f"automatic rollback after coordinated release failure: {original}",
                operation_id=operation_id,
                manifest_id=manifest["manifestId"],
            )
            try:
                aws.update_service(key, rollback_task_definition)
                operation.update({"status": "rolled-back-held", "rollbackCompletedAt": iso_now()})
                aws.put_parameter(operation_path, operation)
                aws.put_parameter(pending_path, operation)
            except ReleaseError as rollback_error:
                fail(f"{original}; rollback also failed: {rollback_error}")
        raise original


def finalize_release(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    manifest = read_json(args.manifest)
    plan = read_json(args.plan)
    aws = Aws(CommandRunner(), config)
    finalize_release_with_dependencies(args, config, manifest, plan, aws, validate_manifest)


def finalize_release_with_dependencies(
    args: argparse.Namespace,
    config: dict[str, Any],
    manifest: dict[str, Any],
    plan: dict[str, Any],
    aws: Aws,
    validate: Callable[[dict[str, Any], dict[str, Any]], None],
) -> None:
    validate(manifest, config)
    rows = []
    failures = []
    actual_rollouts = 0
    rollback_count = 0
    unresolved_holds = 0
    for key in config["services"]:
        snapshot = aws.service_snapshot(key)
        desired = manifest["services"][key]["digest"]
        hold = active_hold(aws, config, key)
        if hold:
            unresolved_holds += 1
        provenance = validate_provenance(
            aws.get_parameter(state_path(config, f"services/{key}/provenance")), config, key
        )
        operation_record = aws.get_parameter(state_path(config, f"operations/{plan['operationId']}/{key}"))
        if operation_record and operation_record.get("deployedTaskDefinitionArn"):
            actual_rollouts += 1
        if operation_record and operation_record.get("status") == "rolled-back-held":
            rollback_count += 1
        live_matches = snapshot["digest"] == desired
        proven = bool(
            provenance
            and provenance.get("manifestId") == manifest["manifestId"]
            and provenance.get("digest") == desired
            and provenance.get("taskDefinitionArn") == snapshot["taskDefinitionArn"]
        )
        planned = plan["services"][key]["action"]
        status = final_service_status(
            operation=plan.get("operation", "ordinary"),
            order=plan["order"],
            planned=planned,
            live_matches=live_matches,
            proven=proven,
            held=bool(hold),
        )
        if status not in {"succeeded", "superseded", "not-selected"}:
            failures.append(key)
        rows.append((key, status, desired, snapshot["digest"] or snapshot["image"]))
    if rows and all(status == "succeeded" for _, status, _, _ in rows):
        for barrier in manifest["barriers"]:
            if barrier["requiredCheckpointManifestId"] == manifest["manifestId"]:
                aws.put_parameter(
                    state_path(config, f"checkpoint-completions/{barrier['id']}"),
                    {
                        "schemaVersion": 1,
                        "barrierId": barrier["id"],
                        "checkpointManifestId": manifest["manifestId"],
                        "evidenceRequirementSha256": sha256_bytes(
                            barrier["evidenceRequirement"].encode()
                        ),
                        "completedAt": iso_now(),
                        "operationId": require_id(plan["operationId"], "plan.operationId"),
                    },
                )
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    now = dt.datetime.now(dt.timezone.utc)
    published_at = parse_time(plan["publishedAt"], "plan.publishedAt")
    prepared_at = parse_time(plan["preparedAt"], "plan.preparedAt")
    lines = [
        "## Coordinated release result",
        "",
        f"- Manifest: `{manifest['manifestId']}`",
        f"- Source: `{manifest['source']['sha']}`",
        f"- Order: `{plan['order']}`",
        f"- ECS rollout count planned: `{sum(v['action'] == 'deploy' for v in plan['services'].values())}`",
        f"- ECS rollout count actual: `{actual_rollouts}`",
        f"- Publication-to-result seconds: `{max(0, int((now - published_at).total_seconds()))}`",
        f"- Reconciliation seconds: `{max(0, int((now - prepared_at).total_seconds()))}`",
        f"- Superseded ordinary requests: `{1 if plan['order'] == 'stale' else 0}`",
        f"- Service failures/rollbacks: `{len(failures)}/{rollback_count}`",
        f"- Unresolved holds: `{unresolved_holds}`",
        "",
        "| Service | Result | Desired digest | Observed digest/image |",
        "|---|---|---|---|",
    ]
    lines.extend(f"| `{key}` | {status} | `{desired}` | `{observed}` |" for key, status, desired, observed in rows)
    output = "\n".join(lines) + "\n"
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(output)
    print(output)
    if failures:
        fail("Release is not fully deployed; unresolved services: " + ", ".join(failures))


def guard_legacy(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    if args.service not in config["services"]:
        return
    aws = Aws(CommandRunner(), config)
    if args.event_name == "repository_dispatch":
        if ownership_mode(aws, config) == "batch":
            fail(f"Stale legacy automatic event rejected for batch-managed service {args.service}")
        if aws.get_parameter(state_path(config, "desired-release")) is not None:
            fail("Legacy automatic delivery remains fenced after coordinated ownership; use explicit held recovery")
        return
    if args.event_name != "workflow_dispatch":
        fail("Managed service mutation has an unsupported event source")
    snapshot = aws.service_snapshot(args.service)
    write_hold(
        aws,
        config,
        args.service,
        snapshot,
        reason=args.reason,
        operation_id=args.operation_id,
        manifest_id=None,
    )


def hold_before_rollback(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    if args.service not in config["services"]:
        return
    aws = Aws(CommandRunner(), config)
    snapshot = aws.service_snapshot(args.service)
    if args.rollback_task_definition:
        physical = config["services"][args.service]
        prefix = (
            f"arn:aws:ecs:{config['deployment']['region']}:{config['deployment']['accountId']}:"
            f"task-definition/{physical['taskFamily']}:"
        )
        if not args.rollback_task_definition.startswith(prefix):
            fail("Rollback task definition is outside the configured physical identity")
        expected_repository = (
            f"{config['deployment']['accountId']}.dkr.ecr.{config['deployment']['region']}.amazonaws.com/"
            f"{physical['ecrRepository']}"
        )
        validate_ecr_image_reference(
            args.rollback_image, expected_repository, f"rollback image for {args.service}"
        )
        snapshot["taskDefinitionArn"] = args.rollback_task_definition
        snapshot["image"] = args.rollback_image
    write_hold(
        aws,
        config,
        args.service,
        snapshot,
        reason=args.reason,
        operation_id=args.operation_id,
        manifest_id=args.manifest_id,
    )


def control(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    aws = Aws(CommandRunner(), config)
    operation_id = require_id(args.operation_id, "operationId")
    if args.action == "set-mode":
        if args.mode not in {"legacy", "batch"}:
            fail("set-mode requires legacy or batch")
        if args.mode == "batch" and aws.get_parameter(state_path(config, "desired-release")) is None:
            fail("Cannot enable batch mode before an exact desired release is bootstrapped")
        aws.put_parameter(
            state_path(config, "ownership-mode"),
            {"schemaVersion": 1, "mode": args.mode, "changedAt": iso_now(), "operationId": operation_id},
        )
    elif args.action == "hold":
        if args.service not in config["services"]:
            fail("Hold must name one configured physical service")
        write_hold(
            aws,
            config,
            args.service,
            aws.service_snapshot(args.service),
            reason=args.reason,
            operation_id=operation_id,
            manifest_id=None,
        )
    elif args.action == "acknowledge":
        barrier_id = args.barrier_id
        if not isinstance(barrier_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", barrier_id):
            fail("barrierId must match the v1 contract")
        introduced_at = require_sha(args.introduced_at, "introducedAt")
        if args.kind not in {"migration", "backfill", "application"}:
            fail("Unknown checkpoint kind")
        if not args.evidence.strip() or not args.evidence_requirement.strip():
            fail("Checkpoint evidence and requirement must be non-empty")
        checkpoint = args.checkpoint_manifest_id or None
        if checkpoint:
            if not re.fullmatch(r"vayada-release/v1/[0-9a-f]{40}/[1-9][0-9]*/[1-9][0-9]*", checkpoint):
                fail("checkpointManifestId must match the v1 contract")
        record = {
            "schemaVersion": 1,
            "barrierId": barrier_id,
            "kind": args.kind,
            "introducedAt": introduced_at,
            "checkpointManifestId": checkpoint,
            "evidenceRequirementSha256": sha256_bytes(args.evidence_requirement.encode()),
            "evidence": args.evidence,
            "evidenceSha256": sha256_bytes(args.evidence.encode()),
            "acknowledgedAt": iso_now(),
            "operationId": operation_id,
        }
        aws.put_parameter(state_path(config, f"checkpoints/{barrier_id}"), record)
    else:
        fail("Unknown control action")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    root.add_argument("--config", default=str(DEFAULT_CONFIG))
    commands = root.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare")
    prepare.add_argument("--artifact-id", type=int, required=True)
    prepare.add_argument("--manifest-sha256")
    prepare.add_argument("--published-record-sha256")
    prepare.add_argument("--dispatch-json")
    prepare.add_argument("--operation", choices=("ordinary", "resume", "activate", "verify"), required=True)
    prepare.add_argument("--service")
    prepare.add_argument("--operation-id", required=True)
    prepare.add_argument("--output-dir", required=True)
    prepare.set_defaults(func=prepare_release)

    reconcile = commands.add_parser("reconcile-service")
    reconcile.add_argument("--manifest", required=True)
    reconcile.add_argument("--plan", required=True)
    reconcile.add_argument("--service", required=True)
    reconcile.set_defaults(func=reconcile_service)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--manifest", required=True)
    finalize.add_argument("--plan", required=True)
    finalize.set_defaults(func=finalize_release)

    legacy = commands.add_parser("guard-legacy")
    legacy.add_argument("--service", required=True)
    legacy.add_argument("--event-name", required=True)
    legacy.add_argument("--operation-id", required=True)
    legacy.add_argument("--reason", default="explicit manual managed-service mutation")
    legacy.set_defaults(func=guard_legacy)

    rollback = commands.add_parser("hold-before-rollback")
    rollback.add_argument("--service", required=True)
    rollback.add_argument("--operation-id", required=True)
    rollback.add_argument("--reason", required=True)
    rollback.add_argument("--manifest-id")
    rollback.add_argument("--rollback-task-definition")
    rollback.add_argument("--rollback-image", default="")
    rollback.set_defaults(func=hold_before_rollback)

    manage = commands.add_parser("control")
    manage.add_argument("--action", choices=("set-mode", "hold", "acknowledge"), required=True)
    manage.add_argument("--operation-id", required=True)
    manage.add_argument("--mode", choices=("legacy", "batch"))
    manage.add_argument("--service")
    manage.add_argument("--reason", default="explicit operator hold")
    manage.add_argument("--barrier-id")
    manage.add_argument("--kind")
    manage.add_argument("--introduced-at")
    manage.add_argument("--checkpoint-manifest-id")
    manage.add_argument("--evidence-requirement", default="")
    manage.add_argument("--evidence", default="")
    manage.set_defaults(func=control)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        args.func(args)
        return 0
    except ReleaseError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
