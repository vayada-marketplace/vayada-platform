#!/usr/bin/env python3
import json
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
    if len(sys.argv) != 5:
        fail("usage: <service> <repository> <digest> <ecr-image-details.json>")
    service, repository, digest, document_path = sys.argv[1:]
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
    print("next-api split launcher guard passed")


if __name__ == "__main__":
    main()
