#!/usr/bin/env python3
"""Release train deploy (VAY-2311): the platform half of the release train.

The app's "Release train" workflow settles main, prechecks and publishes a release, then sends a
`release-train` repository_dispatch with the release identity. release-train-deploy.yml runs these
steps on it, each idempotent so a rerun picks up where the last one stopped:

  validate  the request (a repository_dispatch must come from the app's release-train.yml run on
            main), then the publication itself: `coordinated_release.py prepare --operation
            verify` checks the trusted publisher, both content hashes, ancestry and every ECR image
            without touching deployment state;
  admit     lists the release's API digest in the two next-api compatible-image lists, as the
            admission PR of release.sh did. Already listed: nothing to do. Mode "push" commits to
            main after the same list tests as the VAY-2287 automatic admission; mode "pr" pushes a
            branch for a person to open and merge as a PR, then waits until main lists the digest
            (GITHUB_TOKEN can neither open a PR nor start its CI);
  deploy    dispatches the ordinary coordinated deploy of the exact artifact and waits for it,
            unless desired-release already names the sha and every live digest matches;
  verify    the live digests equal the release's manifest (or, when a newer accepted release
            superseded it, that release's manifest), no 42501 / "permission denied" / level >= 50
            log lines since the deploy began, and next-api health 200.

A dry run reads everything and changes nothing: no commit, no branch, no dispatch.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("coordinated_release", ROOT / "scripts" / "coordinated_release.py")
release = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader
_SPEC.loader.exec_module(release)

APP_REPOSITORY = "vayada-marketplace/vayada"
TRAIN_WORKFLOW_PATH = ".github/workflows/release-train.yml"
DEPLOY_WORKFLOW = "deploy-coordinated-release.yml"
# The deploy workflow's automatic-admission job runs only for repository_dispatch events, so an
# ordinary workflow_dispatch deploy always skips it (the first real train, 2026-10-23, read that
# skip as a failure after a correct deploy).
SKIPPED_ON_DISPATCH = {"Admit the API image automatically"}
API_SERVICE = "next-target-backend"
LISTS = ("scripts/next-api-split-compatible-images.txt", "scripts/next-api-ongoing-export-compatible-images.txt")
# Every Terraform Validate suite that reads the lists, as the VAY-2287 admit job runs them.
LIST_TESTS = (
    ("python3", "scripts/test-next-api-split-compatible-image.py"),
    ("python3", "-m", "unittest", "scripts/test_coordinated_release.py"),
    ("python3", "scripts/test-target-database-split-deployment-ready.py"),
    ("python3", "scripts/test-finance-export-once.py"),
    ("node", "--test", "scripts/test-legacy-migration-oneoff.mjs"),
)
LOG_GROUP = "/ecs/vayada-next-api"
LOG_PATTERNS = ('"42501"', '"permission denied"', "{ $.level >= 50 }")
HEALTH_URL = "https://next-api.vayada.com/health"
SHA = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class TrainError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise TrainError(message)


def retry(call: Callable[[], Any], *, what: str, attempts: int = 5, sleep: Callable[[float], None] = time.sleep) -> Any:
    """Reads only: GitHub and AWS endpoint blips must not end a release (2026-10-21/22)."""
    for attempt in range(1, attempts + 1):
        try:
            return call()
        except (TrainError, release.ReleaseError, OSError, urllib.error.URLError) as error:
            if attempt == attempts:
                raise TrainError(f"{what}: {error}") from error
            print(f"{what} failed ({error}); retry {attempt}/{attempts - 1}", file=sys.stderr)
            sleep(min(60, 2 * 2 ** (attempt - 1)))


# ---------------------------------------------------------------- the request
def read_request(event_name: str, event: dict[str, Any]) -> dict[str, Any]:
    """The release to run, from a repository_dispatch payload or the workflow_dispatch inputs."""
    if event_name == "repository_dispatch":
        payload = event.get("client_payload") or {}
        if payload.get("schemaVersion") != 1:
            fail("unknown release-train payload schemaVersion")
        identity = payload.get("release") or {}
        app_run = payload.get("appRun") or {}
        request = {
            "sha": identity.get("sha"),
            "artifactId": identity.get("artifactId"),
            "manifestSha256": identity.get("manifestSha256"),
            "publishedRecordSha256": identity.get("publishedRecordSha256"),
            "summary": payload.get("summary"),
            "dryRun": payload.get("dryRun"),
            "admission": payload.get("admission"),
            "appRunId": app_run.get("id"),
            "appRunUrl": app_run.get("url"),
        }
    elif event_name == "workflow_dispatch":
        inputs = event.get("inputs") or {}
        artifact = str(inputs.get("published_artifact_id", ""))
        request = {
            "sha": inputs.get("sha"),
            "artifactId": int(artifact) if artifact.isdigit() else artifact,
            "manifestSha256": inputs.get("manifest_sha256"),
            "publishedRecordSha256": inputs.get("published_record_sha256"),
            "summary": inputs.get("summary"),
            # workflow_dispatch booleans arrive as strings in the event payload.
            "dryRun": str(inputs.get("dry_run", "true")).lower() == "true",
            "admission": inputs.get("admission", "push"),
            "appRunId": None,
            "appRunUrl": None,
        }
    else:
        fail(f"unsupported event {event_name}")
    if not isinstance(request["sha"], str) or not SHA.fullmatch(request["sha"]):
        fail("release sha must be a full 40-character sha")
    if isinstance(request["artifactId"], bool) or not isinstance(request["artifactId"], int) or request["artifactId"] < 1:
        fail("published artifact id must be a positive integer")
    for field in ("manifestSha256", "publishedRecordSha256"):
        if not isinstance(request[field], str) or not HEX64.fullmatch(request[field]):
            fail(f"{field} must be 64 hex characters")
    if not isinstance(request["summary"], str) or not request["summary"].strip() or "\n" in request["summary"]:
        fail("summary must be one non-empty line")
    if not isinstance(request["dryRun"], bool):
        fail("dryRun must be a boolean")
    if request["admission"] not in ("pr", "push"):
        fail("admission must be pr or push")
    if event_name == "repository_dispatch" and (
        isinstance(request["appRunId"], bool) or not isinstance(request["appRunId"], int) or request["appRunId"] < 1
    ):
        fail("appRun.id must be a positive integer")
    return request


def app_run_problems(run: dict[str, Any]) -> list[str]:
    """A repository_dispatch is trusted only from the app's release-train.yml, dispatched on main."""
    problems = []
    if run.get("path") != TRAIN_WORKFLOW_PATH:
        problems.append(f"run is {run.get('path')}, not {TRAIN_WORKFLOW_PATH}")
    if run.get("head_branch") != "main":
        problems.append(f"run is on {run.get('head_branch')}, not main")
    if run.get("event") != "workflow_dispatch":
        problems.append(f"run event is {run.get('event')}, not workflow_dispatch")
    if (run.get("repository") or {}).get("full_name") != APP_REPOSITORY:
        problems.append("run is not in the app repository")
    return problems


