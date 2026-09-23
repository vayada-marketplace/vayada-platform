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
FINANCE = "--finance-expense" in sys.argv
CHANNEX = "--channex-management" in sys.argv
EXPORT = "--finance-export" in sys.argv
IDENTITY_PARAMETER = (
    "/vayada/prod/target-database-channex-management-worker-url" if CHANNEX else
    "/vayada/prod/target-database-finance-expense-worker-url" if FINANCE else
    "/vayada/prod/target-database-finance-export-worker-url" if EXPORT else
    "/vayada/prod/target-database-identity-runtime-url"
)
ROLE = (
    "vayada_next_channex_management_worker" if CHANNEX else
    "vayada_next_finance_expense_worker" if FINANCE else
    "vayada_next_finance_export_worker" if EXPORT else
    "vayada_next_identity_runtime"
)


def aws(*args):
    result = subprocess.run(
        ["aws", *args, "--region", REGION],
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise RuntimeError("aws_command_failed")
    return json.loads(result.stdout)


def put_identity_parameter(parameter):
    try:
        import boto3
        session = boto3.Session(region_name=REGION)
        if session.client("sts").get_caller_identity()["Account"] != ACCOUNT:
            raise RuntimeError("unexpected_sdk_account")
        session.client("ssm").put_parameter(**parameter)
    except Exception:
        raise RuntimeError("identity_secret_write_failed") from None


def main():
    if sum((FINANCE, EXPORT, CHANNEX)) > 1:
        raise RuntimeError("conflicting_secret_scope")
    mode = [arg for arg in sys.argv[1:] if arg not in (
        "--finance-expense", "--finance-export", "--channex-management")]
    if mode not in (["--check"], ["--create"]):
        raise RuntimeError("expected_check_or_create")
    if aws("sts", "get-caller-identity")["Account"] != ACCOUNT:
        raise RuntimeError("unexpected_aws_account")
    owner = aws("ssm", "get-parameter", "--name", OWNER_PARAMETER, "--with-decryption")
    url = urlsplit(owner["Parameter"]["Value"])
    if (url.scheme != "postgresql" or url.hostname != HOST or url.port != 5432 or
            url.query != "sslmode=require" or not url.path or url.fragment or
            ((FINANCE or EXPORT or CHANNEX) and url.path != "/vayada_target_prod")):
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
        "postgresql", f"{ROLE}:{quote(password, safe='')}@{HOST}:5432",
        url.path, url.query, "",
    ))
    put_identity_parameter({
        "Name": IDENTITY_PARAMETER, "Type": "SecureString", "KeyId": "alias/aws/ssm",
        "Value": identity_url, "Overwrite": False,
        "Tags": [
            {"Key": "Project", "Value": "vayada"},
            {"Key": "Environment", "Value": "production"},
            {"Key": "Purpose", "Value": (
                "VAY-2041-channex-management" if CHANNEX else
                "VAY-2044-finance-expense" if FINANCE else
                "VAY-2045-finance-export" if EXPORT else
                "VAY-2038-identity-runtime"
            )},
        ],
    })
    print(json.dumps({"status": "PASS", "mode": "create", "parameter": IDENTITY_PARAMETER}))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, RuntimeError):
        print(json.dumps({"status": "FAIL", "code": "identity_secret_preparation_failed"}), file=sys.stderr)
        sys.exit(1)
