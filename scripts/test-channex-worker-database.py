#!/usr/bin/env python3
import base64
import copy
import gzip
import importlib.util
import os
import subprocess
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("canary", ROOT / "scripts/deploy-next-maps-canary.py")
canary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canary)
DIGEST = "sha256:" + "a" * 64


class ChannexWorkerDatabaseTest(unittest.TestCase):
    def container(self):
        value = {"name":"vayada-next-api", "environment":[], "secrets":[
            {"name":"TARGET_DATABASE_URL", "valueFrom":"/vayada/prod/target-database-runtime-url"}],
            "image":f"{canary.ACCOUNT}.dkr.ecr.{canary.REGION}.amazonaws.com/vayada-next-api@{DIGEST}"}
        canary.configure_channex_staging(value, worker_enabled="false", inventory=True, published_offers=True)
        return value

    def test_mapping_requires_paused_property_scope_and_preserves_general_role(self):
        for parameter in canary.GENERAL_RUNTIME_SECRET_PARAMETERS:
            with self.subTest(parameter=parameter):
                value = self.container()
                value["secrets"][0]["valueFrom"] = parameter
                canary.map_channex_worker_database(value)
                self.assertEqual(next(x for x in value["secrets"] if x["name"] == canary.CHANNEX_WORKER_SECRET_NAME)["valueFrom"], canary.CHANNEX_WORKER_SECRET_PARAMETER)
        value = self.container()
        canary.map_channex_worker_database(value)
        for key, bad in [("PMS_CHANNEX_WORKER_ENABLED","true"), ("CHANNEX_API_BASE_URL","https://app.channex.io"), ("PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID","other")]:
            changed = copy.deepcopy(value)
            next(x for x in changed["environment"] if x["name"] == key)["value"] = bad
            with self.assertRaises(ValueError):
                canary.map_channex_worker_database(changed)
        value["secrets"][0]["valueFrom"] = "/vayada/prod/target-database-url"
        with self.assertRaises(ValueError):
            canary.map_channex_worker_database(value)

    def test_running_task_digest_and_mapping_are_attested(self):
        value = self.container()
        canary.map_channex_worker_database(value)
        task = {"taskDefinitionArn":"reviewed", "lastStatus":"RUNNING", "containers":[
            {"name":"vayada-next-api", "image":value["image"], "imageDigest":DIGEST}]}
        replies = [{"taskDefinition":{"containerDefinitions":[value]}}, {"taskArns":["one"]}, {"tasks":[task]}]
        with patch.object(canary,"aws",side_effect=copy.deepcopy(replies)):
            canary.verify_channex_worker_tasks("reviewed", DIGEST)
        for field, bad in [("taskDefinitionArn","old"), ("lastStatus","PENDING")]:
            changed = copy.deepcopy(replies)
            changed[2]["tasks"][0][field] = bad
            with patch.object(canary,"aws",side_effect=changed), self.assertRaises(ValueError):
                canary.verify_channex_worker_tasks("reviewed", DIGEST)
        changed = copy.deepcopy(replies)
        changed[2]["tasks"][0]["containers"][0]["imageDigest"] = "sha256:" + "b" * 64
        with patch.object(canary,"aws",side_effect=changed), self.assertRaises(ValueError):
            canary.verify_channex_worker_tasks("reviewed", DIGEST)
        changed = copy.deepcopy(replies)
        changed[0]["taskDefinition"]["containerDefinitions"][0]["secrets"][-1]["valueFrom"] = "wrong"
        with patch.object(canary,"aws",side_effect=changed), self.assertRaises(ValueError):
            canary.verify_channex_worker_tasks("reviewed", DIGEST)

    def test_image_probe_is_paused_and_imports_the_boundary(self):
        with patch.object(canary.subprocess,"run",return_value=SimpleNamespace(stdout="synthetic")) as run:
            canary.verify_inventory_image(DIGEST,published_offers=True,worker_database=True)
        probe = run.call_args.args[0][-1]
        self.assertIn("PMS_CHANNEX_WORKER_ENABLED:'false'",probe)
        self.assertIn("channexManagementWorkerStartup.js",probe)
        # Optional cross-repo artifact check; no AWS/Docker calls occur here.
        if os.environ.get("VAYADA_WORKER_IMAGE_FIXTURE_ROOT"):
            probe = probe.replace("/app/", os.environ["VAYADA_WORKER_IMAGE_FIXTURE_ROOT"].rstrip("/")+"/")
            subprocess.run(["node","--input-type=module","-e",probe],check=True,capture_output=True,text=True)

    def test_protected_runner_uses_explicit_image_and_only_worker_secret(self):
        runner = (ROOT / "scripts/run-target-database-runtime-preflight.sh").read_text()
        self.assertIn('--provision-channex-management-worker|--grant-channex-management-worker|--preflight-channex-management-worker)', runner)
        self.assertIn('provision_scope="channex_management"', runner)
        self.assertIn('secret_name="PMS_CHANNEX_MANAGEMENT_DATABASE_URL"', runner)
        self.assertIn('"$3" =~ ^sha256:[a-f0-9]{64}$', runner)
        self.assertIn('.image=$channex_image', runner)
        self.assertIn('del(.taskRoleArn)', runner)
        for filename in ('channex-management-worker-database.mjs','provision-target-database-identity-runtime.mjs'):
            encoded = base64.b64encode(gzip.compress((ROOT / 'scripts' / filename).read_bytes(), compresslevel=9, mtime=0))
            self.assertLessEqual(len(encoded)+2100+1400,8192)

    def test_grant_runner_replaces_public_function_execute_with_direct_role_grants(self):
        runner = (ROOT / "scripts/channex-management-worker-database.mjs").read_text()
        self.assertIn("channexManagementWorkerFunctions", runner)
        self.assertIn("channex_worker_function_owner_required", runner)
        self.assertIn("REVOKE EXECUTE ON FUNCTION", runner)
        self.assertIn("GRANT EXECUTE ON FUNCTION", runner)


if __name__ == "__main__":
    unittest.main()
