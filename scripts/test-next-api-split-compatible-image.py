#!/usr/bin/env python3
import importlib.util
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
VAY_846_RELEASE = "f0fdc908f9d30468beca555f8b90b884888f14fa"
VAY_846_DIGEST = "sha256:d13cb3df2eca9fddb3610f5de9ec586c77888c9688abd64bce495c9693187300"
VAY_1512_RELEASE = "e8105bdd75df3e92a0e5e9b5f7e5c85a005c9378"
VAY_1512_DIGEST = "sha256:b292f28ece5f94c46e4b601fdb9d87068d564a2e798b2124764d5a8fc854dfbd"


def run(service: str, repository: str, digest: str, tags: list[str], ongoing: bool | None = False, environment=None, secrets=None, current_image=None):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "image.json"
        path.write_text(json.dumps({"imageDetails": [{
            "imageDigest": digest, "imageTags": tags,
        }]}))
        args = ["python3", str(CHECK), service, repository, digest, str(path)]
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
    def test_retired_hotel_setup_caller_wiring_is_refused(self):
        base = [{"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "false"}]
        image = "269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@" + DIGEST
        for prefix in ("HOTEL_SETUP_CREATION_COMMAND", "HOTEL_SETUP_COMMAND", "HOTEL_SETUP_LOGO_COMMAND", "HOTEL_SETUP_PROFILE_COMMAND"):
            for state in ("blocked", "enabled"):
                result = run("next-target-backend", "vayada-next-api", DIGEST, [], current_image=image,
                             environment=base + [{"name": prefix + "_ADMISSION", "value": state}])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("hotel setup caller wiring is retired", result.stderr)
            self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [],
                                    environment=base + [{"name": prefix + "_ORIGIN", "value": "https://hotel-setup-property-command.vayada.com"}]).returncode, 0)
            for name in ("_INTERNAL_TOKEN", "_ADMISSION"):
                self.assertNotEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=base,
                                        secrets=[{"name": prefix + name, "valueFrom": "fixture"}]).returncode, 0)
        # An unrelated HOTEL_SETUP_* flag is not caller wiring.
        result = run("next-target-backend", "vayada-next-api", DIGEST, [],
                     environment=base + [{"name": "HOTEL_SETUP_UNRELATED_FLAG", "value": "true"}])
        self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_admission_helper_matches_the_reviewed_list(self) -> None:
        # The coordinated release workflow skips automatic deploys with this same rule.
        spec = importlib.util.spec_from_file_location("split_guard", CHECK)
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        self.assertTrue(guard.is_admitted(DIGEST))
        self.assertTrue(guard.is_admitted(VAY_1512_DIGEST))
        self.assertFalse(guard.is_admitted("sha256:" + "a" * 64))
        self.assertFalse(guard.is_admitted(RELEASE))

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

    def scripts_with_claimed_images(self, directory: Path, digests: list[str], ari_digests: list[str] = ()) -> Path:
        for name in ("assert-next-api-split-compatible-image.py", "assert-planned-channex-claimed-image.py",
                     "next-api-split-compatible-images.txt", "next-api-ongoing-export-compatible-images.txt"):
            (directory / name).write_text((ROOT / "scripts" / name).read_text())
        (directory / "next-api-channex-claimed-compatible-images.txt").write_text(
            "# fixture\n" + "".join(f"{digest[7:47]} {digest}\n" for digest in digests))
        (directory / "next-api-channex-claimed-ari-compatible-images.txt").write_text(
            "# fixture\n" + "".join(f"{digest[7:47]} {digest}\n" for digest in ari_digests))
        return directory

    def test_claimed_channex_scope_deploys_and_rolls_back_only_to_listed_images(self) -> None:
        # VAY-2108: the current task declares the claimed scope; the guard runs for the deploy and the rollback digest.
        claimed = [{"name": "FINANCE_EXPORT_WORKER_ENABLED", "value": "false"}, {"name": "PMS_CHANNEX_SCOPE", "value": "claimed"}]
        result = run("next-target-backend", "vayada-next-api", DIGEST, [], environment=claimed)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("set channex_claimed_scope off", result.stderr)
        self.assertEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=claimed[:1]).returncode, 0)
        global CHECK
        original = CHECK
        with tempfile.TemporaryDirectory() as directory:
            CHECK = self.scripts_with_claimed_images(Path(directory), [DIGEST]) / original.name
            try:
                result = run("next-target-backend", "vayada-next-api", DIGEST, [], environment=claimed)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotEqual(run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [], environment=claimed).returncode, 0)
                # P2: with ARI sync mutating under the claimed scope, the digest must also be on the claimed-ARI list.
                booking_ari = claimed + [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "mutating"}]
                result = run("next-target-backend", "vayada-next-api", DIGEST, [], environment=booking_ari)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("without claimed Channex ARI support", result.stderr)
                self.assertEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=claimed + [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "observe_only"}]).returncode, 0)
                # Provisioning mutating alone is the same stage for the image: a booking-only image refuses it.
                provisioning = claimed + [{"name": "PMS_CHANNEX_PROVISIONING_MODE", "value": "mutating"}]
                self.assertIn("without claimed Channex ARI support", run("next-target-backend", "vayada-next-api", DIGEST, [], environment=provisioning).stderr)
            finally:
                CHECK = original
        with tempfile.TemporaryDirectory() as directory:
            CHECK = self.scripts_with_claimed_images(Path(directory), [DIGEST, VAY_846_DIGEST], [DIGEST]) / original.name
            try:
                self.assertEqual(run("next-target-backend", "vayada-next-api", DIGEST, [], environment=booking_ari).returncode, 0)
                self.assertNotEqual(run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [], environment=booking_ari).returncode, 0)
                self.assertEqual(run("next-target-backend", "vayada-next-api", VAY_846_DIGEST, [], environment=claimed).returncode, 0)
            finally:
                CHECK = original

    def test_planned_claimed_scope_requires_a_listed_running_image(self) -> None:
        def plan(environment):
            definition = json.dumps([{"name": "vayada-next-api", "environment": environment}])
            return {"planned_values": {"root_module": {"resources": [{
                "address": 'aws_ecs_task_definition.services["next-target-backend"]',
                "values": {"container_definitions": definition}}]}}}
        def tasks(*digests):
            return {"tasks": [{"containers": [{"name": "vayada-next-api", "imageDigest": d}]} for d in digests]}
        claimed = [{"name": "PMS_CHANNEX_SCOPE", "value": "claimed"}]
        booking_ari = claimed + [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "mutating"}]
        ari_only = [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "mutating"}]
        provisioning = claimed + [{"name": "PMS_CHANNEX_PROVISIONING_MODE", "value": "mutating"}]
        with tempfile.TemporaryDirectory() as directory:
            folder = self.scripts_with_claimed_images(Path(directory), [DIGEST, VAY_846_DIGEST], [DIGEST])
            def check(planned, running):
                (folder / "plan.json").write_text(json.dumps(planned))
                (folder / "running.json").write_text(json.dumps(running))
                return subprocess.run(["python3", str(folder / "assert-planned-channex-claimed-image.py"),
                                       str(folder / "plan.json"), str(folder / "running.json")], capture_output=True, text=True)
            self.assertEqual(check(plan([]), tasks(VAY_1512_DIGEST)).returncode, 0)
            self.assertEqual(check(plan(claimed), tasks(DIGEST)).returncode, 0)
            self.assertEqual(check(plan(claimed), tasks(VAY_846_DIGEST)).returncode, 0)
            # P2: booking_ari needs the running image on the claimed-ARI list too. An ARI (or provisioning)
            # mutating plan without the claimed scope is held to the same lists; nothing else inspects the
            # planned shape, so the lists are the only guard before the image refuses it at startup.
            self.assertEqual(check(plan(booking_ari), tasks(DIGEST)).returncode, 0)
            self.assertEqual(check(plan(provisioning), tasks(DIGEST)).returncode, 0)
            self.assertEqual(check(plan(claimed + [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "observe_only"}]), tasks(VAY_846_DIGEST)).returncode, 0)
            for planned, running in ((plan(claimed), tasks(VAY_1512_DIGEST)), (plan(claimed), tasks(DIGEST, VAY_1512_DIGEST)),
                                     (plan(claimed), tasks()), ({"planned_values": {}}, tasks(DIGEST)), (plan(claimed), {}),
                                     (plan(booking_ari), tasks(VAY_846_DIGEST)), (plan(booking_ari), tasks(DIGEST, VAY_846_DIGEST)),
                                     (plan(ari_only), tasks(VAY_1512_DIGEST)), (plan(ari_only), tasks(VAY_846_DIGEST)),
                                     (plan(provisioning), tasks(VAY_846_DIGEST))):
                result = check(planned, running)
                self.assertNotEqual(result.returncode, 0, (planned, running))
                self.assertIn("claimed Channex image check failed", result.stderr)

    def test_planned_claimed_ari_stage_is_read_from_the_plan(self) -> None:
        # VAY-2108 P2: tf-apply reruns the claimed worker preflight exactly when the plan declares the ARI stage.
        def plan(environment):
            definition = json.dumps([{"name": "vayada-next-api", "environment": environment}])
            return {"planned_values": {"root_module": {"resources": [{
                "address": 'aws_ecs_task_definition.services["next-target-backend"]',
                "values": {"container_definitions": definition}}]}}}
        def check(planned):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "plan.json"
                path.write_text(json.dumps(planned))
                return subprocess.run(["python3", str(ROOT / "scripts/planned-channex-claimed-ari.py"), str(path)],
                                      capture_output=True, text=True)
        claimed = [{"name": "PMS_CHANNEX_SCOPE", "value": "claimed"}]
        pair = [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "mutating"}, {"name": "PMS_CHANNEX_PROVISIONING_MODE", "value": "mutating"}]
        for environment, expected in (
            ([], "false"), (claimed, "false"),
            (claimed + [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "observe_only"}], "false"),
            (claimed + pair, "true"), (pair, "true"), (claimed + pair[:1], "true"), (claimed + pair[1:], "true"),
        ):
            result = check(plan(environment))
            self.assertEqual((result.returncode, result.stdout.strip()), (0, expected), (environment, result.stderr))
        for planned in ({"planned_values": {}}, plan(claimed + [{"name": "PMS_CHANNEX_ARI_SYNC_MODE", "value": "yes"}]),
                        {"planned_values": {"root_module": {"resources": []}}}):
            result = check(planned)
            self.assertNotEqual(result.returncode, 0, planned)
            self.assertIn("claimed Channex ARI plan check failed", result.stderr)

    def test_channex_image_lists_nest_in_the_split_list(self) -> None:
        # VAY-2108: every claimed-ARI image is claimed-capable, every claimed-capable and claimed-worker image is
        # split-compatible; a line is "<app sha> <digest>". Admitting an image means adding it to each list it needs.
        def listed(name):
            lines = [line for line in (ROOT / "scripts" / name).read_text().splitlines() if line.strip() and not line.startswith("#")]
            for line in lines:
                self.assertRegex(line, r"^[0-9a-f]{40} sha256:[0-9a-f]{64}$", (name, line))
            return {tuple(line.split()) for line in lines}
        split = listed("next-api-split-compatible-images.txt")
        claimed = listed("next-api-channex-claimed-compatible-images.txt")
        self.assertTrue(listed("next-api-channex-claimed-ari-compatible-images.txt") <= claimed)
        self.assertTrue(claimed <= split)
        self.assertTrue(listed("next-api-channex-claimed-worker-images.txt") <= split)
        # D3: the delivery worker list (images whose boundary accepts the 0520 delivery tables) nests the same way.
        self.assertTrue(listed("next-api-channex-delivery-worker-images.txt") <= split)

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
