"""VAY-1362: read-only counts for go-day planning.

Runs once in a disposable one-off task (`scripts/legacy-migration-oneoff.sh readonly-counts`):
legacy PMS/Booking aggregate blocks, the 6c pre-deploy check on the production target, and
Stripe subscription counts on the platform account.

- Every database is pinned (RDS host, port 5432, database name) and reached over TLS that is
  verified against the pinned RDS CA bundle embedded in the task definition.
- Every statement is one reviewed SELECT, run inside BEGIN TRANSACTION READ ONLY ... ROLLBACK.
  Anything that is not a plain read is refused before a connection opens.
- Legacy blocks must aggregate and may return at most 50 rows. Each target check is wrapped
  as SELECT count(*), so no target row is ever printed.
- Stripe output is a count per status (all, and fixed-plan only): no IDs, emails or amounts.
The Markdown output is split by the operator script into the two result files.
"""
import asyncio
import collections
import hashlib
import os
import re
import ssl
import sys
from urllib.parse import unquote, urlsplit

HOST = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com"
PORT = 5432
CA_SHA256 = "f5c5f92ae025987c76dc49bdb1ace8556fdf332b4788d719a923bc274779d869"
# Database kind -> (secret variable, pinned database name).
DATABASES = {
    "PMS": ("DATABASE_URL", "vayada_pms_db"),
    "BOOKING": ("BOOKING_ENGINE_DATABASE_URL", "vayada_booking_db"),
    "TARGET": ("TARGET_DATABASE_URL", "vayada_target_prod"),
}
HEADER = re.compile(r"^-- \((\d+)\) LEGACY (PMS|BOOKING) database: (.+)$", re.M)
STATUSES = ("active", "past_due", "trialing", "incomplete", "unpaid", "canceled")
MAX_ROWS = 50
TARGET_MARKER = "<!-- predeploy-readonly-check -->"
COMPLETE = "COUNTS_COMPLETE"
# Write keywords, row locks, any pg_* function call, transaction-id and large-object functions,
# dynamic SQL through XML, and identifier tricks that could hide a keyword.
NOT_A_READ = re.compile(
    r"(?i)\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|lock|"
    r"vacuum|analyze|cluster|reindex|refresh|comment|import|listen|notify|prepare|execute|into|share|"
    r"dblink\w*|set_config|nextval|setval|txid_\w+|\w*xact_id|\w*_to_xml|lo_\w+|lo(read|write|creat|import|export|unlink))\b"
    r"|\bpg_\w+\s*\(|u&|\"|/\*|\*/|--"
)
AGGREGATE = re.compile(r"(?i)\b(count|sum|min|max|avg|bool_or|bool_and)\s*\(")
# Printed legacy blocks may not build values out of many rows' contents.
LEAKS_ROWS = re.compile(r"(?i)\b(\w*_agg|xmlagg|\w*to_json\w*|json\w*_build\w*|\w*_to_xml)\s*\(")


def balanced(statement):
    """Parentheses balance outside string literals, so a statement cannot close a wrapper."""
    depth, quoted = 0, False
    for character in statement:
        if character == "'":
            quoted = not quoted
        elif not quoted and character in "()":
            depth += 1 if character == "(" else -1
            if depth < 0:
                return False
    return depth == 0 and not quoted


def only_select(statement, name):
    if ";" in statement or not re.match(r"(?i)(select|with)\b", statement):
        raise ValueError(f"{name}_not_one_select")
    if NOT_A_READ.search(statement) or not balanced(statement):
        raise ValueError(f"{name}_not_read_only")
    return statement


def legacy_blocks(sql):
    """Blocks headed `-- (N) LEGACY PMS|BOOKING database: title`, one aggregate SELECT each."""
    headers = list(HEADER.finditer(sql))
    if not headers:
        raise ValueError("no_legacy_blocks")
    parsed = []
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(sql)
        lines = [line for line in sql[header.end():end].splitlines() if not line.lstrip().startswith("--")]
        statement = only_select("\n".join(lines).strip().removesuffix(";").rstrip(), f"block_{header.group(1)}")
        if not AGGREGATE.search(statement) or LEAKS_ROWS.search(statement):
            raise ValueError(f"block_{header.group(1)}_not_aggregate")
        parsed.append((header.group(1), header.group(2), header.group(3).strip(), statement))
    return parsed


def target_checks(sql):
    """The reviewed 6c file: its own BEGIN/ROLLBACK are dropped, each SELECT becomes a count."""
    checks, comments, current = [], [], []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            if not current:
                comments.append(stripped.lstrip("-").strip())
            continue
        if stripped:
            current.append(line)
        if stripped.endswith(";"):
            statement = "\n".join(current).strip().removesuffix(";").rstrip()
            current = []
            if re.fullmatch(r"(?i)(begin|start transaction)( transaction)?( read only)?|rollback", statement):
                continue
            only_select(statement, f"check_{len(checks) + 1}")
            title = " ".join(comments)[:200] or f"check {len(checks) + 1}"
            checks.append((str(len(checks) + 1), title,
                           f"SELECT count(*) AS rows_found FROM (\n{statement}\n) AS check_rows"))
            comments = []
    if current or not checks:
        raise ValueError("target_checks_invalid")
    return checks


