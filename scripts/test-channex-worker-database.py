#!/usr/bin/env python3
import base64
import copy
import gzip
import importlib.util
import json
import os
import subprocess
import tempfile
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
        self.assertIn('--provision-channex-management-worker|--grant-channex-management-worker|--preflight-channex-management-worker|--grant-channex-connection-worker|--preflight-channex-connection-worker|--grant-channex-claimed-worker|--preflight-channex-claimed-worker|--revoke-channex-claimed-worker)', runner)
        # VAY-2055: the connection scope takes only the image digest and admits the operation, not a property.
        self.assertIn('channex_scope="connection"', runner)
        self.assertIn('"$2" =~ ^sha256:[a-f0-9]{64}$', runner)
        self.assertIn('{name:"VAYADA_DB_CHANNEX_SCOPE",value:$channex_scope}', runner)
        worker_code = (ROOT / 'scripts/channex-management-worker-database.mjs').read_text()
        self.assertIn('channexScope === "connection" || claimed', worker_code)
        self.assertIn('connection ? propertyId !== undefined :', worker_code)
        self.assertIn('{connectionScope:true,claimedScope:claimed&&!revoke}', worker_code)
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


class ChannexClaimedWorkerScopeTest(unittest.TestCase):
    """VAY-2108 P2: the claimed scope (app 0519) in the grant script and the runner."""
    # The pinned image: release R4 (app main 2178452a4), the image production runs.
    R4 = "sha256:5086d864ef2ac45c5091b87715e657608c3fa42226873870f8bbf7b98d8362b3"
    CLAIMED = "platform.channex_management_worker_claimed_operations"

    @staticmethod
    def run_script(**scenario):
        harness = ROOT / "scripts/fixtures/channex-worker-database/run-worker-database.mjs"
        result = subprocess.run(["node", str(harness), json.dumps(scenario)], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    def test_grant_claimed_adds_the_read_and_both_rows_after_the_connection_prerequisites(self):
        run = self.run_script(grant=True, user="vayada_target_prod_user", env={"VAYADA_DB_CHANNEX_SCOPE": "claimed"})
        self.assertEqual(run["status"], 0, run["stderr"])
        self.assertEqual(json.loads(run["stdout"]), {"status": "PASS", "role": "vayada_next_channex_management_worker", "mode": "grant", "scope": "claimed"})
        statements = run["statements"]
        order = [statements.index(s) for s in (
            'BOUNDARY {"allowMissingGrants":true}',
            "INSERT INTO platform.channex_management_worker_operations(operation_type) VALUES('enable') ON CONFLICT DO NOTHING",
            f"LOCK TABLE {self.CLAIMED} IN EXCLUSIVE MODE", f"SELECT operation_type FROM {self.CLAIMED}",
            f"GRANT SELECT ON {self.CLAIMED} TO vayada_next_channex_management_worker",
            f"INSERT INTO {self.CLAIMED}(operation_type) VALUES('sync_ari'),('provision') ON CONFLICT DO NOTHING",
            "GRANT SELECT ON pms.channel_connections TO vayada_next_channex_management_worker",
            'BOUNDARY {"connectionScope":true,"claimedScope":true}', "COMMIT")]
        self.assertEqual(order, sorted(order))
        self.assertTrue(any(s.startswith("SELECT count(*)::int AS count FROM pg_class WHERE oid=$1::regclass AND relowner=") for s in statements))
        self.assertNotIn("ROLLBACK", statements)

    def test_revoke_claimed_deletes_both_rows_and_the_read_then_asserts_the_connection_boundary(self):
        # The kill switch deletes whatever the table holds; it never refuses on a row.
        run = self.run_script(grant=True, user="vayada_target_prod_user", claimedRows=["provision", "sync_ari", "other"], env={"VAYADA_DB_CHANNEX_SCOPE": "claimed_revoke"})
        self.assertEqual(run["status"], 0, run["stderr"])
        self.assertEqual(json.loads(run["stdout"])["scope"], "claimed_revoke")
        statements = run["statements"]
        order = [statements.index(s) for s in (
            f"LOCK TABLE {self.CLAIMED} IN EXCLUSIVE MODE", f"DELETE FROM {self.CLAIMED}",
            f"REVOKE SELECT ON {self.CLAIMED} FROM vayada_next_channex_management_worker",
            'BOUNDARY {"connectionScope":true,"claimedScope":false}', "COMMIT")]
        self.assertEqual(order, sorted(order))
        self.assertFalse(any("GRANT SELECT ON " + self.CLAIMED in s or "INSERT INTO " + self.CLAIMED in s for s in statements))

    def test_preflight_claimed_only_reads_as_the_worker_and_requires_the_claimed_boundary(self):
        run = self.run_script(env={"VAYADA_DB_CHANNEX_SCOPE": "claimed"})
        self.assertEqual(run["status"], 0, run["stderr"])
        self.assertEqual(json.loads(run["stdout"]), {"status": "PASS", "role": "vayada_next_channex_management_worker", "mode": "preflight", "scope": "claimed"})
        self.assertIn('BOUNDARY {"connectionScope":true,"claimedScope":true}', run["statements"])
        self.assertFalse(any(s.split()[0] in {"GRANT", "REVOKE", "INSERT", "DELETE", "LOCK"} for s in run["statements"]))
        # The revoke scope is an owner-only grant mode; the worker login never runs it. An unknown
        # scope string is refused before connecting instead of falling through to the canary scope.
        for scenario in (dict(env={"VAYADA_DB_CHANNEX_SCOPE": "claimed_revoke"}),
                         dict(grant=True, user="vayada_target_prod_user", env={"VAYADA_DB_CHANNEX_SCOPE": "CLAIMED", "PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID": "65f6b2fc-c783-4963-9d6b-a85f82319769"}),
                         dict(env={"VAYADA_DB_CHANNEX_SCOPE": "claimed "})):
            run = self.run_script(**scenario)
            self.assertEqual(run["status"], 1, scenario)
            self.assertEqual(json.loads(run["stderr"]), {"status": "FAIL", "code": "channex_worker_scope_mismatch"})
            self.assertNotIn("BEGIN", run["statements"])

    def test_grant_claimed_fails_closed_on_a_foreign_row_or_an_unowned_table(self):
        for scenario, code in ((dict(claimedRows=["other"]), "channex_worker_claimed_scope_mismatch"),
                               (dict(claimedOwned=False), "channex_worker_table_owner_required"),
                               (dict(operationRows=["enable", "sync_ari"]), "channex_worker_operation_scope_mismatch")):
            with self.subTest(code=code):
                run = self.run_script(grant=True, user="vayada_target_prod_user", env={"VAYADA_DB_CHANNEX_SCOPE": "claimed"}, **scenario)
                self.assertEqual(run["status"], 1)
                self.assertEqual(json.loads(run["stderr"]), {"status": "FAIL", "code": code})
                self.assertEqual(run["statements"][-1], "ROLLBACK")
                self.assertFalse(any("GRANT SELECT ON " + self.CLAIMED in s for s in run["statements"]))

    def test_connection_grant_and_preflight_are_unchanged_and_skip_optional_delivery_relations(self):
        run = self.run_script(grant=True, user="vayada_target_prod_user", deliveryImage=True, env={"VAYADA_DB_CHANNEX_SCOPE": "connection"})
        self.assertEqual(run["status"], 0, run["stderr"])
        self.assertEqual(json.loads(run["stdout"])["scope"], "connection")
        self.assertIn("GRANT SELECT ON pms.channel_connections TO vayada_next_channex_management_worker", run["statements"])
        # VAY-2108 D3: the delivery tables (app 0520) get their grants only from the delivery grant mode.
        self.assertFalse(any("pms.channex_offer_ari_deliveries" in s for s in run["statements"]))
        self.assertFalse(any(self.CLAIMED in s for s in run["statements"]))
        self.assertIn('BOUNDARY {"connectionScope":true,"claimedScope":false}', run["statements"])
        run = self.run_script(env={"VAYADA_DB_CHANNEX_SCOPE": "connection"})
        self.assertEqual(run["status"], 0, run["stderr"])
        self.assertIn('BOUNDARY {"connectionScope":true,"claimedScope":false}', run["statements"])

    def test_worker_login_mismatch_and_untrusted_endpoint_still_fail(self):
        run = self.run_script(env={"VAYADA_DB_CHANNEX_SCOPE": "claimed"}, user="vayada_next_api_runtime")
        self.assertEqual(json.loads(run["stderr"]), {"status": "FAIL", "code": "channex_worker_login_mismatch"})
        run = self.run_script(grant=True, user="vayada_target_prod_user", login="vayada_target_prod_user", env={"VAYADA_DB_CHANNEX_SCOPE": "claimed", "VAYADA_DB_RDS_CA_BUNDLE": ""})
        self.assertEqual(json.loads(run["stderr"]), {"status": "FAIL", "code": "channex_worker_connection_missing"})

    def test_script_parses_and_fits_the_override_budget(self):
        subprocess.run(["node", "--check", str(ROOT / "scripts/channex-management-worker-database.mjs")], check=True)
        worker = sum(len(base64.b64encode(gzip.compress((ROOT / "scripts" / filename).read_bytes(), compresslevel=9, mtime=0)))
                     for filename in ("channex-management-worker-database.mjs", "channex-policy-consumer-roles.mjs"))
        self.assertLessEqual(worker + 2100 + 1600, 8192)

    def runner(self, *args):
        with tempfile.TemporaryDirectory() as directory:
            # The runner needs aws, base64, gzip, jq, curl and shasum on PATH; the stubs never run
            # before argument validation, and curl fails first on a valid call.
            for name, code in (("aws", 99), ("curl", 7)):
                stub = Path(directory) / name
                stub.write_text(f"#!/bin/sh\nexit {code}\n")
                stub.chmod(0o700)
            return subprocess.run(["bash", str(ROOT / "scripts/run-target-database-runtime-preflight.sh"), *args],
                                  capture_output=True, text=True, env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}"})

    def test_runner_claimed_modes_take_one_listed_digest_and_use_the_owner_only_for_grant_and_revoke(self):
        runner = (ROOT / "scripts/run-target-database-runtime-preflight.sh").read_text()
        self.assertIn("--grant-channex-claimed-worker|--preflight-channex-claimed-worker|--revoke-channex-claimed-worker)", runner)
        self.assertIn('channex_scope="claimed"', runner)
        self.assertIn('[[ "${mode}" == "--revoke-channex-claimed-worker" ]] && channex_scope="claimed_revoke"', runner)
        self.assertIn('if [[ "${mode}" == --grant-* || "${mode}" == --revoke-* ]]; then', runner)
        self.assertIn('|| "${mode}" == *channex-claimed-worker ]]; then', runner)
        for mode in ("--grant-channex-claimed-worker", "--preflight-channex-claimed-worker", "--revoke-channex-claimed-worker"):
            with self.subTest(mode=mode):
                for args in ((), ("sha256:bad",), (self.R4, "extra"), (self.R4[:-1] + "f",), ("65f6b2fc-c783-4963-9d6b-a85f82319769", self.R4)):
                    result = self.runner(mode, *args)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertRegex(result.stderr, "immutable image digest|not listed in scripts/next-api-channex-claimed-worker-images.txt")
                result = self.runner(mode, self.R4)
                self.assertEqual(result.returncode, 7, result.stderr)  # past validation: the CA download is the first network step
                self.assertNotIn("not listed", result.stderr)

    def runner_task(self, mode, digest):
        """Run the runner end to end against a stubbed aws (and the real RDS CA bundle download)."""
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "record"
            record.mkdir()
            stub = Path(directory) / "aws"
            stub.write_text("""#!/usr/bin/env bash
record=%s; sub="$1 $2"; query=""; prev=""; for a in "$@"; do
  [ "$prev" = --query ] && query="$a"; [ "$prev" = --cli-input-json ] && printf '%%s' "$a" > "$record/definition.json"
  [ "$prev" = --overrides ] && printf '%%s' "$a" > "$record/overrides.json"; prev="$a"; done
case "$sub|$query" in
  "ecs describe-services|services[0].taskDefinition") echo arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api:1352 ;;
  "ecs describe-services|services[0].networkConfiguration") echo '{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"DISABLED"}}' ;;
  "ecs describe-task-definition|taskDefinition") echo '{"taskDefinitionArn":"arn:x","revision":1352,"family":"vayada-next-api","taskRoleArn":"arn:aws:iam::269416271598:role/ecsTaskRole","executionRoleArn":"arn:aws:iam::269416271598:role/ecsTaskExecutionRole","networkMode":"awsvpc","cpu":"512","memory":"1024","requiresCompatibilities":["FARGATE"],"containerDefinitions":[{"name":"vayada-next-api","image":"269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@sha256:1111111111111111111111111111111111111111111111111111111111111111","environment":[{"name":"PMS_CHANNEX_SCOPE","value":"claimed"}],"secrets":[{"name":"TARGET_DATABASE_URL","valueFrom":"/vayada/prod/target-database-runtime-url"},{"name":"PMS_CHANNEX_MANAGEMENT_DATABASE_URL","valueFrom":"/vayada/prod/target-database-channex-management-worker-url"}],"portMappings":[{"containerPort":8003}],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/vayada-next-api","awslogs-region":"eu-west-1","awslogs-stream-prefix":"ecs"}}}]}' ;;
  "ecs register-task-definition|taskDefinition.taskDefinitionArn") echo arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-next-api-db-runtime-preflight:7 ;;
  "ecs run-task|tasks[0].taskArn") echo arn:aws:ecs:eu-west-1:269416271598:task/vayada-target-database-runtime-preflight/0123456789abcdef ;;
  "ecs describe-tasks|tasks[0].lastStatus") echo STOPPED ;;
  "ecs describe-tasks|"*) echo '{"exitCode":0,"reason":"Essential container in task exited"}' ;;
  "logs get-log-events|"*) echo '["{\\"status\\":\\"PASS\\",\\"role\\":\\"vayada_next_channex_management_worker\\",\\"mode\\":\\"%s\\",\\"scope\\":\\"%s\\"}"]' ;;
  "ecs stop-task|"*|"ecs deregister-task-definition|"*) ;;
  *) echo "unexpected aws call: $sub $query" >&2; exit 97 ;;
esac
""" % (record, "preflight" if mode.startswith("--preflight") else "grant", "claimed_revoke" if mode.startswith("--revoke") else "claimed"))
            stub.chmod(0o700)
            result = subprocess.run(["bash", str(ROOT / "scripts/run-target-database-runtime-preflight.sh"), mode, digest],
                                    capture_output=True, text=True, env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}"})
            if "curl: (" in result.stderr or "CA bundle checksum mismatch" in result.stderr:
                self.skipTest("the RDS CA bundle download is unavailable here")
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads((record / "overrides.json").read_text()), json.loads((record / "definition.json").read_text()), result.stdout

    def test_runner_claimed_modes_ship_the_scope_and_secret_the_mode_needs(self):
        for mode, scope, secret in (("--grant-channex-claimed-worker", "claimed", "TARGET_DATABASE_MIGRATION_URL"),
                                    ("--revoke-channex-claimed-worker", "claimed_revoke", "TARGET_DATABASE_MIGRATION_URL"),
                                    ("--preflight-channex-claimed-worker", "claimed", "PMS_CHANNEX_MANAGEMENT_DATABASE_URL")):
            with self.subTest(mode=mode):
                overrides, definition, stdout = self.runner_task(mode, self.R4)
                self.assertLessEqual(len(json.dumps(overrides, separators=(",", ":"))), 8192)
                [container] = overrides["containerOverrides"]
                env = {e["name"]: e["value"] for e in container["environment"]}
                self.assertEqual(env.get("VAYADA_DB_CHANNEX_SCOPE"), scope)
                self.assertEqual(env.get("VAYADA_DB_GRANT_SCOPE"), None if mode.startswith("--preflight") else "channex_management")
                self.assertNotIn("PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID", env)
                for name in ("VAYADA_DB_RUNTIME_PREFLIGHT_CODE", "VAYADA_DB_RUNTIME_PREFLIGHT_HELPER", "VAYADA_DB_RDS_CA_BUNDLE_GZIP"):
                    self.assertIn(name, env)
                self.assertEqual(base64.b64decode(env["VAYADA_DB_RUNTIME_PREFLIGHT_CODE"])[:2], b"\x1f\x8b")
                [task_container] = definition["containerDefinitions"]
                self.assertEqual(task_container["secrets"], [{"name": secret, "valueFrom": "/vayada/prod/target-database-url" if secret == "TARGET_DATABASE_MIGRATION_URL" else "/vayada/prod/target-database-channex-management-worker-url"}])
                self.assertEqual(task_container["image"], f"269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@{self.R4}")
                self.assertEqual(task_container["environment"], [])
                self.assertEqual(task_container["portMappings"], [])
                self.assertNotIn("taskRoleArn", definition)
                self.assertEqual(definition["family"], "vayada-next-api-db-runtime-preflight")
                self.assertEqual(json.loads(stdout.strip().splitlines()[-1])["scope"], scope)

    def test_claimed_worker_image_list_pins_reviewed_split_compatible_digests(self):
        lines = [line for line in (ROOT / "scripts/next-api-channex-claimed-worker-images.txt").read_text().splitlines() if line.strip() and not line.startswith("#")]
        split = dict(line.split() for line in (ROOT / "scripts/next-api-split-compatible-images.txt").read_text().splitlines() if line.strip() and not line.startswith("#"))
        self.assertTrue(lines)
        for line in lines:
            self.assertRegex(line, r"^[0-9a-f]{40} sha256:[0-9a-f]{64}$")
            release, digest = line.split()
            self.assertEqual(split.get(release), digest, line)
        # R4 (app main 2178452a4, released 2026-10-27): the live image, with D3, D7 and D3a.
        self.assertIn(f"2178452a43fb9a78f93f38f68249430ff0a2877f {self.R4}", lines)
        # The image production runs since 2026-10-27 16:04Z (release next-d1d75e9df, built from app main 851625e74).
        self.assertIn("d1d75e9df1a08262df45b7b4ef37169b4da7346e sha256:5da84314667bea02ce8869da75414139b3eb34f381e594ce9fea9427ad08d081", lines)


if __name__ == "__main__":
    unittest.main()
