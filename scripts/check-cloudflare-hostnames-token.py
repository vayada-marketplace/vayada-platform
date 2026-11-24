#!/usr/bin/env python3
"""Read-only scope check for next-api's Cloudflare token (VAY-2578).

The token arrives on stdin and is never printed; only GET requests are sent:

  aws ssm get-parameter --profile vayada --region eu-west-1 \
    --name /vayada/prod/next-api-cloudflare-hostnames-token --with-decryption \
    --query Parameter.Value --output text | python3 -I scripts/check-cloudflare-hostnames-token.py

A hostname-only token can list custom hostnames and is refused DNS records and
zone settings. Exit code 0 when it is one, 1 otherwise.

The zone's legacy `permissions` list is printed for information only: for a token
holding just "SSL and Certificates: Edit" it also names #zone_settings:read/edit,
yet such a token is refused every zone setting (checked 2026-11-24).
"""
import json
import sys
import urllib.error
import urllib.request

ZONE = "77009db898599f8a81d571050e7c5f15"  # vayada.com
token = sys.stdin.read().strip()
if not token:
    sys.exit("no token on stdin")


def get(path):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4" + path,
        method="GET",
        headers={"Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


status, body = get("/user/tokens/verify")
print("token verify:", status, (body.get("result") or {}).get("status"))
# (probe, path, expected HTTP status for a hostname-only token)
probes = [
    ("custom hostnames (needed)", f"/zones/{ZONE}/custom_hostnames?per_page=1", 200),
    ("DNS records (must be refused)", f"/zones/{ZONE}/dns_records?per_page=1", 403),
    ("zone settings (must be refused)", f"/zones/{ZONE}/settings", 403),
    ("security level (must be refused)", f"/zones/{ZONE}/settings/security_level", 403),
]
ok = status == 200
for name, path, expected in probes:
    status, body = get(path)
    codes = [e.get("code") for e in body.get("errors", [])]
    match = status == expected
    ok = ok and match
    print(f"{name}: HTTP {status} codes {codes} -> {'as expected' if match else 'NOT as expected'}")
# Information only: the zone object's legacy permission names (see the docstring).
status, body = get(f"/zones/{ZONE}")
perms = (body.get("result") or {}).get("permissions") or []
print("zone read:", status, "legacy permissions (info only):", perms)
# DNS edit must never be on it, whatever the probes above say.
if any(p.startswith("#dns_records") for p in perms):
    print("legacy permissions include #dns_records -> NOT as expected")
    ok = False
print("RESULT:", "hostname-only token" if ok else "NOT a hostname-only token")
sys.exit(0 if ok else 1)
