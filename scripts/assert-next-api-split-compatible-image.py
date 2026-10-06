#!/usr/bin/env python3
import json
from datetime import datetime
from pathlib import Path
import re
import sys


EXPECTED_REPOSITORY = "vayada-next-api"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
COMPATIBLE_IMAGES = dict(
    line.split()
    for line in Path(__file__).with_name("next-api-split-compatible-images.txt")
    .read_text()
    .splitlines()
    if line.strip() and not line.startswith("#")
)


def fail(message: str) -> None:
    raise SystemExit(f"next-api split launcher guard failed: {message}")


def main() -> None:
    if len(sys.argv) != 6:
        fail("usage: <service> <repository> <digest> <ecr-image-details.json> <current-task.json>")
    service, repository, digest, document_path = sys.argv[1:5]
    if service != "next-target-backend":
        print("next-api split launcher guard skipped for unrelated service")
        return
    if repository != EXPECTED_REPOSITORY:
        fail("next-target-backend must use the exact vayada-next-api repository")
    if not DIGEST.fullmatch(digest):
        fail("image digest is invalid")
    details = json.loads(Path(document_path).read_text()).get("imageDetails", [])
    matches = [item for item in details if item.get("imageDigest") == digest]
    if len(matches) != 1:
        fail("ECR did not return exactly one matching image")
    if digest not in COMPATIBLE_IMAGES.values():
        fail("digest has no reviewed immutable split-launcher attestation")
    current = json.loads(Path(sys.argv[5]).read_text())
    current = current.get("taskDefinition", current)
    containers = [c for c in current["containerDefinitions"] if c["name"] == "vayada-next-api"]
    if len(containers) != 1:
        fail("current task must have one next-api container")
    environment = containers[0].get("environment", [])
    admission_names = {"HOTEL_SETUP_COMMAND_ADMISSION", "HOTEL_SETUP_CREATION_COMMAND_ADMISSION", "HOTEL_SETUP_LOGO_COMMAND_ADMISSION"}
    if any(item.get("name") in admission_names for item in containers[0].get("secrets", [])):
        fail("setup admission cannot be supplied through secrets")
    admissions = [item for item in environment if item.get("name") in admission_names]
    if admissions:
        if len({item["name"] for item in admissions}) != len(admissions) or any(item.get("value") not in {"blocked", "enabled"} for item in admissions):
            fail("setup admission must be explicit and unambiguous")
        caller_images = json.loads(Path(__file__).resolve().parents[1].joinpath("deployment/hotel-setup-caller-images.json").read_text())
        source = caller_images.get(digest, "")
        if not re.fullmatch(r"[a-f0-9]{40}", source):
            fail("configured setup caller requires a reviewed admission-compatible image")
    logo_admission = next((item["value"] for item in admissions if item["name"] == "HOTEL_SETUP_LOGO_COMMAND_ADMISSION"), None)
    logo_pair_names = {"HOTEL_SETUP_LOGO_COMMAND_ORIGIN", "HOTEL_SETUP_LOGO_COMMAND_INTERNAL_TOKEN"}
    logo_pair_retained = any(item.get("name") in logo_pair_names for item in environment + containers[0].get("secrets", []))
    if logo_admission is not None or logo_pair_retained:
        logo_images = json.loads(Path(__file__).resolve().parents[1].joinpath("deployment/hotel-setup-logo-images.json").read_text())
        logo_source = logo_images.get(digest, "")
        initial_hold = (logo_admission == "blocked" and not logo_pair_retained and
                        containers[0].get("image") ==
                        f"269416271598.dkr.ecr.eu-west-1.amazonaws.com/{EXPECTED_REPOSITORY}@{digest}")
        if not initial_hold and not re.fullmatch(r"[a-f0-9]{40}", logo_source):
            fail("configured logo caller requires a reviewed logo-compatible image")
    flags = [e.get("value") for e in environment if e.get("name") == "FINANCE_EXPORT_WORKER_ENABLED"]
    reserved = {"FINANCE_EXPORT_WORKER_ENABLED", "FINANCE_EXPORT_WORKER_ACCEPTED_AFTER", "FINANCE_EXPORT_WORKER_PROPERTY_ID", "FINANCE_EXPORT_WORKER_EXPORT_ID"}
    if len(flags) != 1 or flags[0] not in {"true", "false"} or any(s.get("name") in reserved for s in containers[0].get("secrets", [])):
        fail("current export enablement must be explicit and unambiguous")
    if flags[0] == "true":
        cutoffs = [e.get("value") for e in environment if e.get("name") == "FINANCE_EXPORT_WORKER_ACCEPTED_AFTER"]
        try:
            if len(cutoffs) != 1 or datetime.strptime(cutoffs[0], "%Y-%m-%dT%H:%M:%S.%fZ").isoformat(timespec="milliseconds") + "Z" != cutoffs[0]:
                raise ValueError()
        except (TypeError, ValueError):
            fail("enabled exports require a canonical fixed cutoff")
        if any(e.get("name") in {"FINANCE_EXPORT_WORKER_PROPERTY_ID", "FINANCE_EXPORT_WORKER_EXPORT_ID"} and e.get("value") for e in environment):
            fail("ongoing exports must not carry bounded scopes")
        supported = dict(line.split() for line in Path(__file__).with_name("next-api-ongoing-export-compatible-images.txt").read_text().splitlines() if line.strip() and not line.startswith("#"))
        if digest not in supported.values():
            fail("disable ongoing exports before deploying an older image")
    print("next-api split launcher guard passed")


if __name__ == "__main__":
    main()
