#!/usr/bin/env python3
"""Create the VAY-2038 identity URL in SSM without putting credentials in argv or logs."""

import json
import secrets
import subprocess
import sys
from urllib.parse import quote, urlsplit, urlunsplit


REGION = "eu-west-1"
ACCOUNT = "269416271598"
HOST = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com"
OWNER_PARAMETER = "/vayada/prod/target-database-url"
IDENTITY_PARAMETER = "/vayada/prod/target-database-identity-runtime-url"


def aws(*args, payload=None):
    result = subprocess.run(
        ["aws", *args, "--region", REGION], input=payload,
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise RuntimeError("aws_command_failed")
    return json.loads(result.stdout)


def main():
    mode = sys.argv[1:] if len(sys.argv) == 2 else []
    if mode not in (["--check"], ["--create"]):
        raise RuntimeError("expected_check_or_create")
    if aws("sts", "get-caller-identity")["Account"] != ACCOUNT:
        raise RuntimeError("unexpected_aws_account")
    owner = aws("ssm", "get-parameter", "--name", OWNER_PARAMETER, "--with-decryption")
    url = urlsplit(owner["Parameter"]["Value"])
    if (url.scheme != "postgresql" or url.hostname != HOST or url.port != 5432 or
            url.query != "sslmode=require" or not url.path or url.fragment):
        raise RuntimeError("owner_database_url_untrusted")
    existing = aws("ssm", "describe-parameters", "--parameter-filters",
                   f"Key=Name,Option=Equals,Values={IDENTITY_PARAMETER}")
    if existing["Parameters"]:
        raise RuntimeError("identity_parameter_already_exists")
    if mode == ["--check"]:
        print(json.dumps({"status": "PASS", "mode": "check"}))
        return
    password = secrets.token_urlsafe(48)
    identity_url = urlunsplit((
        "postgresql", f"vayada_next_identity_runtime:{quote(password, safe='')}@{HOST}:5432",
        url.path, url.query, "",
    ))
    aws("ssm", "put-parameter", "--cli-input-json", "file:///dev/stdin", payload=json.dumps({
        "Name": IDENTITY_PARAMETER, "Type": "SecureString", "KeyId": "alias/aws/ssm",
        "Value": identity_url, "Overwrite": False,
        "Tags": [
            {"Key": "Project", "Value": "vayada"},
            {"Key": "Environment", "Value": "production"},
            {"Key": "Purpose", "Value": "VAY-2038-identity-runtime"},
        ],
    }))
    print(json.dumps({"status": "PASS", "mode": "create", "parameter": IDENTITY_PARAMETER}))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, RuntimeError):
        print(json.dumps({"status": "FAIL", "code": "identity_secret_preparation_failed"}), file=sys.stderr)
        sys.exit(1)