# ---------------------------------------------------------------- platform GitHub (own repository)
class PlatformGitHub:
    """This repository's API with the workflow's GITHUB_TOKEN; every call has a timeout."""

    def __init__(self, repository: str, token: str, *, sleep: Callable[[float], None] = time.sleep):
        if not token:
            fail("GITHUB_TOKEN is required")
        self.repository = repository
        self.token = token
        self.sleep = sleep

    def _request(self, method: str, path: str, body: Any = None, accept: str = "application/vnd.github+json") -> bytes:
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repository}{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Accept": accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vayada-release-train"},
        )
        if body is not None:
            request.add_header("Content-Type", "application/json")
        # Signed artifact download URLs authenticate themselves; never forward the token there.
        request.add_unredirected_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read(20_000_001)
        except urllib.error.HTTPError as error:
            fail(f"GitHub {method} {path}: HTTP {error.code}")

    def get(self, path: str) -> Any:
        return retry(lambda: json.loads(self._request("GET", path) or b"null"), what=f"GET {path}", sleep=self.sleep)

    def download(self, path: str) -> bytes:
        return retry(lambda: self._request("GET", path), what=f"GET {path}", sleep=self.sleep)

    def post_once(self, path: str, body: Any) -> None:
        """Sent once: a retried dispatch could start a second deploy run."""
        try:
            self._request("POST", path, body)
        except (OSError, urllib.error.URLError) as error:
            fail(f"POST {path}: {error}; the request may have arrived")