def tls_context():
    ca = os.environ["VAYADA_DB_RDS_CA_BUNDLE"]
    if hashlib.sha256(ca.encode()).hexdigest() != CA_SHA256:
        raise ValueError("rds_ca_mismatch")
    return ssl.create_default_context(cadata=ca)  # verifies the chain and the RDS hostname


def pinned(kind):
    variable, database = DATABASES[kind]
    url = urlsplit(os.environ[variable])
    if (url.scheme not in ("postgres", "postgresql") or url.hostname != HOST or (url.port or PORT) != PORT
            or url.path != f"/{database}" or not url.username or not url.password):
        raise ValueError(f"{kind.lower()}_database_not_pinned")
    return {"host": HOST, "port": PORT, "database": database,
            "user": unquote(url.username), "password": unquote(url.password)}


def cell(value):
    return value if value is None or isinstance(value, (int, str)) else str(value)


async def read_only(kind, statement, context):
    import asyncpg

    connection = await asyncpg.connect(**pinned(kind), ssl=context)
    try:
        await connection.execute("BEGIN TRANSACTION READ ONLY")
        try:
            await connection.execute("SET LOCAL statement_timeout = '60s'")
            await connection.execute("SET LOCAL lock_timeout = '2s'")
            records = await connection.fetch(statement)
        finally:
            await connection.execute("ROLLBACK")
    finally:
        await connection.close()
    if len(records) > MAX_ROWS:
        raise ValueError("too_many_rows")
    columns = list(records[0].keys()) if records else []
    return columns, [[cell(value) for value in record.values()] for record in records]


def field(value, key):
    try:
        return value[key]
    except (KeyError, TypeError):
        return None


def stripe_counts():
    """Count platform-account subscriptions per status: all, and legacy fixed-plan only."""
    import stripe

    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    counts = {"all": collections.Counter(), "fixed_plan": collections.Counter()}
    for subscription in stripe.Subscription.list(status="all", limit=100).auto_paging_iter():
        status = subscription["status"] if subscription["status"] in STATUSES else "other"
        counts["all"][status] += 1
        if field(field(subscription, "metadata"), "vayada_payment_kind") == "fixed_plan":
            counts["fixed_plan"][status] += 1
    return [(status, counts["all"][status], counts["fixed_plan"][status]) for status in (*STATUSES, "other")]


def table(columns, rows):
    if not columns:
        print("No rows.")
        return
    print("| " + " | ".join(columns) + " |")
    print("|" + "---|" * len(columns))
    for row in rows:
        print("| " + " | ".join("" if value is None else str(value) for value in row) + " |")


def main():
    # Every input is checked before the first connection.
    legacy = legacy_blocks(os.environ["COUNTS_SQL"])
    checks = target_checks(os.environ["TARGET_CHECK_SQL"])
    context = tls_context()
    for kind in DATABASES:
        pinned(kind)
    print("# VAY-1362 read-only counts")
    for number, kind, title, statement in legacy:
        print(f"## Block {number}: legacy {kind} ({DATABASES[kind][1]}), {title}")
        table(*asyncio.run(read_only(kind, statement, context)))
    print("## Stripe platform account: subscriptions per status")
    table(["status", "all", "fixed_plan"], stripe_counts())
    print(TARGET_MARKER)
    print(f"# VAY-1362-6C pre-deploy check: production target ({DATABASES['TARGET'][1]}), counts only")
    for number, title, statement in checks:
        columns, rows = asyncio.run(read_only("TARGET", statement, context))
        if columns != ["rows_found"] or len(rows) != 1:
            raise ValueError("target_check_not_one_count")
        print(f"## Check {number}: {title}")
        table(columns, rows)
    print(f"{COMPLETE} blocks={len(legacy)} checks={len(checks)}")


def plan(counts_path, target_path):
    with open(counts_path, encoding="utf-8") as counts, open(target_path, encoding="utf-8") as target:
        legacy, checks = legacy_blocks(counts.read()), target_checks(target.read())
    for number, kind, title, statement in legacy:
        print(f"Block {number} on {DATABASES[kind][1]} ({DATABASES[kind][0]}): {title}\n{statement}\n")
    for number, title, statement in checks:
        print(f"Check {number} on {DATABASES['TARGET'][1]} (TARGET_DATABASE_URL): {title}\n{statement}\n")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--plan"] and len(sys.argv) == 4:
        plan(sys.argv[2], sys.argv[3])
        sys.exit(0)
    try:
        main()
    except Exception as error:  # Only our own codes or the error type, never driver messages.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z0-9_]+", str(error)) else type(error).__name__
        print(f"COUNTS_FAILED: {code}")
        sys.exit(1)
