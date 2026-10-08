"""VAY-1362: read-only aggregate counts on legacy PMS/Booking plus Stripe subscription counts.

Runs once in a one-off copy of the legacy pms-backend task
(`scripts/legacy-migration-oneoff.sh readonly-counts`). Every SQL block runs inside
BEGIN TRANSACTION READ ONLY ... ROLLBACK and may return at most 50 aggregate rows.
The reviewed SQL decides that rows are aggregates; this file enforces one SELECT per
block, blocks side-effect functions that work even in read-only transactions, and caps rows.
Stripe output is a count per subscription status (all, and fixed-plan only):
no IDs, emails or amounts.
The output is Markdown; the operator script saves it as readonly-counts-result.md.
"""
import asyncio
import collections
import os
import re
import sys

HEADER = re.compile(r"^-- \((\d+)\) LEGACY (PMS|BOOKING) database: (.+)$", re.M)
DATABASE_URLS = {"PMS": "DATABASE_URL", "BOOKING": "BOOKING_ENGINE_DATABASE_URL"}
STATUSES = ("active", "past_due", "trialing", "incomplete", "unpaid", "canceled")
MAX_ROWS = 50
# These run even inside a read-only transaction, so the reviewed SQL may not call them.
SIDE_EFFECTS = re.compile(
    r"(?i)\b(pg_terminate_backend|pg_cancel_backend|pg_sleep\w*|pg_advisory\w*|dblink\w*|lo_\w+|"
    r"pg_read_\w+|pg_ls_\w+|pg_stat_reset\w*|set_config|nextval|setval|pg_notify)\b"
)


def blocks(sql):
    """Split the reviewed file into (number, database, title, single SELECT) blocks."""
    headers = list(HEADER.finditer(sql))
    if not headers:
        raise ValueError("no_blocks")
    parsed = []
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(sql)
        lines = [line for line in sql[header.end():end].splitlines() if not line.lstrip().startswith("--")]
        statement = "\n".join(lines).strip().removesuffix(";").rstrip()
        if ";" in statement or not re.match(r"(?i)(select|with)\b", statement):
            raise ValueError(f"block_{header.group(1)}_not_one_select")
        if SIDE_EFFECTS.search(statement):
            raise ValueError(f"block_{header.group(1)}_calls_side_effect_function")
        parsed.append((header.group(1), header.group(2), header.group(3).strip(), statement))
    return parsed


def cell(value):
    return value if value is None or isinstance(value, (int, str)) else str(value)


async def run_block(url, statement):
    import asyncpg

    connection = await asyncpg.connect(url)
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


def main():
    print("# VAY-1362 read-only counts")
    for number, database, title, statement in blocks(os.environ["COUNTS_SQL"]):
        columns, rows = asyncio.run(run_block(os.environ[DATABASE_URLS[database]], statement))
        print(f"## Block {number}: legacy {database}, {title}")
        if not columns:
            print("No rows.")
            continue
        print("| " + " | ".join(columns) + " |")
        print("|" + "---|" * len(columns))
        for row in rows:
            print("| " + " | ".join("" if value is None else str(value) for value in row) + " |")
    print("## Stripe platform account: subscriptions per status")
    print("| status | all | fixed_plan |")
    print("|---|---|---|")
    for status, total, fixed in stripe_counts():
        print(f"| {status} | {total} | {fixed} |")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--check"]:
        with open(sys.argv[2], encoding="utf-8") as handle:
            print(f"{len(blocks(handle.read()))} read-only blocks")
        sys.exit(0)
    try:
        main()
    except Exception as error:  # Only our own codes or the error type, never driver messages.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z0-9_]+", str(error)) else type(error).__name__
        print(f"COUNTS_FAILED: {code}")
        sys.exit(1)
