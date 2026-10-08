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
            if key in pause.CONNECTION_ENV:continue
            self.assertIn(f'{{ name = "{key}", value = "{value}" }}',terraform)
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
            self.assertEqual(pause.pause_worker(task),pause.pause_worker(pause.pause_worker(task)))

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


if __name__ == "__main__":unittest.main()
