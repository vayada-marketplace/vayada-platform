"""Synthetic recovery target. No application data or AWS credentials are needed."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        healthy = os.environ.get("FIXTURE_HEALTH", "healthy") == "healthy"
        body = json.dumps({
            "status": "ok" if healthy else "unhealthy",
            "service": os.environ["FIXTURE_SERVICE"],
            "revision": os.environ["FIXTURE_REVISION"],
        }).encode()
        self.send_response(200 if healthy else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