# ---------------------------------------------------------------- admission
def listed(text: str) -> set[str]:
    return {line.split()[1] for line in text.splitlines() if line.strip() and not line.startswith("#")}


def missing_lists(root: Path, digest: str) -> list[str]:
    return [name for name in LISTS if digest not in listed((root / name).read_text())]


def admitted_on_main(root: Path, digest: str, sleep: Callable[[float], None] = time.sleep) -> bool:
    """Whether origin/main lists the digest: the remote decides, never this checkout's commits."""
    retry(lambda: git("fetch", "-q", "origin", "main", cwd=root), what="git fetch main", sleep=sleep)
    return all(digest in listed(git("show", f"origin/main:{name}", cwd=root)) for name in LISTS)


def git(*args: str, cwd: Path = ROOT) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, timeout=300)
    if result.returncode:
        fail(f"git {' '.join(args[:2])}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def run_list_tests(root: Path = ROOT) -> None:
    for command in LIST_TESTS:
        result = subprocess.run(list(command), cwd=root, text=True, capture_output=True, timeout=900)
        if result.returncode:
            fail(f"{' '.join(command)} failed after admission:\n{(result.stdout + result.stderr)[-3000:]}")


def append_admission(root: Path, sha: str, digest: str) -> list[str]:
    changed = missing_lists(root, digest)
    for name in changed:
        with (root / name).open("a") as handle:
            handle.write(f"{sha} {digest}\n")
    return changed


def admission_branch(sha: str) -> str:
    return f"release-train/admit-{sha[:9]}"


def commit_admission(root: Path, request: dict[str, Any], digest: str, changed: list[str], run_url: str) -> None:
    git("config", "user.name", "github-actions[bot]", cwd=root)
    git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com", cwd=root)
    git("add", *changed, cwd=root)
    git(
        "commit", "-q",
        "-m", f"[VAY-965] Admit next-{request['sha'][:9]} to the next-api compatible-image lists",
        "-m", f"{request['summary']}\n\nAPI digest {digest}. Release train run {run_url}"
              + (f", app run {request['appRunUrl']}" if request.get("appRunUrl") else "") + ".",
        cwd=root,
    )


def admit(request: dict[str, Any], digest: str, *, root: Path, run_url: str, wait_minutes: int,
          sleep: Callable[[float], None] = time.sleep, now: Callable[[], float] = time.time) -> str:
    """Returns what happened, for the summary."""
    if admitted_on_main(root, digest, sleep):
        return f"{digest} is already admitted on main"
    if request["dryRun"]:
        return f"dry run: would admit {digest} ({'push to main' if request['admission'] == 'push' else 'admission PR'})"
    if request["admission"] == "push":
        for _ in range(3):
            git("checkout", "-q", "--detach", "origin/main", cwd=root)
            changed = append_admission(root, request["sha"], digest)
            run_list_tests(root)
            commit_admission(root, request, digest, changed, run_url)
            push = subprocess.run(["git", "push", "origin", "HEAD:main"], cwd=root, text=True, capture_output=True, timeout=120)
            if push.returncode == 0:
                return f"admitted {digest} on main ({', '.join(changed)})"
            # Someone pushed meanwhile: start again from the new main.
            git("checkout", "-q", "--force", "--detach", "origin/main", cwd=root)
            if admitted_on_main(root, digest, sleep):
                return f"{digest} was admitted on main meanwhile"
        fail("could not push the admission to main")
    branch = admission_branch(request["sha"])
    remote = subprocess.run(["git", "ls-remote", "--exit-code", "origin", f"refs/heads/{branch}"],
                            cwd=root, text=True, capture_output=True, timeout=60)
    if remote.returncode != 0:
        git("checkout", "-q", "--detach", "origin/main", cwd=root)
        changed = append_admission(root, request["sha"], digest)
        run_list_tests(root)
        commit_admission(root, request, digest, changed, run_url)
        git("push", "-q", "origin", f"HEAD:refs/heads/{branch}", cwd=root)
        git("checkout", "-q", "--detach", "origin/main", cwd=root)
    compare = f"https://github.com/{os.environ.get('GITHUB_REPOSITORY', 'vayada-marketplace/vayada-platform')}/compare/main...{branch}?expand=1"
    summary(f"### Admission PR needed\n\nOpen and merge the admission PR from `{branch}`: {compare}\n"
            f"This run waits up to {wait_minutes} min for main to list `{digest}`.\n")
    print(f"::notice title=Admission PR needed::Open and merge {compare}")
    deadline = now() + wait_minutes * 60
    while True:
        if admitted_on_main(root, digest, sleep):
            return f"admitted {digest} through the admission PR from {branch}"
        if now() >= deadline:
            fail(f"main does not list {digest} after {wait_minutes} min; merge the admission PR, then rerun")
        sleep(30)


# ---------------------------------------------------------------- deploy
def live_digests(aws: Any, config: dict[str, Any]) -> dict[str, str]:
    return {key: retry(lambda key=key: aws.service_snapshot(key)["digest"], what=f"read live {key}") for key in config["services"]}


def desired_release(aws: Any, config: dict[str, Any]) -> dict[str, Any] | None:
    return retry(lambda: aws.get_parameter(release.state_path(config, "desired-release")), what="read desired-release")


def find_deploy_run(github: PlatformGitHub, artifact_id: int, since: str, *, polls: int = 30,
                    sleep: Callable[[float], None] = time.sleep) -> dict[str, Any] | None:
    """The deploy run this train dispatched: a workflow_dispatch run started by github-actions
    after `since`. Its plan artifact later proves the artifact id (check_plan)."""
    for _ in range(polls):
        sleep(10)
        runs = github.get(f"/actions/workflows/{DEPLOY_WORKFLOW}/runs?event=workflow_dispatch&created=%3E%3D{since}&per_page=20")
        mine = [run for run in runs.get("workflow_runs", []) if (run.get("triggering_actor") or {}).get("login") == "github-actions[bot]"]
        if mine:
            return max(mine, key=lambda run: run["created_at"])
    return None


def wait_run(github: PlatformGitHub, run_id: int, *, minutes: int, sleep: Callable[[float], None] = time.sleep,
             now: Callable[[], float] = time.time) -> dict[str, Any]:
    deadline = now() + minutes * 60
    while True:
        run = github.get(f"/actions/runs/{run_id}")
        if run.get("status") == "completed":
            return run
        if now() >= deadline:
            fail(f"deploy run {run_id} not finished after {minutes} min")
        sleep(30)


def plan_of(github: PlatformGitHub, run: dict[str, Any]) -> dict[str, Any]:
    name = f"coordinated-release-plan-{run['id']}-{run['run_attempt']}"
    artifacts = github.get(f"/actions/runs/{run['id']}/artifacts?per_page=50").get("artifacts", [])
    matches = [artifact for artifact in artifacts if artifact.get("name") == name]
    if len(matches) != 1:
        fail(f"deploy run {run['id']} has no {name} artifact")
    archive = zipfile.ZipFile(io.BytesIO(github.download(f"/actions/artifacts/{matches[0]['id']}/zip")))
    return json.loads(archive.read("plan.json"))


def check_plan(plan: dict[str, Any], request: dict[str, Any]) -> None:
    if plan.get("artifactId") != request["artifactId"] or plan.get("sourceSha") != request["sha"]:
        fail(f"the deploy run planned artifact {plan.get('artifactId')} of {plan.get('sourceSha')}, not this release")
    if plan.get("manifestSha256") != request["manifestSha256"] or plan.get("publishedRecordSha256") != request["publishedRecordSha256"]:
        fail("the deploy run planned other publication bytes")


def deploy_problems(conclusion: str | None, jobs: list[tuple[str, str]]) -> list[str]:
    """Why a finished ordinary deploy run did not succeed; empty when it did. Every job must
    succeed, except the automatic-admission job a workflow_dispatch skips by design."""
    problems = [] if conclusion == "success" else [f"run {conclusion}"]
    problems += [f"{name}: {state}" for name, state in jobs
                 if state != "success" and not (state == "skipped" and name in SKIPPED_ON_DISPATCH)]
    if not jobs:
        problems.append("no job detail")
    return problems


def run_jobs(github: PlatformGitHub, run: dict[str, Any]) -> list[tuple[str, str]]:
    jobs = github.get(f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100").get("jobs", [])
    return [(job["name"], job.get("conclusion") or job.get("status")) for job in jobs]


# ---------------------------------------------------------------- verify
def expected_digests(plan_order: str | None, manifest: dict[str, Any], desired: dict[str, Any] | None,
                     compare: Callable[[str, str], str], superseding_manifest: Callable[[dict[str, Any]], dict[str, Any]]) -> tuple[dict[str, str], str]:
    """The digests that must be live: this release's, or those of the newer accepted release that
    superseded it (an ordinary deploy of an older sha skips as stale, and that is correct only when
    the accepted release contains this one)."""
    own = {key: image["digest"] for key, image in manifest["services"].items()}
    sha = manifest["source"]["sha"]
    if desired is None or desired.get("sourceSha") == sha:
        return own, "this release"
    if compare(sha, desired["sourceSha"]) != "ahead":
        fail(f"desired-release {desired['sourceSha'][:9]} does not contain {sha[:9]} (order {plan_order})")
    newer = superseding_manifest(desired)
    return {key: image["digest"] for key, image in newer["services"].items()}, f"superseded by {desired['sourceSha'][:9]}"


def count_log_events(pattern: str, start_ms: int, region: str) -> int | None:
    """Matching next-api log events since start_ms; None when the role may not read the logs."""
    result = subprocess.run(
        ["aws", "logs", "filter-log-events", "--log-group-name", LOG_GROUP, "--start-time", str(start_ms),
         "--filter-pattern", pattern, "--query", "events[].eventId", "--output", "json", "--region", region],
        text=True, capture_output=True, timeout=300,
    )
    if result.returncode:
        if "AccessDenied" in result.stderr:
            return None
        fail(f"filter-log-events {pattern}: {result.stderr.strip()[:300]}")
    return len(json.loads(result.stdout or "[]") or [])


def health_status(url: str = HEALTH_URL) -> int:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "vayada-release-train"}), timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


