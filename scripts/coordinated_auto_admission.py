#!/usr/bin/env python3
"""Automatic next-api image admission (VAY-2287).

deploy-coordinated-release.yml runs this only when the repository variable
AUTO_ADMIT_NEXT_API_IMAGES is "true" and an automatic (repository_dispatch) release skipped
reconciliation because its API image is not admitted yet. By then its prepare job has validated
the publication: published by the app repository's release workflow from main, with the manifest
and record digests and the source ancestry checked. This admits that image the way the reviewed
admission PR did (release.sh), only when every gate holds:

  - plan order "new": the commit is newer than the accepted desired release (app main is linear,
    so also newer than the last admitted commit); a stale or repeated release is left alone;
  - the source commit had a green merge-queue run of PR Checks in which every job succeeded and
    none was skipped, with at least MIN_JOBS jobs and both PostgreSQL versions of every leg. The
    queue fast-forwards app main to exactly that commit, so this is the release precheck;
  - no release-train-hold issue is open in the app repository (a manual release owns admission);
  - since the last admitted commit, no database migration changed (migrations still ship in a
    release someone starts) and pr-checks.yml only gained: every
    test file, step, job, matrix value and npm script it named is still there. What the queue run
    tests still covers what the coordinator's release precheck last checked for coverage
    (precheck-vs-prchecks.py), so a dropped suite cannot pass unnoticed. The selector
    (scripts/ci/pr-checks.mjs) may change: the queue-run gate above requires every job itself.
Any error reading GitHub refuses, like a failed gate.

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
# (parent directory, entry): a directory tree or file whose hash must not change between the last
# admitted commit and the new one.
UNCHANGED = (("packages/backend-migration", "migrations"),)
SPLIT_LIST = ROOT / "scripts/next-api-split-compatible-images.txt"
ONGOING_EXPORT_LIST = ROOT / "scripts/next-api-ongoing-export-compatible-images.txt"
SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")

# fetch(path) returns the decoded JSON reply; fetch(path, raw=True) the file text of a contents path.
Fetch = Callable[..., Any]


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
    legs = set(PG_LEGS) | {m.group(1) for name in names
                           if (m := re.fullmatch(r"TypeScript API PostgreSQL Integration \(PG\d+, ([\w-]+)\)", str(name)))}
    for version in (16, 17):
        problems += [f"missing PG{version} {leg} leg" for leg in sorted(legs)
                     if f"TypeScript API PostgreSQL Integration (PG{version}, {leg})" not in names]
        if f"Setup Draft Reset PostgreSQL {version} Integration" not in names:
            problems.append(f"missing PG{version} setup draft reset")
    return [f"run {run['id']}: {problem}" for problem in problems]


def open_holds(fetch: Fetch) -> list[str]:
    issues = fetch(f"/issues?state=open&labels={HOLD_LABEL}&per_page=100")
    if not isinstance(issues, list):
        raise ValueError("the hold list is not a list")
    return [issue.get("html_url", "?") for issue in issues if issue.get("state") == "open" and "pull_request" not in issue]


def entry_sha(fetch: Fetch, commit: str, parent: str, name: str) -> str:
    listing = fetch(f"/contents/{parent}?ref={commit}")
    if not isinstance(listing, list):
        raise ValueError(f"{parent} at {commit} is not a directory")
    shas = [item.get("sha") for item in listing if item.get("name") == name]
    if len(shas) != 1 or not isinstance(shas[0], str):
        raise ValueError(f"{parent}/{name} is missing at {commit}")
    return shas[0]


def checks_inventory(workflow: str) -> set[tuple[str, str]]:
    """What PR Checks names: test files, steps, jobs, matrix values and npm scripts it runs."""
    found = {("test", m) for m in re.findall(r"[\w./-]+\.(?:test|spec)\.(?:ts|tsx|mjs|js|py)\b", workflow)}
    found |= {("step", m.strip()) for m in re.findall(r"^\s+- name: (.+)$", workflow, re.M)}
    found |= {("job", m) for m in re.findall(r"^  ([A-Za-z_][\w-]*):\s*$", workflow, re.M)}
    for key, items in re.findall(r"^\s+(shard|postgres|app): \[(.+)\]\s*$", workflow, re.M):
        found |= {(key, item.strip().strip('"')) for item in items.split(",")}
    found |= {("run", " ".join(m.split())) for m in re.findall(r"^\s+run: (npm run [\w:-]+.*)$", workflow, re.M)}
    return found


def history_problems(fetch: Fetch, admitted: str, sha: str) -> list[str]:
    """What changed since the last admitted commit that a person must release."""
    problems = [f"{parent}/{name} changed since {admitted}" for parent, name in UNCHANGED
                if entry_sha(fetch, admitted, parent, name) != entry_sha(fetch, sha, parent, name)]
    before, after = (checks_inventory(fetch(f"/contents/{PR_CHECKS}?ref={commit}", raw=True))
                     for commit in (admitted, sha))
    if len(before) < 100:
        problems.append(f"{PR_CHECKS} at {admitted} names only {len(before)} checks")
    problems += [f"{PR_CHECKS} no longer names {kind} {name!r} (since {admitted})" for kind, name in sorted(before - after)]
    return problems


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

    def fetch(path: str, raw: bool = False) -> Any:
        if raw:
            return github.request(path, accept="application/vnd.github.raw").decode()
        return json.loads(github.request(path))
    return fetch


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
    try:
        if not token:
            raise ValueError("COORDINATED_RELEASE_READ_TOKEN is required")
        problems = decide(github_fetch(token), plan, sha, digest, entries(SPLIT_LIST))
    except Exception as error:  # GitHub errors, bounded-response limits, unexpected payloads
        print(f"::warning title=Automatic admission refused::{error}")
        problems = [f"could not check the gates: {error}"]
    for problem in problems:
        print(f"not admitting next-{sha[:9]}: {problem}")
    if not problems:
        print(f"admitting next-{sha[:9]} {digest}: full green merge-queue run, no hold, no migration, PR Checks only gained")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            print(f"admit={'false' if problems else 'true'}", file=output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError) as error:
        sys.exit(f"automatic admission refused: {error}")
