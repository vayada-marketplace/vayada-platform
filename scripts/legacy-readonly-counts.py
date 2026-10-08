"""VAY-1362: read-only counts for go-day planning, one database per disposable task.

Runs as `python -I -c` in a one-off task (`scripts/legacy-migration-oneoff.sh readonly-counts`),
once per database kind (COUNTS_KIND = PMS, BOOKING or TARGET). Each task holds only that
database's secret:
- PMS and BOOKING run the printed aggregate blocks of the reviewed counts file;
- TARGET runs the reviewed 6c pre-deploy check on the production target, each SELECT wrapped as
  SELECT count(*), so no target row is ever printed.

Every connection is pinned (RDS host, port 5432, database and user) and uses TLS verified against
the pinned RDS CA. Every statement runs inside BEGIN TRANSACTION READ ONLY ... ROLLBACK and must be
one plain SELECT: only allow-listed functions, no comments, no $ or E'' strings, no quoted
identifiers. Printed blocks may select only allow-listed aggregates and reviewed label columns.
"""
import asyncio
import hashlib
import os
import re
import ssl
import sys
from urllib.parse import unquote, urlsplit

HOST = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com"
PORT = 5432
CA_SHA256 = "f5c5f92ae025987c76dc49bdb1ace8556fdf332b4788d719a923bc274779d869"
# Kind -> (secret variable, pinned database, pinned user).
DATABASES = {
    "PMS": ("DATABASE_URL", "vayada_pms_db", "vayada_pms_user"),
    "BOOKING": ("BOOKING_ENGINE_DATABASE_URL", "vayada_booking_db", "vayada_booking_user"),
    "TARGET": ("TARGET_DATABASE_URL", "vayada_target_prod", "vayada_target_prod_user"),
}
HEADER = re.compile(r"^-- \((\d+)\) LEGACY (PMS|BOOKING) database: (.+)$", re.M)
MAX_ROWS = 50
COMPLETE = "COUNTS_COMPLETE"
# Only the functions the reviewed files use. Printed blocks and the counted 6c checks differ.
PRINTED_FUNCTIONS = {"count", "max", "coalesce"}
COUNTED_FUNCTIONS = {"count", "array_agg"}
# Keywords that a parenthesis may follow without being a function call.
PAREN_KEYWORDS = {"as", "in", "values", "exists", "filter", "from", "join", "on", "where", "and", "or", "not", "select"}
# Labels a printed block may group by and print: reviewed, non-personal columns.
LABELS = r"(?:[a-z_]\w*\.)?(?:label|stripe_billing_status|billing_active_plan)"
WRITES = re.compile(
    r"(?i)\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|lock|vacuum|analyze|"
    r"cluster|reindex|refresh|comment|import|listen|notify|prepare|execute|into|share|returning)\b"
)


def blank_strings(statement):
    """Same-length copy with string literal contents blanked, so positions still match."""
    out, quoted = [], False
    for character in statement:
        if character == "'":
            quoted = not quoted
            out.append(character)
        else:
            out.append(" " if quoted else character)
    if quoted:
        raise ValueError("unterminated_string")
    return "".join(out)


def depth_zero(text):
    """Character positions at parenthesis depth 0; refuses unbalanced text."""
    depth, positions = 0, []
    for index, character in enumerate(text):
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("unbalanced_parentheses")
        elif depth == 0:
            positions.append(index)
    if depth != 0:
        raise ValueError("unbalanced_parentheses")
    return set(positions)


