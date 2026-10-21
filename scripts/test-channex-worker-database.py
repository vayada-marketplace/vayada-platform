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
                self.assertEqual(next(x for x in value["secrets"] if x["name"] == "TARGET_DATABASE_URL")["valueFrom"], parameter)
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

    def test_mapped_worker_requires_exact_reviewed_image_digest(self):
        canary.verify_reviewed_digest(DIGEST, DIGEST, required=True)
        for reviewed in (None, "sha256:" + "b" * 64, "sha256:bad"):
            with self.subTest(reviewed=reviewed), self.assertRaises(ValueError):
                canary.verify_reviewed_digest(DIGEST, reviewed, required=True)

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

    def production_claimed_container(self):
        # VAY-2108: what a canary copies from production next-api once the claimed scope is on.
        env = {"CHANNEX_API_BASE_URL":"https://app.channex.io", "CHANNEX_WEBHOOK_INTAKE_MODE":"observe_only",
               "PMS_CHANNEX_WORKER_ENABLED":"true", "PMS_CHANNEX_CONNECTION_MODE":"mutating",
               "PMS_CHANNEX_BOOKING_SYNC_MODE":"mutating", "PMS_CHANNEX_SCOPE":"claimed",
               "PMS_CHANNEX_OWNED_PROPERTY_IDS":"0f0e2b9c-1d3a-4c5b-8e7f-1a2b3c4d5e6f",
               "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE":"target-owned", "PMS_CHANNEX_STAGING_INVENTORY_ENABLED":"true"}
        return {"name":"vayada-next-api", "environment":[{"name":k, "value":v} for k, v in env.items()], "secrets":[
            {"name":"TARGET_DATABASE_URL", "valueFrom":"/vayada/prod/target-database-runtime-url"},
            {"name":"CHANNEX_API_KEY", "valueFrom":"/vayada/prod/channex-api-key"},
            {"name":"CHANNEX_WEBHOOK_SECRET", "valueFrom":"/vayada/prod/next-channex-webhook-token"},
            {"name":canary.CHANNEX_WORKER_SECRET_NAME, "valueFrom":canary.CHANNEX_WORKER_SECRET_PARAMETER}]}

    def test_claimed_booking_canary_is_pull_only_staging_without_the_worker(self):
        value = self.production_claimed_container()
        canary.configure_channex_claimed_booking(value)
        env = {e["name"]:e["value"] for e in value["environment"]}
        self.assertEqual(len(env), len(value["environment"]))
        self.assertEqual({k:v for k, v in env.items() if "CHANNEX" in k}, {
            "CHANNEX_API_BASE_URL":"https://staging.channex.io", "CHANNEX_WEBHOOK_INTAKE_MODE":"observe_only",
            "CHANNEX_REVIEW_WEBHOOK_INTAKE_MODE":"observe_only", "PMS_CHANNEX_SCOPE":"claimed",
            "PMS_CHANNEX_OWNED_PROPERTY_IDS":canary.PROPERTY, "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE":"target-owned",
            "PMS_CHANNEX_WORKER_ENABLED":"false", "PMS_CHANNEX_BOOKING_SYNC_MODE":"mutating",
            **{f"PMS_CHANNEX_{mode}_MODE":"observe_only" for mode in
               ("CONNECTION", "PROVISIONING", "ARI_SYNC", "MARKUPS", "MESSAGING", "REVIEWS", "IFRAME")}})
        self.assertEqual(sorted((x["name"], x["valueFrom"]) for x in value["secrets"]), [
            ("CHANNEX_API_KEY", canary.CHANNEX_SECRET), ("TARGET_DATABASE_URL", "/vayada/prod/target-database-runtime-url")])

    def test_every_other_canary_mode_drops_the_production_claimed_scope(self):
        for staging in (False, True):
            value = self.production_claimed_container()
            canary.drop_claimed_scope(value)
            if staging:
                canary.configure_channex_staging(value, worker_enabled="false", inventory=True)
            env = {e["name"]:e["value"] for e in value["environment"]}
            self.assertEqual(len(env), len(value["environment"]))
            self.assertFalse(canary.CLAIMED_SETTINGS & env.keys())
            self.assertEqual(env["PMS_CHANNEX_BOOKING_SYNC_MODE"], "observe_only")

    def test_claimed_booking_flag_excludes_every_other_canary_mode(self):
        for extra in (["--channex-staging"], ["--channex-staging", "--channex-staging-inventory", "--channex-worker-database"],
                      ["--channex-staging-alerts"], ["--channex-worker-state", "paused"], ["--activate-guest"], ["--remove"]):
            argv = ["deploy", "--image-sha", "next-" + "a" * 40, "--channex-staging-booking", *extra]
            with patch("sys.argv", argv), patch.object(canary, "aws", side_effect=AssertionError("no AWS")), \
                    self.assertRaises(ValueError):
                canary.main()

    def test_claimed_booking_probe_rejects_images_without_the_claimed_scope(self):
        with patch.object(canary.subprocess, "run", return_value=SimpleNamespace(stdout="synthetic")) as run:
            canary.verify_claimed_booking_image(DIGEST)
        probe = run.call_args.args[0][-1]
        for fragment in ("PMS_CHANNEX_SCOPE:'claimed'", "PMS_CHANNEX_WORKER_ENABLED:'false'", "c.channexManagement.scope !== 'claimed'",
                         f"PMS_CHANNEX_OWNED_PROPERTY_IDS:'{canary.PROPERTY}'", "ownedPropertyIds"):
            self.assertIn(fragment, probe)
        self.assertEqual(run.call_args.args[0][:9], ["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--entrypoint"])

    def test_protected_runner_uses_explicit_image_and_only_worker_secret(self):
        runner = (ROOT / "scripts/run-target-database-runtime-preflight.sh").read_text()
        self.assertIn('--provision-channex-management-worker|--grant-channex-management-worker|--preflight-channex-management-worker|--grant-channex-connection-worker|--preflight-channex-connection-worker)', runner)
        # VAY-2055: the connection scope takes only the image digest and admits the operation, not a property.
        self.assertIn('channex_scope="connection"', runner)
        self.assertIn('"$2" =~ ^sha256:[a-f0-9]{64}$', runner)
        self.assertIn('{name:"VAYADA_DB_CHANNEX_SCOPE",value:$channex_scope}', runner)
        worker_code = (ROOT / 'scripts/channex-management-worker-database.mjs').read_text()
        self.assertIn('process.env.VAYADA_DB_CHANNEX_SCOPE === "connection"', worker_code)
        self.assertIn('connection ? propertyId !== undefined :', worker_code)
        self.assertIn('{connectionScope:true}', worker_code)
        self.assertIn("INSERT INTO platform.channex_management_worker_operations(operation_type) VALUES('enable')", worker_code)
        self.assertIn('channex_worker_operation_scope_mismatch', worker_code)
        self.assertIn('provision_scope="channex_management"', runner)
        self.assertIn('secret_name="PMS_CHANNEX_MANAGEMENT_DATABASE_URL"', runner)
        self.assertIn('"$3" =~ ^sha256:[a-f0-9]{64}$', runner)
        self.assertIn('.image=$channex_image', runner)
        self.assertIn('del(.taskRoleArn)', runner)
        for filename in ('channex-management-worker-database.mjs','provision-target-database-identity-runtime.mjs'):
            encoded = base64.b64encode(gzip.compress((ROOT / 'scripts' / filename).read_bytes(), compresslevel=9, mtime=0))
            self.assertLessEqual(len(encoded)+2100+1400,8192)
        worker = sum(len(base64.b64encode(gzip.compress((ROOT / 'scripts' / filename).read_bytes(), compresslevel=9, mtime=0))) for filename in ('channex-management-worker-database.mjs','channex-policy-consumer-roles.mjs'))
        self.assertLessEqual(worker+2100+1600,8192)
        self.assertIn('VAYADA_DB_RUNTIME_PREFLIGHT_HELPER', runner)

    def test_grant_runner_replaces_public_function_execute_with_direct_role_grants(self):
        runner = (ROOT / "scripts/channex-management-worker-database.mjs").read_text()
        roles = (ROOT / "scripts/channex-policy-consumer-roles.mjs").read_text()
        self.assertIn("channexManagementWorkerFunctions", runner)
        self.assertIn("channex_worker_function_owner_required", runner)
        self.assertIn("REVOKE EXECUTE ON FUNCTION", runner)
        self.assertIn("GRANT EXECUTE ON FUNCTION", runner)
        self.assertIn('"vayada_next_api_runtime"', roles)
        self.assertIn('"vayada_next_identity_runtime"', roles)
        self.assertIn('"vayada_next_finance_expense_worker"', roles)
        self.assertIn('name.startsWith("platform.")', runner)
        self.assertIn("channex_worker_required_policy_consumer_missing", roles)
        self.assertIn("channex_worker_policy_consumer_function_access_missing", runner)

    def test_policy_consumer_roles_require_api_and_identity_but_not_finance(self):
        roles = (ROOT / "scripts/channex-policy-consumer-roles.mjs").as_uri()
        script = f'''import assert from "node:assert/strict";
          import {{selectPolicyConsumerRoles}} from "{roles}";
          assert.deepEqual(selectPolicyConsumerRoles([
            "vayada_next_api_runtime", "vayada_next_identity_runtime"
          ]), ["vayada_next_api_runtime", "vayada_next_identity_runtime"]);
          assert.throws(() => selectPolicyConsumerRoles([
            "vayada_next_api_runtime", "vayada_next_finance_expense_worker"
          ]), /channex_worker_required_policy_consumer_missing/);'''
        subprocess.run(["node", "--input-type=module", "-e", script], check=True)


if __name__ == "__main__":
    unittest.main()