# ---------------------------------------------------------------- summary
def summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print(text)


def output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def iso(timestamp: float) -> str:
    return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- commands
def command_validate(args: argparse.Namespace) -> None:
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    request = read_request(os.environ["GITHUB_EVENT_NAME"], event)
    token = os.environ.get("COORDINATED_RELEASE_READ_TOKEN", "")
    if request["appRunId"] is not None:
        app = release.GitHub(APP_REPOSITORY, token)
        problems = app_run_problems(retry(lambda: app.json(f"/actions/runs/{request['appRunId']}"), what="read the app run"))
        if problems and not request["dryRun"]:
            fail("the release-train event did not come from the app's release train on main: " + "; ".join(problems))
        for problem in problems:
            print(f"::warning title=Dry run from an untrusted app run::{problem}")
    output_dir = Path(args.output_dir)
    retry(lambda: release.prepare_release(argparse.Namespace(
        config=release.DEFAULT_CONFIG, artifact_id=request["artifactId"], manifest_sha256=request["manifestSha256"],
        published_record_sha256=request["publishedRecordSha256"], dispatch_json=None, operation="verify",
        service=None, operation_id=f"release-train-{os.environ.get('GITHUB_RUN_ID', 'local')}", output_dir=str(output_dir),
    )), what="verify the publication", attempts=3)
    manifest = json.loads((output_dir / "manifest.json").read_text())
    if manifest["source"]["sha"] != request["sha"]:
        fail(f"the publication is for {manifest['source']['sha']}, not {request['sha']}")
    (output_dir / "request.json").write_text(json.dumps(request, indent=2) + "\n")
    summary("\n".join([
        f"## Release train deploy{' (dry run)' if request['dryRun'] else ''}", "",
        request["summary"], "",
        f"- sha: `{request['sha']}`",
        f"- published artifact: `{request['artifactId']}` (publication, hashes, ancestry and ECR images verified)",
        f"- admission: {request['admission']}" + (f"; app run {request['appRunUrl']}" if request["appRunUrl"] else ""),
    ]))
    output("dry_run", "true" if request["dryRun"] else "false")