def only_select(statement, name, functions):
    """One plain SELECT/WITH that can only read and calls only allow-listed functions."""
    try:
        bare = blank_strings(statement)
        depth_zero(bare)
    except ValueError:
        raise ValueError(f"{name}_not_one_select") from None
    if ";" in bare or not re.match(r"(?i)(select|with)\b", statement):
        raise ValueError(f"{name}_not_one_select")
    if WRITES.search(bare) or re.search(r'(?i)--|/\*|\*/|"|\$|u&|(?<![a-z0-9_])e\'', statement):
        raise ValueError(f"{name}_not_read_only")
    if "||" in bare and functions is PRINTED_FUNCTIONS:
        raise ValueError(f"{name}_concatenates")
    ctes = {match.start(1) for match in re.finditer(r"(?i)(?:\bwith|,)\s*([a-z_]\w*)\s*\([^()]*\)\s*as\s*\(", bare)}
    for match in re.finditer(r"([A-Za-z_]\w*)\s*\(", bare):
        called = match.group(1).lower()
        if match.start(1) in ctes or called in PAREN_KEYWORDS:
            continue
        if called not in functions or (match.start(1) > 0 and bare[match.start(1) - 1] == "."):
            raise ValueError(f"{name}_calls_{called}"[:60] if re.fullmatch(r"[a-z0-9_]+", called) else f"{name}_calls_function")
    return statement


def top_level(statement, bare, keyword_pattern, start=0):
    zero = depth_zero(bare)
    return [m for m in re.finditer(keyword_pattern, bare[start:], re.I) if m.start() + start in zero]


def split_top(original, bare):
    zero, parts, last = depth_zero(bare), [], 0
    for index, character in enumerate(bare):
        if character == "," and index in zero:
            parts.append(original[last:index])
            last = index + 1
    return [part.strip() for part in parts + [original[last:]]]


def aggregate_or_label(item):
    item = re.sub(r"(?is)\s+as\s+[a-z_]\w*$", "", item.strip())
    if re.fullmatch(LABELS, item, re.I) or re.fullmatch(rf"(?is)coalesce\(\s*{LABELS}\s*,\s*'[^']*'\s*\)", item):
        return "label"
    call = re.match(r"(?i)(count|max)\s*\(", item)
    if not call:
        return None
    depth = 0
    for index in range(call.end() - 1, len(item)):
        depth += {"(": 1, ")": -1}.get(item[index], 0)
        if depth == 0:
            break
    argument, rest = item[call.end():index], item[index + 1:]
    if call.group(1).lower() == "max" and not re.fullmatch(r"(?i)\s*(?:[a-z_]\w*\.)?\w*(_at|_date)\s*", argument):
        return None  # max may only summarise a time column, never print a text value
    return "aggregate" if re.fullmatch(r"(?is)\s*(filter\s*\(\s*where\b.*\))?\s*(::\s*[a-z_]+)?\s*", rest) else None


def printed_shape(statement, name):
    """The top-level SELECT list holds only aggregates and reviewed labels; GROUP BY only labels."""
    bare = blank_strings(statement)
    selects = top_level(statement, bare, r"\bselect\b")
    if not selects:
        raise ValueError(f"{name}_not_aggregate")
    begin = selects[-1].end()
    froms = top_level(statement, bare, r"\bfrom\b", begin)
    end = begin + froms[0].start() if froms else len(statement)
    kinds = [aggregate_or_label(item) for item in split_top(statement[begin:end], bare[begin:end])]
    if None in kinds or "aggregate" not in kinds:
        raise ValueError(f"{name}_not_aggregate")
    groups = top_level(statement, bare, r"\bgroup\s+by\b", end)
    if groups:
        start = end + groups[0].end()
        tail = top_level(statement, bare, r"\b(order\s+by|having|limit)\b", start)
        stop = start + tail[0].start() if tail else len(statement)
        for item in split_top(statement[start:stop], bare[start:stop]):
            if not re.fullmatch(rf"(?is)\d+|{LABELS}|coalesce\(\s*{LABELS}\s*,\s*'[^']*'\s*\)", item):
                raise ValueError(f"{name}_groups_by_unreviewed_column")
    elif "label" in kinds:
        raise ValueError(f"{name}_not_aggregate")


