#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/assert-next-api-split-compatible-image.py"
RELEASE = "8c2cdef397522740c9fe7803efc2ed36d637bac5"
DIGEST = "sha256:b097e04a61d5bd3b5910bbf856f13849bddd7b66c5883a4e2e160e311737bfca"
VAY_2027_DIGEST = "sha256:3da7374232c46f29ee34ac1a8036f7b7abb1c0d4b6d10a1405552f12484b11a5"
VAY_846_RELEASE = "f0fdc908f9d30468beca555f8b90b884888f14fa"
VAY_846_DIGEST = "sha256:d13cb3df2eca9fddb3610f5de9ec586c77888c9688abd64bce495c9693187300"
VAY_1512_RELEASE = "e8105bdd75df3e92a0e5e9b5f7e5c85a005c9378"
VAY_1512_DIGEST = "sha256:b292f28ece5f94c46e4b601fdb9d87068d564a2e798b2124764d5a8fc854dfbd"


def run(service: str, repository: str, digest: str, tags: list[str], ongoing: bool | None = False, environment=None, secrets=None, caller_images=None, current_image=None, profile_images=None):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "image.json"
        path.write_text(json.dumps({"imageDetails": [{
            "imageDigest": digest, "imageTags": tags,
        }]}))
        check = CHECK
        if caller_images is not None:
            scripts = Path(directory, "scripts")
            scripts.mkdir()
            Path(directory, "deployment").mkdir()
            for name in (CHECK.name, "next-api-split-compatible-images.txt", "next-api-ongoing-export-compatible-images.txt"):
                shutil.copy(ROOT / "scripts" / name, scripts / name)
            Path(directory, "deployment/hotel-setup-caller-images.json").write_text(json.dumps(caller_images))
            shutil.copy(ROOT / "deployment/hotel-setup-logo-images.json", Path(directory, "deployment/hotel-setup-logo-images.json"))
            Path(directory, "deployment/hotel-setup-profile-images.json").write_text(json.dumps(profile_images or {}))
            check = scripts / CHECK.name
        args = ["python3", str(check), service, repository, digest, str(path)]
        if ongoing is not None:
            current = Path(directory) / "current.json"
            current.write_text(json.dumps({"containerDefinitions": [{"name": "vayada-next-api", "image": current_image, "secrets": secrets or [], "environment": environment if environment is not None else [
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
    def test_setup_admission_cannot_roll_back_to_an_unproved_image(self):
        base = [{"name":"FINANCE_EXPORT_WORKER_ENABLED", "value":"false"}]
        admission = {"name":"HOTEL_SETUP_COMMAND_ADMISSION", "value":"blocked"}
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base+[admission]).returncode, 0)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base, secrets=[{"name":admission["name"],"valueFrom":"fixture"}]).returncode, 0)
        for state in ("blocked", "enabled"):
            result = run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base+[{**admission,"value":state}], caller_images={DIGEST:"a"*40})
            self.assertEqual(result.returncode, 0, result.stderr)
        for entries in ([admission, admission], [{**admission,"value":"allow"}]):
            self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base+entries, caller_images={DIGEST:"a"*40}).returncode, 0)

    def test_logo_retains_complete_protocol_or_unchanged_initial_hold(self):
        logo = "sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965"
        base = [{"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "false"}]
        marker = {"name": "HOTEL_SETUP_LOGO_COMMAND_ADMISSION", "value": "enabled"}
        pair = [{"name": "HOTEL_SETUP_LOGO_COMMAND_ORIGIN", "value": "https://hotel-setup-property-command.vayada.com"}]
        token = [{"name": "HOTEL_SETUP_LOGO_COMMAND_INTERNAL_TOKEN", "valueFrom": "fixture"}]
        caller = {DIGEST: "a"*40, logo: "3efb2195a823f40b7cd5a716db5bf08ac3fe90ad"}
        for state in ("enabled", "blocked"):
            for digest, accepted in ((DIGEST, False), (logo, True)):
                result = run("next-target-backend", "vayada-next-api", digest, [], environment=base+[{**marker,"value":state}]+pair, secrets=token, caller_images=caller)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base+[marker], caller_images=caller).returncode, 0)
        blocked = {**marker, "value": "blocked"}
        image = "269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@"+DIGEST
        result = run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base+[blocked], caller_images=caller, current_image=image)
        self.assertEqual(result.returncode, 0, result.stderr)
        for current_image in (image.replace(DIGEST, VAY_846_DIGEST), image.replace("269416271598", "000000000000"), "next-latest"):
            self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base+[blocked], caller_images=caller, current_image=current_image).returncode, 0)
        for entries in ([marker, marker], [{**marker, "value":"allow"}]):
            self.assertNotEqual(run("next-target-backend", "vayada-next-api", logo, [], environment=base+entries, caller_images=caller).returncode, 0)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", logo, [], environment=base, secrets=[{"name":marker["name"],"valueFrom":"fixture"}], caller_images=caller).returncode, 0)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base+pair, secrets=token, caller_images=caller).returncode, 0)

    def test_profile_retains_complete_protocol_or_unchanged_initial_hold(self):
        base = [{"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "false"}]
        marker = {"name": "HOTEL_SETUP_PROFILE_COMMAND_ADMISSION", "value": "enabled"}
        pair = [{"name": "HOTEL_SETUP_PROFILE_COMMAND_ORIGIN", "value": "https://hotel-setup-property-command.vayada.com"}]
        token = [{"name": "HOTEL_SETUP_PROFILE_COMMAND_INTERNAL_TOKEN", "valueFrom": "fixture"}]
        caller = {DIGEST: "a" * 40, VAY_846_DIGEST: "b" * 40}
        proved = {VAY_846_DIGEST: "b" * 40}
        for state in ("enabled", "blocked"):
            for digest, accepted in ((DIGEST, False), (VAY_846_DIGEST, True)):
                result = run("next-target-backend", "vayada-next-api", digest, [], environment=base + [{**marker, "value": state}] + pair,
                             secrets=token, caller_images=caller, profile_images=proved)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
        # A retained pair alone (token without admission) still requires the profile protocol.
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base, secrets=token,
                                caller_images=caller, profile_images=proved).returncode, 0)
        blocked = {**marker, "value": "blocked"}
        image = "269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@" + DIGEST
        result = run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base + [blocked], caller_images=caller, current_image=image)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base + [blocked], caller_images=caller,
                                current_image=image.replace(DIGEST, VAY_846_DIGEST)).returncode, 0)
        for entries in ([marker, marker], [{**marker, "value": "allow"}]):
            self.assertNotEqual(run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [], environment=base + entries,
                                    caller_images=caller, profile_images=proved).returncode, 0)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [], environment=base,
                                secrets=[{"name": marker["name"], "valueFrom": "fixture"}], caller_images=caller, profile_images=proved).returncode, 0)
        # The logo protocol does not satisfy profile, and profile does not satisfy logo.
        logo = [{"name": "HOTEL_SETUP_LOGO_COMMAND_ADMISSION", "value": "enabled"},
                {"name": "HOTEL_SETUP_LOGO_COMMAND_ORIGIN", "value": "https://hotel-setup-property-command.vayada.com"}]
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [], environment=base + logo,
                                caller_images=caller, profile_images=proved).returncode, 0)
        # Only the natively proved profile-edit image D (VAY-965, source 3e78a281a) is admitted.
        self.assertEqual(json.loads((ROOT / "deployment/hotel-setup-profile-images.json").read_text()),
                         {"sha256:1c5ddf7c26ad738ce55dc360f17e67ed5cbf46a1a8e09505c71b88a59a463a75": "3e78a281a28930d3023de18385c90411a6006625",
                          "sha256:eacd03ed0c836b1d1e77e1b8fdb0ba5bb3a178b218700a627f6552534f60c846": "480602efd31b71e7997be1c5aae2c23930be3933",
                          "sha256:6d82282ea8ef2dfba3a184e4b4af15f63ed252016379a1eaea133d62ce955c39": "46a34760a7137256a0d8dfd20954c9634899f684",
                          "sha256:VAY2056S1_DIGEST_PENDING": "VAY2056S1_SOURCE_PENDING"})

    def test_accepts_reviewed_next_api_digest(self) -> None:
        reviewed = dict(
            line.split()
            for line in (ROOT / "scripts/next-api-split-compatible-images.txt").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertEqual(reviewed.get(VAY_1512_RELEASE), VAY_1512_DIGEST)
        self.assertEqual(
            run("next-target-backend", "vayada-next-api", DIGEST, [f"next-{RELEASE}"]).returncode,
            0,
        )
        self.assertEqual(
            run("next-target-backend", "vayada-next-api", VAY_2027_DIGEST, []).returncode,
            0,
        )
        self.assertEqual(
            run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [f"next-{VAY_846_RELEASE}"]).returncode,
            0,
        )
        self.assertEqual(
            run("next-target-backend", "vayada-next-api", VAY_1512_DIGEST, [f"next-{VAY_1512_RELEASE}"]).returncode,
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
        self.assertEqual(run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [], ongoing=True).returncode, 0)
        self.assertEqual(run("next-target-backend", "vayada-next-api", VAY_1512_DIGEST, [], ongoing=True).returncode, 0)

    def test_rejects_ambiguous_or_missing_activation_configuration(self) -> None:
        enabled = {"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "true"}
        cutoff = {"name": "FINANCE_EXPORT_WORKER_ACCEPTED_AFTER", "value": "2026-09-25T05:00:00.000Z"}
        for env in ([], [enabled], [enabled, enabled, cutoff], [
            {"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "unknown"}, cutoff
        ], [enabled, cutoff, {"name": "FINANCE_EXPORT_WORKER_PROPERTY_ID", "value": "old-property"}]):
            self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], ongoing=True, environment=env).returncode, 0)
        self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], ongoing=False,
            secrets=[{"name": "FINANCE_EXPORT_WORKER_ENABLED", "valueFrom": "/unknown"}]).returncode, 0)

    def test_requires_task_definition(self) -> None:
        result = run("next-target-backend", "vayada-next-api", DIGEST, [], ongoing=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("usage:", result.stderr)

    def test_skips_unrelated_service(self) -> None:
        self.assertEqual(run("pms-backend", "other", "tag", []).returncode, 0)

    def test_logo_image_has_split_and_ongoing_export_attestations(self):
        source = "3efb2195a823f40b7cd5a716db5bf08ac3fe90ad"
        digest = "sha256:18fa7587a09fa58916e734ea9c3b2d38c274783bc98d793308cc2f122d688965"
        for name in ("next-api-split-compatible-images.txt", "next-api-ongoing-export-compatible-images.txt"):
            approved = dict(line.split() for line in (ROOT / "scripts" / name).read_text().splitlines()
                            if line.strip() and not line.startswith("#"))
            self.assertEqual(approved.get(source), digest)
        result = run("next-target-backend", "vayada-next-api", digest, [], ongoing=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
