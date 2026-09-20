import importlib.util
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("fixture", Path(__file__).with_name("fixture.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class FixtureTests(unittest.TestCase):
    def test_revision_identity_and_failure_are_observable(self):
        server = fixture.ThreadingHTTPServer(("127.0.0.1", 0), fixture.Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with mock.patch.dict(os.environ, {
                "FIXTURE_SERVICE": "api", "FIXTURE_REVISION": "revision-a", "FIXTURE_HEALTH": "healthy",
            }):
                with urllib.request.urlopen(base + "/health") as response:
                    self.assertEqual(json.load(response), {"status": "ok", "service": "api", "revision": "revision-a"})
                os.environ["FIXTURE_HEALTH"] = "unhealthy"
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    urllib.request.urlopen(base + "/health")
                self.assertEqual(failure.exception.code, 503)
                self.assertEqual(json.load(failure.exception)["revision"], "revision-a")
                with self.assertRaises(urllib.error.HTTPError) as missing:
                    urllib.request.urlopen(base + "/customer-data")
                self.assertEqual(missing.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