def legacy_blocks(sql):
    """Blocks headed `-- (N) LEGACY PMS|BOOKING database: title`, one printed aggregate each."""
    headers = list(HEADER.finditer(sql))
    if not headers:
        raise ValueError("no_legacy_blocks")
    parsed = []
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(sql)
        lines = [line for line in sql[header.end():end].splitlines() if not line.lstrip().startswith("--")]
        name = f"block_{header.group(1)}"
        statement = only_select("\n".join(lines).strip().removesuffix(";").rstrip(), name, PRINTED_FUNCTIONS)
        printed_shape(statement, name)
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
            number = str(len(checks) + 1)
            only_select(statement, f"check_{number}", COUNTED_FUNCTIONS)
            title = " ".join(comments)[:200] or f"check {number}"
            checks.append((number, title, f"SELECT count(*) AS rows_found FROM (\n{statement}\n) AS check_rows"))
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
    variable, database, user = DATABASES[kind]
    url = urlsplit(os.environ[variable])
    if (url.scheme not in ("postgres", "postgresql") or url.hostname != HOST or (url.port or PORT) != PORT
            or url.path != f"/{database}" or unquote(url.username or "") != user or not url.password):
        raise ValueError(f"{kind.lower()}_database_not_pinned")
    return {"host": HOST, "port": PORT, "database": database, "user": user, "password": unquote(url.password)}


def cell(value):
    return value if value is None or isinstance(value, (int, str)) else str(value)


async def read_only(kind, statement, context):
    import asyncpg

    connection = await asyncpg.connect(**pinned(kind), ssl=context)
    try:
        await connection.execute("BEGIN TRANSACTION READ ONLY")
        try:
            await connection.execute("SET LOCAL statement_timeout = '15s'")
            await connection.execute("SET LOCAL lock_timeout = '1s'")
            records = await connection.fetch(statement)
        finally:
            await connection.execute("ROLLBACK")
    finally:
        await connection.close()
    if len(records) > MAX_ROWS:
        raise ValueError("too_many_rows")
    columns = list(records[0].keys()) if records else []
    return columns, [[cell(value) for value in record.values()] for record in records]


def table(columns, rows):
    if not columns:
        print("No rows.")
        return
    print("| " + " | ".join(columns) + " |")
    print("|" + "---|" * len(columns))
    for row in rows:
        print("| " + " | ".join("" if value is None else str(value) for value in row) + " |")


def main():
    kind = os.environ["COUNTS_KIND"]
    if kind not in DATABASES:
        raise ValueError("kind_invalid")
    # Every input is checked before the connection opens.
    if kind == "TARGET":
        work = [(number, title, statement) for number, title, statement in target_checks(os.environ["TARGET_CHECK_SQL"])]
    else:
        work = [(number, title, statement) for number, block_kind, title, statement in legacy_blocks(os.environ["COUNTS_SQL"])
                if block_kind == kind]
    context = tls_context()
    pinned(kind)
    _, database, _ = DATABASES[kind]
    for number, title, statement in work:
        columns, rows = asyncio.run(read_only(kind, statement, context))
        if kind == "TARGET":
            if columns != ["rows_found"] or len(rows) != 1:
                raise ValueError("target_check_not_one_count")
            print(f"## Check {number} ({database}): {title}")
        else:
            print(f"## Block {number}: legacy {kind} ({database}), {title}")
        table(columns, rows)
    print(f"{COMPLETE} kind={kind} statements={len(work)}")


def plan(counts_path, target_path):
    with open(counts_path, encoding="utf-8") as counts, open(target_path, encoding="utf-8") as target:
        legacy, checks = legacy_blocks(counts.read()), target_checks(target.read())
    for number, kind, title, statement in legacy:
        variable, database, user = DATABASES[kind]
        print(f"Block {number} on {database} as {user} ({variable}): {title}\n{statement}\n")
    variable, database, user = DATABASES["TARGET"]
    for number, title, statement in checks:
        print(f"Check {number} on {database} as {user} ({variable}): {title}\n{statement}\n")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--plan"] and len(sys.argv) == 4:
        plan(sys.argv[2], sys.argv[3])
        sys.exit(0)
    if sys.argv[1:2] == ["--kinds"] and len(sys.argv) == 3:
        with open(sys.argv[2], encoding="utf-8") as handle:
            print(" ".join(sorted({kind for _, kind, _, _ in legacy_blocks(handle.read())}, key=list(DATABASES).index)))
        sys.exit(0)
    try:
        main()
    except Exception as error:  # Only our own codes or the error type, never driver messages.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z0-9_]+", str(error)) else type(error).__name__
        print(f"COUNTS_FAILED: {code}")
        sys.exit(1)
