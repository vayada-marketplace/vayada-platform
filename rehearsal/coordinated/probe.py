"""Private synthetic HTTP probe; never follows redirects or environment proxies."""

import ipaddress
import json
import os
import urllib.request

SERVICES = {"api", "pms", "booking-web", "booking-admin", "marketplace-web", "marketplace-admin"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def probe(targets):
    if set(targets) != SERVICES:
        raise ValueError("Probe requires exactly the six fixture identities")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    results = []
    for service, address in sorted(targets.items()):
        if ipaddress.ip_address(address) not in ipaddress.ip_network("10.229.0.0/26"):
            raise ValueError("Probe address is outside the fixture subnet")
        with opener.open(f"http://{address}:8080/health", timeout=5) as response:
            body = json.loads(response.read(4097))
            if response.status != 200 or body != {
                "status": "ok", "service": service, "revision": "bootstrap-v1",
            }:
                raise ValueError(f"Unexpected fixture identity/health for {service}")
        results.append({"service": service, "revision": "bootstrap-v1", "status": "ok"})
    return {"scope": "isolated-recovery-bootstrap", "services": results}


if __name__ == "__main__":
    print(json.dumps(probe(json.loads(os.environ["FIXTURE_TARGETS"]))), flush=True)
