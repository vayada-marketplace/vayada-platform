"""Image-owned synthetic revision and health for isolated recovery scenarios."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


REVISION = Path("/fixture-variant").read_text()
if REVISION not in {"baseline", "good", "bad"}:
    raise ValueError("Unknown synthetic fixture revision")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in {"/health", "/live"}:
            self.send_error(404)
            return
        healthy = self.path == "/live" or REVISION != "bad"
        body = json.dumps({
            "status": "ok" if healthy else "unhealthy",
            "service": os.environ["FIXTURE_SERVICE"],
            "revision": REVISION,
        }).encode()
        self.send_response(200 if healthy else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
