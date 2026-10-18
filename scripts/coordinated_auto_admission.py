#!/usr/bin/env python3
"""Automatic next-api image admission (VAY-2287).

deploy-coordinated-release.yml runs this only when the repository variable
AUTO_ADMIT_NEXT_API_IMAGES is "true" and an automatic (repository_dispatch) release skipped
reconciliation because its API image is not admitted yet. By then its prepare job has validated
the publication: published by the app repository's release workflow from main, with the manifest
and record digests and the source ancestry checked. This admits that image the way the reviewed
admission PR did (release.sh), only when every gate holds:

  - plan order "new": a stale or repeated release is left alone;
  - the source commit had a green merge-queue run of PR Checks in which every job succeeded and
    none was skipped, with at least MIN_JOBS jobs and both PostgreSQL versions of every leg. The
    queue fast-forwards app main to exactly that commit, so this is the release precheck;
  - no release-train-hold issue is open in the app repository (a manual release owns admission);
  - the source commit is ahead of the last admitted one, and no database migration changed in
    between: migrations still ship in a release someone starts.

  check  --bundle DIR   prints the decision; writes admit=true|false to GITHUB_OUTPUT
  append --bundle DIR   appends "<source sha> <digest>" to the split and ongoing-export lists
"""
import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
APP_REPOSITORY = "vayada-marketplace/vayada"
PR_CHECKS = ".github/workflows/pr-checks.yml"
HOLD_LABEL = "release-train-hold"
MIN_JOBS = 22
PG_LEGS = ("platform", "pms", "pricing", "hotel-setup")
MIGRATIONS = "packages/backend-migration/migrations/"
SPLIT_LIST = ROOT / "scripts/next-api-split-compatible-images.txt"
ONGOING_EXPORT_LIST = ROOT / "scripts/next-api-ongoing-export-compatible-images.txt"
SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")

Fetch = Callable[[str], Any]


def entries(path: Path) -> list[tuple[str, str]]:
    return [tuple(line.split()) for line in path.read_text().splitlines() if line.strip() and not line.startswith("#")]


def release_identity(bundle: Path) -> tuple[dict[str, Any], str, str]:
    plan = json.loads((bundle / "plan.json").read_text())
    manifest = json.loads((bundle / "manifest.json").read_text())
    sha = manifest["source"]["sha"]
    digest = manifest["services"]["next-target-backend"]["digest"]
    if not isinstance(sha, str) or not SHA.fullmatch(sha) or plan.get("sourceSha") != sha:
        raise ValueError("the bundle's source sha is invalid or differs from the plan")
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise ValueError("the bundle's next-target-backend digest is invalid")
    return plan, sha, digest


def queue_run_problems(fetch: Fetch, sha: str) -> list[str]:
    """Why the newest green merge-queue run of PR Checks on sha is not a full green run."""
    runs = fetch(f"/actions/workflows/pr-checks.yml/runs?event=merge_group&head_sha={sha}&status=success&per_page=20")
    runs = [run for run in runs.get("workflow_runs", [])
            if run.get("head_sha") == sha and run.get("conclusion") == "success" and run.get("path") == PR_CHECKS
            and run.get("event") == "merge_group" and (run.get("repository") or {}).get("full_name") == APP_REPOSITORY]
    if not runs:
        return [f"no green merge-queue run of PR Checks on {sha}"]
    run = max(runs, key=lambda item: item.get("updated_at") or "")
    jobs = fetch(f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100").get("jobs", [])
    problems = [f"{job.get('name')}: {job.get('conclusion')}" for job in jobs if job.get("conclusion") != "success"]
    if len(jobs) < MIN_JOBS:
        problems.append(f"only {len(jobs)} jobs ran (expected at least {MIN_JOBS})")
    names = {job.get("name") for job in jobs}
    for version in (16, 17):
        problems += [f"missing PG{version} {leg} leg" for leg in PG_LEGS
                     if f"TypeScript API PostgreSQL Integration (PG{version}, {leg})" not in names]
        if f"Setup Draft Reset PostgreSQL {version} Integration" not in names:
            problems.append(f"missing PG{version} setup draft reset")
    return [f"run {run['id']}: {problem}" for problem in problems]


def open_holds(fetch: Fetch) -> list[str]:
    issues = fetch(f"/issues?state=open&labels={HOLD_LABEL}&per_page=100")
    if not isinstance(issues, list):
        raise ValueError("the hold list is not a list")
    return [issue.get("html_url", "?") for issue in issues if issue.get("state") == "open" and "pull_request" not in issue]


def history_problems(fetch: Fetch, admitted: str, sha: str) -> list[str]:
    """The source commit must be ahead of the last admitted one, with no migration in between."""
    comparison = fetch(f"/compare/{admitted}...{sha}")
    if comparison.get("status") != "ahead":
        return [f"{sha} is {comparison.get('status')} of the last admitted {admitted}, not ahead"]
    files = comparison.get("files")
    # GitHub lists at most 300 changed files; a longer list cannot prove the absence of migrations.
    if not isinstance(files, list) or len(files) >= 300:
        return ["too many changed files since the last admitted commit to check for migrations"]
    changed = sorted(f["filename"] for f in files if str(f.get("filename", "")).startswith(MIGRATIONS)
                     or str(f.get("previous_filename", "")).startswith(MIGRATIONS))
    return [f"database migration changed since {admitted}: {name}" for name in changed]


def decide(fetch: Fetch, plan: dict[str, Any], sha: str, digest: str, admitted: list[tuple[str, str]]) -> list[str]:
    """Every reason not to admit; empty means admit."""
    if any(entry_digest == digest for _, entry_digest in admitted):
        return [f"{digest} is already admitted"]
    if plan.get("order") != "new":
        return [f"plan order is {plan.get('order')}, not new"]
    problems = [f"release-train-hold open: {url}" for url in open_holds(fetch)]
    problems += queue_run_problems(fetch, sha)
    if not admitted:
        problems.append("no admitted commit to compare against")
    else:
        problems += history_problems(fetch, admitted[-1][0], sha)
    return problems


def github_fetch(token: str) -> Fetch:
    spec = importlib.util.spec_from_file_location("coordinated_release", ROOT / "scripts/coordinated_release.py")
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    github = release.GitHub(APP_REPOSITORY, token)
    return lambda path: json.loads(github.request(path))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["check", "append"])
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    plan, sha, digest = release_identity(args.bundle)
    if args.command == "append":
        for path in (SPLIT_LIST, ONGOING_EXPORT_LIST):
            if any(entry_digest == digest for _, entry_digest in entries(path)):
                raise SystemExit(f"{digest} is already in {path.name}")
            with path.open("a") as handle:
                handle.write(f"{sha} {digest}\n")
        print(f"admitted next-{sha[:9]} {digest}")
        return
    token = os.environ.get("COORDINATED_RELEASE_READ_TOKEN", "")
    if not token:
        raise SystemExit("COORDINATED_RELEASE_READ_TOKEN is required")
    problems = decide(github_fetch(token), plan, sha, digest, entries(SPLIT_LIST))
    for problem in problems:
        print(f"not admitting next-{sha[:9]}: {problem}")
    if not problems:
        print(f"admitting next-{sha[:9]} {digest}: full green merge-queue run, no hold, no migration")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            print(f"admit={'false' if problems else 'true'}", file=output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError) as error:
        sys.exit(f"automatic admission refused: {error}")
