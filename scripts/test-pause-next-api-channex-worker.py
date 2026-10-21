import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pause", ROOT / "scripts/pause-next-api-channex-worker.py")
pause = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pause)


def fixture():
    return {"family":"vayada-next-api", "taskRoleArn":"unchanged", "containerDefinitions":[{
        "name":"vayada-next-api", "image":"269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@sha256:" + "a"*64,
        "environment":[{"name":"PMS_CHANNEX_CONNECTION_MODE", "value":"mutating"},
                       {"name":"PMS_CHANNEX_REVIEWS_MODE", "value":"mutating"}],
        "secrets":[{"name":"TARGET_DATABASE_URL", "valueFrom":"runtime"}]}]}


class PauseWorkerTest(unittest.TestCase):
    def test_only_durable_management_is_paused_and_replay_is_idempotent(self):
        for prior in [[], [{"name":"PMS_CHANNEX_WORKER_ENABLED","value":"true"}],
                      [{"name":"PMS_CHANNEX_WORKER_ENABLED","value":"false"}]*2]:
            task = fixture()
            expected = copy.deepcopy(task)
            task["containerDefinitions"][0]["environment"] += prior
            expected["containerDefinitions"][0]["environment"] = [
                {"name":"PMS_CHANNEX_REVIEWS_MODE", "value":"mutating"},
                {"name":"PMS_CHANNEX_WORKER_ENABLED", "value":"false"},
                *[{"name":f"PMS_CHANNEX_{capability}_MODE", "value":"observe_only"} for capability in
                  ("CONNECTION", "PROVISIONING", "ARI_SYNC", "BOOKING_SYNC", "MARKUPS", "MESSAGING")],
            ]
            self.assertEqual(pause.pause_worker(task), expected)
            self.assertEqual(pause.pause_worker(task), expected)

    def test_rejects_wrong_family_mutable_image_duplicate_container_and_secret_override(self):
        cases = []
        task=fixture();task["family"]="vayada-next-maps-canary";cases.append(task)
        task=fixture();task["containerDefinitions"][0]["image"]="next-api:latest";cases.append(task)
        task=fixture();task["containerDefinitions"]*=2;cases.append(task)
        for name in pause.PAUSED_ENV:
            task=fixture();task["containerDefinitions"][0]["secrets"].append({"name":name,"valueFrom":"unsafe"});cases.append(task)
        for task in cases:
            with self.assertRaises(ValueError):pause.pause_worker(task)

    def test_other_services_never_open_task_files(self):
        for service in ["next-maps-canary","next-booking-frontend",""]:
            with patch.dict(os.environ,{"SERVICE":service},clear=True), patch.object(Path,"read_text") as read:
                pause.main()
            read.assert_not_called()

    def test_primary_and_rollback_are_both_paused(self):
        with tempfile.TemporaryDirectory() as directory:
            paths=[Path(directory)/name for name in ["primary.json","rollback.json"]]
            for path in paths:path.write_text(json.dumps(fixture()))
            with patch.dict(os.environ,{"SERVICE":"next-target-backend","TASK_DEFINITION":str(paths[0]),"ROLLBACK_TASK_DEFINITION":str(paths[1])},clear=True):
                pause.main()
            self.assertEqual(json.loads(paths[0].read_text()),pause.pause_worker(fixture()))
            self.assertEqual(paths[0].read_text(),paths[1].read_text())

    def test_invalid_rollback_leaves_both_files_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            primary=Path(directory)/"primary.json";rollback=Path(directory)/"rollback.json"
            primary.write_text(json.dumps(fixture()));rollback.write_text('{}')
            before=primary.read_text()
            with patch.dict(os.environ,{"SERVICE":"next-target-backend","TASK_DEFINITION":str(primary),"ROLLBACK_TASK_DEFINITION":str(rollback)},clear=True), self.assertRaises(ValueError):
                pause.main()
            self.assertEqual(primary.read_text(),before)
            self.assertEqual(rollback.read_text(),'{}')

    def test_paused_config_boots_without_a_worker_database(self):
        root=os.environ.get("VAYADA_WORKER_IMAGE_FIXTURE_ROOT")
        if not root:self.skipTest("Pass compiled app path for cross-repo config check")
        config=(Path(root)/"apps/api/dist/config.js").as_uri()
        routing=(Path(root)/"apps/api/dist/channexManagementDatabaseRouting.js").as_uri()
        env={e["name"]:e["value"] for e in pause.pause_worker(fixture())["containerDefinitions"][0]["environment"]}
        env.update({"CHANNEX_API_BASE_URL":"https://app.channex.io","CHANNEX_API_KEY":"synthetic","TARGET_DATABASE_URL":"postgresql://general@localhost/test","PMS_OPERATIONS_SOURCE":"target"})
        code=f"import {{loadConfig}} from {json.dumps(config)}; import {{resolveChannexManagementDatabaseRouting as route}} from {json.dumps(routing)}; const c=loadConfig({json.dumps(env)}).channexManagement; if(c.workerEnabled || Object.keys(route({{config:c,commandsMutating:true}})).length) throw Error('Worker must stay paused');"
        result=subprocess.run(["node","--input-type=module","-e",code],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_terraform_matches_deployment_pause(self):
        terraform=(ROOT/"infra/ecs.tf").read_text()
        for key,value in pause.PAUSED_ENV.items():
            if key in pause.CONNECTION_ENV or key in pause.CLAIMED_BOOKING_ENV:continue
            self.assertIn(f'{{ name = "{key}", value = "{value}" }}',terraform)
        # VAY-2108: booking sync and the claimed settings follow channex_claimed_scope only.
        self.assertIn('{ name = "PMS_CHANNEX_BOOKING_SYNC_MODE", value = var.channex_claimed_scope == "off" ? "observe_only" : "mutating" }',terraform)
        self.assertIn('], var.channex_claimed_scope == "off" ? [] : [\n        { name = "PMS_CHANNEX_SCOPE", value = "claimed" },\n        { name = "PMS_CHANNEX_OWNED_PROPERTY_IDS", value = join(",", var.channex_owned_property_ids) },\n        { name = "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE", value = "target-owned" },\n      ])',terraform)
        self.assertIn('var.channex_claimed_scope == "off" || var.channex_connection_worker_enabled',terraform)
        self.assertIn('{ name = "CHANNEX_WEBHOOK_INTAKE_MODE", value = "observe_only" }',terraform)
        variables=(ROOT/"infra/channex_claimed_scope.tf").read_text()
        self.assertIn('contains(["off", "booking"], var.channex_claimed_scope)',variables)
        for reserved in pause.RESERVED_PROPERTY_IDS:self.assertIn(f'"{reserved}"',variables)
        # VAY-2055: only the worker flag and connection mode follow the reviewed variables.
        self.assertIn('{ name = "PMS_CHANNEX_WORKER_ENABLED", value = tostring(var.channex_connection_worker_enabled) }',terraform)
        self.assertIn('{ name = "PMS_CHANNEX_CONNECTION_MODE", value = var.channex_connection_worker_enabled ? "mutating" : "observe_only" }',terraform)
        self.assertIn('(var.channex_connection_worker_secret_mapped || var.channex_connection_worker_enabled) ? [\n        { name = "PMS_CHANNEX_MANAGEMENT_DATABASE_URL", valueFrom = "/vayada/prod/target-database-channex-management-worker-url" },',terraform)
        self.assertIn('!var.channex_connection_worker_enabled || var.channex_connection_worker_secret_mapped',terraform)

    def connection_fixture(self,secret=pause.WORKER_SECRET_PARAMETER):
        task=fixture()
        container=task["containerDefinitions"][0]
        container["environment"]+=[{"name":"PMS_CHANNEX_WORKER_ENABLED","value":"true"}]
        if secret:container["secrets"].append({"name":pause.WORKER_SECRET_NAME,"valueFrom":secret})
        return task

    def test_declared_connection_scope_is_preserved_and_everything_else_stays_paused(self):
        for secret in (pause.WORKER_SECRET_PARAMETER,"arn:aws:ssm:eu-west-1:269416271598:parameter"+pause.WORKER_SECRET_PARAMETER):
            task=self.connection_fixture(secret)
            task["containerDefinitions"][0]["environment"].append({"name":"PMS_CHANNEX_ARI_SYNC_MODE","value":"mutating"})
            env={e["name"]:e["value"] for e in pause.pause_worker(task)["containerDefinitions"][0]["environment"]}
            self.assertEqual(env,{"PMS_CHANNEX_REVIEWS_MODE":"mutating",**pause.PAUSED_ENV,**pause.CONNECTION_ENV})
            once=pause.pause_worker(copy.deepcopy(task));self.assertEqual(once,pause.pause_worker(copy.deepcopy(once)))

    def test_mapped_secret_alone_or_partial_declaration_stays_paused(self):
        for mutate in (lambda c:c["environment"].remove({"name":"PMS_CHANNEX_WORKER_ENABLED","value":"true"}),
                       lambda c:c["environment"].remove({"name":"PMS_CHANNEX_CONNECTION_MODE","value":"mutating"})):
            task=self.connection_fixture();mutate(task["containerDefinitions"][0])
            env={e["name"]:e["value"] for e in pause.pause_worker(task)["containerDefinitions"][0]["environment"]}
            self.assertEqual(env,{"PMS_CHANNEX_REVIEWS_MODE":"mutating",**pause.PAUSED_ENV})

    def test_connection_scope_without_or_with_wrong_secret_is_paused_or_rejected(self):
        env={e["name"]:e["value"] for e in pause.pause_worker(self.connection_fixture(None))["containerDefinitions"][0]["environment"]}
        self.assertEqual(env,{"PMS_CHANNEX_REVIEWS_MODE":"mutating",**pause.PAUSED_ENV})
        for secret in ("/vayada/prod/target-database-runtime-url","/vayada/prod/target-database-url"):
            with self.assertRaises(ValueError):pause.pause_worker(self.connection_fixture(secret))
        task=self.connection_fixture();task["containerDefinitions"][0]["secrets"].append({"name":pause.WORKER_SECRET_NAME,"valueFrom":pause.WORKER_SECRET_PARAMETER})
        with self.assertRaises(ValueError):pause.pause_worker(task)
        task=self.connection_fixture();task["containerDefinitions"][0]["environment"].append({"name":"PMS_CHANNEX_WORKER_ENABLED","value":"false"})
        env={e["name"]:e["value"] for e in pause.pause_worker(task)["containerDefinitions"][0]["environment"]}
        self.assertEqual(env,{"PMS_CHANNEX_REVIEWS_MODE":"mutating",**pause.PAUSED_ENV})

    OWNED="0f0e2b9c-1d3a-4c5b-8e7f-1a2b3c4d5e6f,7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d"

    def claimed_fixture(self,owned=OWNED):
        task=self.connection_fixture()
        task["containerDefinitions"][0]["environment"]+=[
            {"name":"PMS_CHANNEX_SCOPE","value":"claimed"},{"name":"PMS_CHANNEX_BOOKING_SYNC_MODE","value":"mutating"},
            {"name":"CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE","value":"target-owned"},
            {"name":"PMS_CHANNEX_OWNED_PROPERTY_IDS","value":owned},{"name":"CHANNEX_WEBHOOK_INTAKE_MODE","value":"observe_only"}]
        return task

    def env(self,task):
        return {e["name"]:e["value"] for e in pause.pause_worker(task)["containerDefinitions"][0]["environment"]}

    def test_declared_claimed_booking_scope_is_preserved_on_the_connection_scope(self):
        base={"PMS_CHANNEX_REVIEWS_MODE":"mutating","CHANNEX_WEBHOOK_INTAKE_MODE":"observe_only",**pause.PAUSED_ENV,**pause.CONNECTION_ENV}
        for owned in (self.OWNED,""):
            task=self.claimed_fixture(owned)
            task["containerDefinitions"][0]["environment"].append({"name":"PMS_CHANNEX_ARI_SYNC_MODE","value":"mutating"})
            self.assertEqual(self.env(task),{**base,**pause.CLAIMED_BOOKING_ENV,"PMS_CHANNEX_OWNED_PROPERTY_IDS":owned})
            once=pause.pause_worker(copy.deepcopy(task));self.assertEqual(once,pause.pause_worker(copy.deepcopy(once)))

    def test_anything_short_of_the_exact_claimed_shape_falls_back_without_claimed_settings(self):
        def set_env(name,value):
            def mutate(c):
                c["environment"]=[e for e in c["environment"] if e["name"]!=name]+([{"name":name,"value":value}] if value is not None else [])
            return mutate
        cases=[set_env("PMS_CHANNEX_SCOPE",None),set_env("PMS_CHANNEX_SCOPE","staging"),
               set_env("PMS_CHANNEX_BOOKING_SYNC_MODE","observe_only"),set_env("CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE","legacy-owned"),
               set_env("CHANNEX_WEBHOOK_INTAKE_MODE","mutating"),set_env("PMS_CHANNEX_OWNED_PROPERTY_IDS",None),
               set_env("PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID","65f6b2fc-c783-4963-9d6b-a85f82319769"),
               lambda c:c["environment"].append({"name":"PMS_CHANNEX_OWNED_PROPERTY_IDS","value":""})]
        first,second=self.OWNED.split(",")
        for owned in (f"{first},{first}",first.upper(),f"{first}, {second}",f"{first},","65f6b2fc-c783-4963-9d6b-a85f82319769","not-a-uuid"):
            cases.append(set_env("PMS_CHANNEX_OWNED_PROPERTY_IDS",owned))
        for mutate in cases:
            task=self.claimed_fixture();mutate(task["containerDefinitions"][0])
            env=self.env(task)
            self.assertEqual({k:env[k] for k in pause.PAUSED_ENV},{**pause.PAUSED_ENV,**pause.CONNECTION_ENV})
            self.assertFalse({"PMS_CHANNEX_SCOPE","PMS_CHANNEX_OWNED_PROPERTY_IDS","CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE"}&env.keys())
        # Without the connection scope the claimed declaration is paused with everything else.
        task=self.claimed_fixture();set_env("PMS_CHANNEX_WORKER_ENABLED","false")(task["containerDefinitions"][0])
        env=self.env(task)
        self.assertEqual({k:env[k] for k in pause.PAUSED_ENV},pause.PAUSED_ENV)
        self.assertFalse({"PMS_CHANNEX_SCOPE","PMS_CHANNEX_OWNED_PROPERTY_IDS"}&env.keys())

    def test_claimed_settings_cannot_come_from_a_secret(self):
        for name in ("PMS_CHANNEX_SCOPE","PMS_CHANNEX_OWNED_PROPERTY_IDS","CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE"):
            task=self.claimed_fixture();task["containerDefinitions"][0]["secrets"].append({"name":name,"valueFrom":"unsafe"})
            with self.assertRaises(ValueError):pause.pause_worker(task)


if __name__ == "__main__":unittest.main()
