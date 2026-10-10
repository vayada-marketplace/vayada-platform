"""VAY-1362: read-only counts for go-day planning, one database per disposable task.

Runs as `python -I -c` in a one-off task (`scripts/legacy-migration-oneoff.sh readonly-counts`),
once per database kind (COUNTS_KIND = PMS, BOOKING or TARGET). Each task holds only that
database's secret:
- PMS and BOOKING run the printed aggregate blocks of the reviewed counts file;
- TARGET runs the reviewed 6c pre-deploy check on the production target, each SELECT wrapped as
  SELECT count(*), so no target row is ever printed.

Every connection is pinned (RDS host, port 5432, database and user) and uses TLS verified against
the pinned RDS CA. Every statement runs inside BEGIN TRANSACTION READ ONLY ... ROLLBACK and must be
one plain SELECT: only allow-listed functions, no string concatenation, no comments, no $ or E''
strings, no quoted identifiers. Printed blocks may select only allow-listed aggregates and reviewed
label columns.
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
PRINTED_FUNCTIONS = {"count", "max", "min", "bool_or", "coalesce", "jsonb_array_length"}
COUNTED_FUNCTIONS = {"count", "trunc", "jsonb_array_elements"}
# Keywords that a parenthesis may follow without being a function call.
PAREN_KEYWORDS = {"as", "in", "values", "exists", "filter", "from", "join", "on", "using", "where", "and", "or", "not", "select"}
# Labels a printed block may group by and print: reviewed, non-personal columns.
LABELS = r"(?:[a-z_]\w*\.)?(?:label|stripe_billing_status|billing_active_plan|currency|hotel_id|payment_provider|flexible_cancellation_type|custom_domain)"
# Hotel identity (id and public name/slug) may be printed as a label, but only from a legacy hotels
# table: hotels (PMS) or booking_hotels (Booking).
HOTEL_TABLES = ("hotels", "booking_hotels")
HOTEL_LABELS = ("id", "name", "slug")
TIME_COLUMNS = r"\w*(_at|_date)|check_in|check_out"
# Reviewed numeric hotel settings that min()/max() may print as they are.
NUMBERS = r"free_cancellation_days|markup_pct|partial_refund_cancel_window_days|partial_refund_amount_percent"
# Reviewed numbers inside room_types.partial_refund_tiers that min()/max() may print: the tier count, and one
# tier's days or percent, cast to a number.
TIER_NUMBERS = (r"jsonb_array_length\(\s*(?:[a-z_]\w*\.)?partial_refund_tiers\s*\)"
                r"|\(\s*(?:[a-z_]\w*\.)?partial_refund_tiers\s*->\s*\d\s*->>\s*'(?:min_days_before_check_in|refund_percent)'\s*\)"
                r"\s*::\s*(?:int|integer|numeric)")
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
    # $ and " are refused outside string literals (no dollar quotes, parameters or quoted identifiers).
    # Inside a literal they are plain characters (jsonpath, regex): standard_conforming_strings is
    # forced on in the transaction, so the server reads every literal exactly as blank_strings does.
    if WRITES.search(bare) or re.search(r'(?i)--|/\*|\*/|u&|(?<![a-z0-9_])e\'', statement) or re.search(r'["$]', bare):
        raise ValueError(f"{name}_not_read_only")
    if "||" in bare:
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


def hotel_aliases(bare, begin, start):
    """Names that refer to a legacy hotels table (HOTEL_TABLES) in the top-level FROM: its alias,
    or the table name itself when it is referenced without one.

    Every appearance of a hotels table name must be a table reference right after FROM/JOIN, a
    `<table>.<column>` reference, or an output column name in the printed SELECT list (begin to
    start). It may not alias another relation or a subquery, be schema qualified, name a CTE, or
    carry a column alias list, so nothing else can pose as a hotels table."""
    clauses = r"(?:on|where|join|left|right|inner|outer|cross|full|natural|group|order|having|limit|using)\b"
    zero, aliases = depth_zero(bare), set()
    for match in re.finditer(rf"(?i)\b(?:{'|'.join(HOTEL_TABLES)})\b", bare):
        before, after = bare[:match.start()].rstrip(), bare[match.end():]
        if before.endswith("."):
            raise ValueError("hotels_qualified")
        if not re.search(r"(?i)\b(?:from|join)$", before):
            if re.match(r"\s*\.", after):
                continue  # a hotels.<column> reference
            if begin <= match.start() < start and match.start() in zero and re.search(r"(?i)\bas$", before):
                continue  # an output column name, such as count(...) AS hotels
            raise ValueError("hotels_name_reused")
        alias = re.match(rf"(?i)\s+(?:as\s+)?(?!{clauses})([a-z_]\w*)", after)
        if re.match(r"\s*\(", after[alias.end():] if alias else after):
            raise ValueError("hotels_column_alias_list")
        if match.start() >= start and match.start() in zero:
            aliases.add((alias.group(1) if alias else match.group(0)).lower())
    return aliases


def is_label(item, aliases):
    if re.fullmatch(LABELS, item, re.I) or re.fullmatch(rf"(?is)coalesce\(\s*{LABELS}\s*,\s*'[^']*'\s*\)", item):
        return True
    hotel = re.fullmatch(r"(?i)([a-z_]\w*)\.([a-z_]\w*)", item)
    return bool(hotel) and hotel.group(1).lower() in aliases and hotel.group(2).lower() in HOTEL_LABELS


def closing(bare, opening):
    """Index of the parenthesis that closes the one at `opening`, in string-blanked text."""
    depth = 0
    for index in range(opening, len(bare)):
        depth += {"(": 1, ")": -1}.get(bare[index], 0)
        if depth == 0:
            return index
    raise ValueError("unbalanced_parentheses")


def aggregate_or_label(item, aliases):
    """One printed column: a reviewed label, or exactly one allow-listed aggregate with nothing after
    it but a cast (count may also carry one FILTER (WHERE ...) clause)."""
    item = re.sub(r"(?is)\s+as\s+[a-z_]\w*$", "", item.strip())
    if is_label(item, aliases):
        return "label"
    bare = blank_strings(item)  # parentheses inside string literals must not end the call early
    call = re.match(r"(?i)(count|max|min|bool_or)\s*\(", bare)
    if not call:
        return None
    end = closing(bare, call.end() - 1)
    kind, argument, rest = call.group(1).lower(), bare[call.end():end], bare[end + 1:]
    if kind == "count":
        if re.match(r"(?i)\s*filter\s*\(\s*where\b", rest):
            rest = rest[closing(rest, rest.index("(")) + 1:]
        return "aggregate" if re.fullmatch(r"(?i)\s*(::\s*[a-z_]+)?\s*", rest) else None
    if kind == "bool_or":
        # A boolean: it tells no more than count(*) FILTER (WHERE ...) does.
        return "aggregate" if not rest.strip() else None
    # min/max print a reviewed label or numeric setting as it is, or a time column cast to a date or
    # timestamp, so no other value can print.
    if re.fullmatch(rf"(?i)\s*(?:{LABELS}|(?:[a-z_]\w*\.)?(?:{NUMBERS}))\s*", argument):
        return "aggregate" if not rest.strip() else None
    if re.fullmatch(rf"(?i)\s*(?:{TIER_NUMBERS})\s*", item[call.end():end]):  # the key names are string literals
        return "aggregate" if not rest.strip() else None
    if re.fullmatch(rf"(?i)\s*(?:[a-z_]\w*\.)?(?:{TIME_COLUMNS})\s*", argument):
        return "aggregate" if re.fullmatch(r"(?i)\s*::\s*(date|timestamp|timestamptz)\s*", rest) else None
    return None


def printed_shape(statement, name):
    """The top-level SELECT list holds only aggregates and reviewed labels; GROUP BY only labels."""
    bare = blank_strings(statement)
    if top_level(statement, bare, r"\b(union|intersect|except)\b"):
        raise ValueError(f"{name}_combines_selects")  # every printed row must come from the checked SELECT list
    selects = top_level(statement, bare, r"\bselect\b")
    if not selects:
        raise ValueError(f"{name}_not_aggregate")
    begin = selects[-1].end()
    froms = top_level(statement, bare, r"\bfrom\b", begin)
    end = begin + froms[0].start() if froms else len(statement)
    # Printed columns may come only from base tables and VALUES lists: no derived tables, no
    # LATERAL, and every CTE must be a VALUES list (the reviewed hotel labels, for example).
    stops = top_level(statement, bare, r"\b(where|group\s+by|having|order\s+by|limit)\b", end)
    sources = bare[end:end + stops[0].start()] if stops else bare[end:]
    if re.search(r"(?i)(?:\bfrom|\bjoin|,)\s*\(|\blateral\b", sources) or re.search(r"(?i)\bwith\s+recursive\b", bare):
        raise ValueError(f"{name}_derived_source")
    for cte in re.finditer(r"(?i)(?:\bwith|,)\s*[a-z_]\w*\s*(?:\([^()]*\))?\s*as\s*(?:not\s+)?(?:materialized\s*)?\(", bare):
        depth = 0
        for index in range(cte.end() - 1, len(bare)):
            depth += {"(": 1, ")": -1}.get(bare[index], 0)
            if depth == 0:
                break
        # Literal rows only: strings, numbers, NULL/TRUE/FALSE and simple casts, so no row can read a table.
        rows = re.sub(r"(?i)::\s*[a-z_]\w*|\b(?:null|true|false)\b", " ", bare[cte.end():index])
        if not re.fullmatch(r"(?i)\s*values[\s(),'0-9.+-]*", rows):
            raise ValueError(f"{name}_derived_source")
    try:
        aliases = hotel_aliases(bare, begin, end)
    except ValueError:
        raise ValueError(f"{name}_not_aggregate") from None
    kinds = [aggregate_or_label(item, aliases) for item in split_top(statement[begin:end], bare[begin:end])]
    if None in kinds or "aggregate" not in kinds:
        raise ValueError(f"{name}_not_aggregate")
    groups = top_level(statement, bare, r"\bgroup\s+by\b", end)
    if groups:
        start = end + groups[0].end()
        tail = top_level(statement, bare, r"\b(order\s+by|having|limit)\b", start)
        stop = start + tail[0].start() if tail else len(statement)
        for item in split_top(statement[start:stop], bare[start:stop]):
            if not re.fullmatch(r"\d+", item) and not is_label(item, aliases):
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
        if not stripped and not current:
            comments = []  # a blank line ends a comment block, so a file header is not a check title
            continue
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
            await connection.execute("SET LOCAL standard_conforming_strings = on")
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
    """Prints every statement as it will run. Either path may be "none" (no legacy blocks, or no
    target checks), but not both."""
    if counts_path == target_path == "none":
        raise ValueError("nothing_to_run")
    legacy = []
    if counts_path != "none":
        with open(counts_path, encoding="utf-8") as counts:
            legacy = legacy_blocks(counts.read())
    checks = []
    if target_path != "none":
        with open(target_path, encoding="utf-8") as target:
            checks = target_checks(target.read())
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
