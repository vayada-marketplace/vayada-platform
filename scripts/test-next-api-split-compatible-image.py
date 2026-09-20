#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/assert-next-api-split-compatible-image.py"
RELEASE = "8c2cdef397522740c9fe7803efc2ed36d637bac5"
DIGEST = "sha256:b097e04a61d5bd3b5910bbf856f13849bddd7b66c5883a4e2e160e311737bfca"
VAY_2027_RELEASE = "cb9a05c89e458ced6c7fd81bb9b98f2efae32a44"
VAY_2027_DIGEST = "sha256:3da7374232c46f29ee34ac1a8036f7b7abb1c0d4b6d10a1405552f12484b11a5"


def run(service: str, repository: str, digest: str, tags: list[str]):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "image.json"
        path.write_text(json.dumps({"imageDetails": [{
            "imageDigest": digest, "imageTags": tags,
        }]}))
        return subprocess.run(
            ["python3", str(CHECK), service, repository, digest, str(path)],
            capture_output=True,
            check=False,
            text=True,
        )


class CompatibleImageTest(unittest.TestCase):
    def test_accepts_reviewed_next_api_digest(self) -> None:
        self.assertEqual(
            run("next-target-backend", "vayada-next-api", DIGEST, [f"next-{RELEASE}"]).returncode,
            0,
        )
        self.assertEqual(
            run("next-target-backend", "vayada-next-api", VAY_2027_DIGEST,
                [f"next-{VAY_2027_RELEASE}"]).returncode,
            0,
        )

    def test_rejects_unreviewed_digest_or_wrong_repository(self) -> None:
        self.assertNotEqual(
            run("next-target-backend", "vayada-next-api", "sha256:" + "a" * 64, ["next-old"]).returncode,
            0,
        )
        self.assertNotEqual(
            run("next-target-backend", "other", DIGEST, [f"next-{RELEASE}"]).returncode,
            0,
        )

    def test_skips_unrelated_service(self) -> None:
        self.assertEqual(run("pms-backend", "other", "tag", []).returncode, 0)


if __name__ == "__main__":
    unittest.main()
