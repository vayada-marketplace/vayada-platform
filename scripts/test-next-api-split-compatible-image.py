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
VAY_2027_DIGEST = "sha256:3da7374232c46f29ee34ac1a8036f7b7abb1c0d4b6d10a1405552f12484b11a5"


def run(service: str, repository: str, digest: str, tags: list[str], ongoing: bool | None = None, environment=None, secrets=None):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "image.json"
        path.write_text(json.dumps({"imageDetails": [{
            "imageDigest": digest, "imageTags": tags,
        }]}))
        args = ["python3", str(CHECK), service, repository, digest, str(path)]
        if ongoing is not None:
            current = Path(directory) / "current.json"
            current.write_text(json.dumps({"containerDefinitions": [{"name": "vayada-next-api", "secrets": secrets or [], "environment": environment if environment is not None else [
                {"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": str(ongoing).lower()},
                {"name": "FINANCE_EXPORT_WORKER_ACCEPTED_AFTER", "value": "2026-09-25T05:00:00.000Z" if ongoing else ""},
            ]}]}))
            args.append(str(current))
        return subprocess.run(
            args,
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
            run("next-target-backend", "vayada-next-api", VAY_2027_DIGEST, []).returncode,
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

    def test_ongoing_exports_reject_old_images_until_disabled(self) -> None:
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], ongoing=True).returncode, 0)
        self.assertEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], ongoing=False).returncode, 0)
        ongoing_digest = "sha256:32842b3741aed2856fd6256e184a388649ddffdb8689fb80cf881f75f9f7a576"
        self.assertEqual(run("next-target-backend", "vayada-next-api", ongoing_digest, [], ongoing=True).returncode, 0)

    def test_rejects_ambiguous_or_missing_activation_configuration(self) -> None:
        enabled = {"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "true"}
        cutoff = {"name": "FINANCE_EXPORT_WORKER_ACCEPTED_AFTER", "value": "2026-09-25T05:00:00.000Z"}
        for env in ([], [enabled], [enabled, enabled, cutoff], [
            {"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "unknown"}, cutoff
        ], [enabled, cutoff, {"name": "FINANCE_EXPORT_WORKER_PROPERTY_ID", "value": "old-property"}]):
            self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], ongoing=True, environment=env).returncode, 0)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], ongoing=False,
            secrets=[{"name": "FINANCE_EXPORT_WORKER_ENABLED", "valueFrom": "/unknown"}]).returncode, 0)

    def test_skips_unrelated_service(self) -> None:
        self.assertEqual(run("pms-backend", "other", "tag", []).returncode, 0)


if __name__ == "__main__":
    unittest.main()