def command_admit(args: argparse.Namespace) -> None:
    bundle = Path(args.bundle)
    request = json.loads((bundle / "request.json").read_text())
    digest = json.loads((bundle / "manifest.json").read_text())["services"][API_SERVICE]["digest"]
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    result = admit(request, digest, root=ROOT, run_url=run_url, wait_minutes=args.wait_minutes)
    summary(f"- admission: {result}")


def command_deploy_verify(args: argparse.Namespace) -> None:
    bundle = Path(args.bundle)
    request = json.loads((bundle / "request.json").read_text())
    manifest = json.loads((bundle / "manifest.json").read_text())
    config = release.load_config()
    aws = release.Aws(release.CommandRunner(), config)
    region = config["deployment"]["region"]
    own = {key: image["digest"] for key, image in manifest["services"].items()}
    desired = desired_release(aws, config)
    live = live_digests(aws, config)
    started = time.time()
    plan_order = None
    live_error = ""
    rows = []
    already = desired is not None and desired.get("sourceSha") == request["sha"] and live == own
    if already:
        rows.append(("deploy", "done", "desired-release names this sha and every live digest matches; nothing to dispatch"))
        # Check the logs since the release was accepted, not since this rerun started.
        started = dt.datetime.strptime(desired["acceptedAt"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp()
    elif request["dryRun"]:
        rows.append(("deploy", "skipped", f"dry run: would dispatch the ordinary deploy (desired-release {str((desired or {}).get('sourceSha'))[:9]})"))
    else:
        github = PlatformGitHub(os.environ["GITHUB_REPOSITORY"], os.environ.get("GH_TOKEN", ""))
        since = iso(time.time() - 60)
        try:
            github.post_once(f"/actions/workflows/{DEPLOY_WORKFLOW}/dispatches", {"ref": "main", "inputs": {
                "operation": "ordinary", "published_artifact_id": str(request["artifactId"]),
                "manifest_sha256": request["manifestSha256"], "published_record_sha256": request["publishedRecordSha256"],
                "service": "none",
            }})
        except TrainError as error:
            # A lost reply does not mean no run: look for one before giving up, never dispatch twice.
            print(f"::warning::{error}", file=sys.stderr)
        run = find_deploy_run(github, request["artifactId"], since)
        if run is None:
            fail("found no deploy run after the dispatch; check the deploy workflow before any retry")
        print(f"deploy run {run['html_url']}")
        started = dt.datetime.strptime(run["created_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp()
        run = wait_run(github, run["id"], minutes=args.deploy_minutes)
        try:
            problems = deploy_problems(run.get("conclusion"), run_jobs(github, run))
        except TrainError as error:
            problems = ([] if run.get("conclusion") == "success" else [f"run {run.get('conclusion')}"]) \
                + [f"could not read the deploy jobs: {error}"]
        plan: dict[str, Any] = {}
        try:
            plan = plan_of(github, run)
            check_plan(plan, request)
            plan_order = plan.get("order")
        except TrainError as error:
            problems.append(str(error))
        rows.append(("deploy", "failed" if problems else "done",
                     f"{run['html_url']} order {plan_order}, acceptance {plan.get('acceptance', '-')}"
                     + (f"; {', '.join(problems)}" if problems else "")))
        # Verify either way: after a failed deploy the live digests, logs and health say what is
        # live. Logs written right after the rollout belong to it (admit-and-deploy.sh waited too).
        time.sleep(150)
        # Fresh state or none: the pre-dispatch snapshot must never pass for the deployed one.
        try:
            desired = desired_release(aws, config)
            live = live_digests(aws, config)
        except TrainError as error:
            desired, live, live_error = None, None, str(error)

    app = release.GitHub(APP_REPOSITORY, os.environ.get("COORDINATED_RELEASE_READ_TOKEN", ""))

    def superseding(record: dict[str, Any]) -> dict[str, Any]:
        directory = bundle / "superseding"
        retry(lambda: app.download_bundle(int(record["artifactId"]), directory), what="download the superseding release")
        return json.loads((directory / "manifest.json").read_text())

    try:
        if live is None:
            fail(f"could not read the live state after the deploy: {live_error}")
        if request["dryRun"] and not already:
            expected, against = own, "this release (not deployed yet in a dry run)"
        else:
            expected, against = expected_digests(plan_order, manifest, desired, lambda base, head: retry(lambda: app.compare(base, head), what="compare"), superseding)
        mismatched = [f"{key} live {live.get(key, '-')[:19]} != {digest[:19]}" for key, digest in expected.items() if live.get(key) != digest]
        rows.append(("live digests", "done" if not mismatched else ("info" if request["dryRun"] else "failed"),
                     f"match {against}" if not mismatched else "; ".join(mismatched)))
    except TrainError as error:
        # E.g. a failed deploy left desired-release on an older release: report, keep checking.
        rows.append(("live digests", "failed", str(error)))
    start_ms = int((started - 60) * 1000)
    counts = {pattern: retry(lambda pattern=pattern: count_log_events(pattern, start_ms, region), what=f"logs {pattern}") for pattern in LOG_PATTERNS}
    unreadable = [pattern for pattern, count in counts.items() if count is None]
    noisy = [f"{pattern}: {count}" for pattern, count in counts.items() if count]
    if unreadable:
        rows.append(("logs", "not checked", "the deploy role may not read CloudWatch Logs yet (VAY-2311 infra PR); check by hand"))
    else:
        rows.append(("logs", "done" if not noisy else ("info" if request["dryRun"] else "failed"),
                     "; ".join(noisy) or f"0 x {', '.join(LOG_PATTERNS)} since {iso(start_ms / 1000)}"))
    status = 0
    for _ in range(3):
        status = health_status()
        if status == 200:
            break
        time.sleep(10)
    rows.append(("health", "done" if status == 200 else "failed", f"{HEALTH_URL} {status}"))
    render(rows)
    if not request["dryRun"] and any(state == "failed" for _, state, _ in rows):
        fail("the release is not verified")


def render(rows: list[tuple[str, str, str]]) -> None:
    summary("\n".join(["", "| Step | Result | Detail |", "| --- | --- | --- |",
                       *(f"| {name} | {state} | {detail.replace('|', '/')} |" for name, state, detail in rows)]))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", required=True)
    validate.set_defaults(func=command_validate)
    admit_command = commands.add_parser("admit")
    admit_command.add_argument("--bundle", required=True)
    admit_command.add_argument("--wait-minutes", type=int, default=120)
    admit_command.set_defaults(func=command_admit)
    deploy = commands.add_parser("deploy-verify")
    deploy.add_argument("--bundle", required=True)
    deploy.add_argument("--deploy-minutes", type=int, default=90)
    deploy.set_defaults(func=command_deploy_verify)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        args.func(args)
        return 0
    except (TrainError, release.ReleaseError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
