"""Offline tests for scripts/legacy-readonly-counts.py with a fake asyncpg module."""
import contextlib
import importlib.util
import io
import os
import ssl
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parent / "legacy-readonly-counts.py"
CA = (Path(__file__).resolve().parents[1] / "rehearsal" / "rds-ca-rsa2048-g1.pem").read_text()
HOST = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com"
# Same shapes as the reviewed files, with fixture IDs.
COUNTS_SQL = """-- header comment
-- (1) LEGACY PMS database: bookings per hotel.
WITH c(id, label) AS (VALUES ('00000000-0000-4000-8000-000000000001'::uuid, '1 Hotel'))
SELECT coalesce(c.label, 'other') AS hotel, count(DISTINCT b.hotel_id) AS hotels,
       count(*) FILTER (WHERE b.check_out >= current_date) AS future, max(b.created_at)::date AS last_created
FROM bookings b LEFT JOIN c ON c.id = b.hotel_id WHERE b.status <> 'cancelled' GROUP BY 1 ORDER BY 1;

-- (2) LEGACY PMS database: billing.
SELECT coalesce(stripe_billing_status, '(none)') AS billing_status, count(*) AS hotels FROM hotel_payment_settings GROUP BY 1 ORDER BY 1;

-- (3) LEGACY BOOKING database: plan flag.
SELECT billing_active_plan, count(*) AS hotels FROM booking_hotels GROUP BY 1 ORDER BY 1;
"""
TARGET_SQL = """-- Pre-deploy check header.
-- Properties without a claim.
BEGIN READ ONLY;
SELECT property.id, count(*) AS links
FROM hotel_catalog.properties property JOIN hotel_catalog.property_source_links link ON link.property_id = property.id
WHERE NOT EXISTS (SELECT 1 FROM pms.channel_binding_claims claim WHERE claim.property_id = property.id)
GROUP BY property.id;
-- Queued enable jobs.
SELECT job.id FROM platform.jobs job WHERE job.status IN ('pending', 'running');
ROLLBACK;
"""
URLS = {
    "DATABASE_URL": f"postgresql://vayada_pms_user:p%40ss@{HOST}:5432/vayada_pms_db",
    "BOOKING_ENGINE_DATABASE_URL": f"postgresql://vayada_booking_user:pw@{HOST}/vayada_booking_db?sslmode=require",
    "TARGET_DATABASE_URL": f"postgresql://vayada_target_prod_user:pw@{HOST}:5432/vayada_target_prod",
}
SECRET = {"PMS": "DATABASE_URL", "BOOKING": "BOOKING_ENGINE_DATABASE_URL", "TARGET": "TARGET_DATABASE_URL"}


class Record(dict):
    pass


def load(executed, results):
    connected = []

    class Connection:
        def __init__(self, kwargs):
            self.database = kwargs["database"]

        async def execute(self, statement):
            executed.append((self.database, statement))

        async def fetch(self, statement):
            executed.append((self.database, "FETCH " + " ".join(statement.split())))
            return results.pop(0)

        async def close(self):
            executed.append((self.database, "CLOSE"))

    async def connect(**kwargs):
        connected.append(kwargs)
        return Connection(kwargs)

    spec = importlib.util.spec_from_file_location("legacy_readonly_counts", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, {"asyncpg": types.SimpleNamespace(connect=connect)}, connected


def run(module, modules, kind, **overrides):
    output = io.StringIO()
    environment = {"COUNTS_KIND": kind, "VAYADA_DB_RDS_CA_BUNDLE": CA, SECRET[kind]: URLS[SECRET[kind]],
                   ("TARGET_CHECK_SQL" if kind == "TARGET" else "COUNTS_SQL"): TARGET_SQL if kind == "TARGET" else COUNTS_SQL,
                   **overrides}
    with mock.patch.dict(sys.modules, modules), mock.patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(output):
        try:
            module.main()
            return output.getvalue(), None
        except Exception as error:  # noqa: BLE001 - the test inspects the failure
            return output.getvalue(), error


class ReadonlyCountsTest(unittest.TestCase):
    def test_reviewed_shapes_pass_and_everything_else_is_refused(self):
        module, *_ = load([], [])
        self.assertEqual([(n, d) for n, d, _, _ in module.legacy_blocks(COUNTS_SQL)], [("1", "PMS"), ("2", "PMS"), ("3", "BOOKING")])
        header = "-- (1) LEGACY PMS database: x\n"
        for bad in ("SELECT count(*) FROM a; DELETE FROM bookings",
                    "UPDATE bookings SET status = 'x'",
                    "SELECT count(*) FROM bookings FOR UPDATE",
                    "SELECT count(*), ts_stat('select 1') FROM t",
                    "SELECT count(*), query_to_xmlschema('select 1', true, true, '') FROM t",
                    "SELECT count(*), dblink_exec('x', 'y') FROM t",
                    "SELECT count(*) FROM t WHERE 'pg' || '_terminate_backend(1)' = ''",
                    "SELECT count(*) FROM t WHERE x = $$a)b$$",
                    "SELECT count(*) FROM t WHERE x = E'\\''",
                    "SELECT count(*) FROM t /* hidden */",
                    "SELECT count(*) FROM \"users\"",
                    "SELECT pg_catalog.count(*) FROM t",
                    "WITH pg_sleep(x) AS (SELECT 1) SELECT count(*), pg_sleep(1) FROM t",
                    "SELECT count(*) FROM generate_series(1, 3)",
                    "SELECT max(email) FROM users",
                    "SELECT email, count(*) FROM users GROUP BY email",
                    "SELECT count(*) FROM users GROUP BY email",
                    "SELECT label, count(*) FROM t",
                    "SELECT id FROM users",
                    "SELECT max(created_at) FROM t",
                    "SELECT max(email_at)::text FROM users",
                    "SELECT label, count(*) FROM t GROUP BY 1 UNION SELECT email, 1 FROM users",
                    "SELECT count(*) FROM t UNION ALL SELECT count(*) FROM u",
                    "SELECT count(*) OVER (PARTITION BY email) FROM users",
                    "SELECT count(*), (SELECT email FROM users LIMIT 1) FROM t",
                    "SELECT coalesce(label, (SELECT email FROM users LIMIT 1)), count(*) FROM t GROUP BY 1",
                    "SELECT count(*) FROM t, LATERAL (SELECT email FROM users) u",
                    "SELECT count(*) FILTER (WHERE pg_sleep(1) IS NULL) FROM t",
                    "SELECT count(*), ARRAY[email] FROM users",
                    "SELECT count(*), current_user FROM t"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks(header + bad + ";")
        with self.assertRaises(ValueError):
            module.legacy_blocks("SELECT count(*) FROM bookings;")

    def test_hotel_identity_labels_only_from_the_top_level_hotels_table(self):
        module, *_ = load([], [])
        header = "-- (1) LEGACY PMS database: x\n"
        for good in ("SELECT h.id, h.name, h.slug, count(*), max(b.check_out)::date FROM hotels h JOIN bookings b ON b.hotel_id = h.id "
                     "WHERE h.id NOT IN ('00000000-0000-4000-8000-000000000001') GROUP BY h.id, h.name, h.slug HAVING count(*) > 0 ORDER BY 4 DESC",
                     "SELECT hotels.name, count(*) FROM hotels GROUP BY 1"):
            module.legacy_blocks(header + good + ";")
        for bad in ("SELECT u.name, count(*) FROM users u GROUP BY 1",
                    "SELECT h.name, count(*) FROM users h GROUP BY 1",
                    "SELECT h.email, count(*) FROM hotels h GROUP BY 1",
                    "SELECT name, count(*) FROM hotels GROUP BY 1",
                    "SELECT h.name, count(*) FROM hotels h JOIN users u ON u.id = h.owner_id GROUP BY 1, u.email",
                    "SELECT h.name, count(*) FROM users h WHERE EXISTS (SELECT 1 FROM hotels h) GROUP BY 1",
                    "WITH hotels AS (SELECT email AS name FROM users) SELECT hotels.name, count(*) FROM hotels GROUP BY 1",
                    "SELECT h.name, count(*), max(b.check_out) FROM hotels h JOIN bookings b ON b.hotel_id = h.id GROUP BY 1",
                    "SELECT h.name, count(*), max(b.guest_name)::date FROM hotels h JOIN bookings b ON b.hotel_id = h.id GROUP BY 1"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks(header + bad + ";")

    def test_nothing_else_can_pose_as_hotels_or_feed_a_printed_column(self):
        module, *_ = load([], [])
        header = "-- (1) LEGACY PMS database: x\n"
        for good in ("SELECT count(DISTINCT h.id) AS hotels, count(*) FROM hotels h",
                     "WITH c(id, label) AS (VALUES ('00000000-0000-4000-8000-000000000001'::uuid, '1 A'), (NULL, '-2.5')) "
                     "SELECT coalesce(c.label, 'other'), h.name, count(*) FROM hotels AS h LEFT JOIN c ON c.id = h.id GROUP BY 1, h.name"):
            module.legacy_blocks(header + good + ";")
        for bad in (
                # Another relation, subquery or CTE named hotels.
                "SELECT hotels.name, count(*) FROM users hotels GROUP BY 1",
                "SELECT hotels.name, count(*) FROM users AS hotels GROUP BY 1",
                "SELECT hotels.name, count(*) FROM (SELECT email AS name FROM users) AS hotels GROUP BY 1",
                "SELECT hotels.name, count(*) FROM other.hotels GROUP BY 1",
                "SELECT h.name, count(*) FROM other.hotels h GROUP BY 1",
                "WITH RECURSIVE hotels(name) AS (SELECT email FROM users) SELECT hotels.name, count(*) FROM hotels GROUP BY 1",
                "WITH hotels AS MATERIALIZED (SELECT email AS name FROM users) SELECT hotels.name, count(*) FROM hotels GROUP BY 1",
                "WITH hotels(name) AS NOT MATERIALIZED (SELECT email FROM users) SELECT hotels.name, count(*) FROM hotels GROUP BY 1",
                "WITH c AS (VALUES (1)), hotels AS (SELECT email AS name FROM users) SELECT hotels.name, count(*) FROM hotels GROUP BY 1",
                # A hotels alias only counts in the top-level FROM, not in a subquery.
                "SELECT h.name, count(*) FROM bookings b WHERE b.hotel_id IN (SELECT id FROM hotels h) GROUP BY 1",
                # A column alias list could rename any hotels column to name or slug.
                "SELECT h.name, count(*) FROM hotels h(x1, x2, x3, name) GROUP BY 1",
                "SELECT h.name, count(*) FROM hotels AS h (x1, name) GROUP BY 1",
                "SELECT filter.name, count(*) FROM hotels AS filter (x1, name) GROUP BY 1",
                # Printed labels may not come from derived tables, LATERAL or non-literal CTEs.
                "SELECT u.label, count(*) FROM (SELECT email AS label FROM users) u GROUP BY 1",
                "SELECT h.name, u.label, count(*) FROM hotels h, (SELECT email AS label FROM users) u GROUP BY 1, 2",
                "SELECT h.name, u.label, count(*) FROM hotels h JOIN LATERAL (SELECT email AS label FROM users) u ON true GROUP BY 1, 2",
                "SELECT h.name, count(*) FROM (hotels h JOIN bookings b ON b.hotel_id = h.id) GROUP BY 1",
                "WITH c AS (SELECT email AS label FROM users) SELECT c.label, count(*) FROM c GROUP BY 1",
                "WITH c(label) AS (TABLE user_emails) SELECT c.label, count(*) FROM c GROUP BY 1",
                "WITH c(id, label) AS (VALUES (1, (SELECT email FROM users LIMIT 1))) SELECT c.label, count(*) FROM c GROUP BY 1",
                "WITH c(label) AS (VALUES ((TABLE user_emails LIMIT 1))) SELECT c.label, count(*) FROM c GROUP BY 1",
                "WITH c(label) AS (VALUES (current_user)) SELECT c.label, count(*) FROM c GROUP BY 1"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks(header + bad + ";")
            with self.assertRaises(ValueError, msg=bad):  # the shape rules hold even without the function allow-list
                module.printed_shape(bad, "block_1")

    def test_booking_hotels_identity_and_currency_labels(self):
        module, *_ = load([], [])
        header = "-- (1) LEGACY BOOKING database: x\n"
        for good in ("SELECT h.id AS hotel_id, h.name, h.currency, count(*) AS n FROM booking_hotels h "
                     "WHERE h.id IN ('00000000-0000-4000-8000-000000000001') GROUP BY h.id, h.name, h.currency ORDER BY h.currency, h.name",
                     "SELECT booking_hotels.slug, count(*) FROM booking_hotels GROUP BY 1",
                     "SELECT rt.hotel_id, rt.currency AS room_type_currency, count(*) FROM room_types rt GROUP BY rt.hotel_id, rt.currency"):
            module.legacy_blocks(header + good + ";")
        for bad in ("SELECT h.id, h.name, h.currency FROM booking_hotels h",
                    "SELECT h.name, count(*) FROM booking_hotels h",
                    "SELECT h.email, count(*) FROM booking_hotels h GROUP BY 1",
                    "SELECT booking_hotels.name, count(*) FROM users booking_hotels GROUP BY 1",
                    "SELECT booking_hotels.name, count(*) FROM other.booking_hotels GROUP BY 1",
                    "WITH booking_hotels(name) AS (VALUES ('x')) SELECT booking_hotels.name, count(*) FROM booking_hotels GROUP BY 1",
                    "SELECT filter.name, count(*) FROM booking_hotels AS filter (x1, name) GROUP BY 1",
                    "SELECT h.name, count(*) FROM users h WHERE EXISTS (SELECT 1 FROM booking_hotels h) GROUP BY 1",
                    "SELECT u.currency, count(*) FROM (SELECT email AS currency FROM users) u GROUP BY 1",
                    "SELECT rt.hotel_id, rt.name, count(*) FROM room_types rt GROUP BY 1, 2"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks(header + bad + ";")
            with self.assertRaises(ValueError, msg=bad):
                module.printed_shape(bad, "block_1")

    def test_pricing_shapes_and_no_second_value_after_an_aggregate(self):
        module, *_ = load([], [])
        header = "-- (1) LEGACY PMS database: x\n"
        for good in ("SELECT h.id, h.name, count(*), bool_or(h.instant_book), max(ps.payment_provider), max(cp.free_cancellation_days), "
                     "bool_or(coalesce(h.last_minute_discount @? '$ ? (@.enabled == true)', false)) AS lm, "
                     "bool_or(ps.stripe_connect_account_id IS NOT NULL) AS has_account "
                     "FROM hotels h LEFT JOIN hotel_payment_settings ps ON ps.hotel_id = h.id "
                     "LEFT JOIN cancellation_policies cp ON cp.hotel_id = h.id GROUP BY h.id, h.name",
                     "SELECT rt.hotel_id, count(*), min(rt.currency), max(rt.currency), "
                     "count(*) FILTER (WHERE (rt.rate_payment_methods @? '$.*[*] ? (@ == \"card\")')) AS card, "
                     "count(*) FILTER (WHERE (rt.seasons::text ~ '\"rate\": \"?[0-9]+\\.[0-9]{2}[0-9]*[1-9]')) AS sub_cent, "
                     "count(*) FILTER (WHERE (rt.weekend_surcharge ~ '\\.[0-9]{2}(')) AS odd_paren "
                     "FROM room_types rt WHERE rt.is_active GROUP BY rt.hotel_id",
                     "SELECT m.hotel_id, count(*), max(m.markup_pct) FROM channex_channel_markups m GROUP BY m.hotel_id"):
            module.legacy_blocks(header + good + ";")
        for bad in (
                # A second value after an aggregate (the FILTER clause used to swallow it, also through a ')' in a string).
                "SELECT count(*) FILTER (WHERE true) + max(b.total_amount) FILTER (WHERE true) AS n FROM bookings b",
                "SELECT count(') FILTER (WHERE ') + max(b.total_amount) FILTER (WHERE true) AS n FROM bookings b",
                "SELECT count(*) FILTER (WHERE true)::int + 1 FROM t",
                "SELECT bool_or(b.paid) OR true FROM bookings b",
                "SELECT bool_or(b.paid)::text FROM bookings b",
                "SELECT max(m.markup_pct) + max(b.total_amount) FROM channex_channel_markups m, bookings b",
                # min/max only over reviewed labels, reviewed numeric settings, or cast time columns.
                "SELECT max(b.total_amount) FROM bookings b",
                "SELECT min(g.email) FROM guests g",
                "SELECT min(g.created_at) FROM guests g",
                "SELECT max(h.name) FROM hotels h",
                "SELECT bool_or(b.paid) FILTER (WHERE true) FROM bookings b",
                "SELECT count(*), sum(b.total_amount) FROM bookings b",
                # $ and " stay refused outside string literals.
                "SELECT count(*) FROM t WHERE x = $1",
                "SELECT count(*) FROM t WHERE x = $tag$a$tag$",
                "SELECT count(*) FROM \"t\"",
                "SELECT count(*), \"x\" FROM t GROUP BY 2"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks(header + bad + ";")

    def test_refund_tier_numbers_and_cancellation_type(self):
        module, *_ = load([], [])
        header = "-- (1) LEGACY PMS database: x\n"
        module.legacy_blocks(header + (
            "SELECT rt.hotel_id, rt.flexible_cancellation_type, count(*), max(jsonb_array_length(rt.partial_refund_tiers)) AS tiers, "
            "max((rt.partial_refund_tiers -> 0 ->> 'min_days_before_check_in')::int) AS t0_days, "
            "min((rt.partial_refund_tiers -> 3 ->> 'refund_percent')::integer) AS t3_percent, "
            "max(rt.partial_refund_cancel_window_days), max(rt.partial_refund_amount_percent) "
            "FROM room_types rt GROUP BY rt.hotel_id, rt.flexible_cancellation_type;"))
        for bad in ("SELECT max((g.partial_refund_tiers -> 0 ->> 'email')::int) FROM guests g",
                    "SELECT max((rt.partial_refund_tiers -> 0 ->> 'refund_percent')::text) FROM room_types rt",
                    "SELECT max(rt.partial_refund_tiers -> 0 ->> 'refund_percent') FROM room_types rt",
                    "SELECT max((rt.seasons -> 0 ->> 'rate')::int) FROM room_types rt",
                    "SELECT max((rt.partial_refund_tiers -> 0 ->> 'refund_percent' || 'x')::int) FROM room_types rt",
                    "SELECT max((rt.partial_refund_tiers -> 0 ->> 'refund_percent')::int) + max(b.total_amount) FROM room_types rt, bookings b",
                    "SELECT max(jsonb_array_length(g.addresses)) FROM guests g",
                    "SELECT jsonb_array_length(rt.partial_refund_tiers) FROM room_types rt",
                    "SELECT rt.id, count(*) FROM room_types rt GROUP BY rt.id"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks(header + bad + ";")

    def test_plan_without_target_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            counts = Path(directory, "counts.sql")
            counts.write_text("-- (1) LEGACY PMS database: per hotel.\nSELECT h.name, count(*) FROM hotels h GROUP BY 1;\n")
            result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--plan", str(counts), "none"], capture_output=True, text=True,
                                    env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("Block 1 on vayada_pms_db as vayada_pms_user (DATABASE_URL): per hotel."))
        self.assertNotIn("Check ", result.stdout)

    def test_target_checks_drop_the_file_transaction_and_count_only(self):
        module, *_ = load([], [])
        checks = module.target_checks(TARGET_SQL)
        self.assertEqual([(n, t) for n, t, _ in checks], [("1", "Pre-deploy check header. Properties without a claim."), ("2", "Queued enable jobs.")])
        for _, _, statement in checks:
            self.assertTrue(statement.startswith("SELECT count(*) AS rows_found FROM (\nSELECT "))
            self.assertTrue(statement.endswith("\n) AS check_rows"))
        for bad in ("BEGIN READ ONLY;\nDELETE FROM platform.jobs;\nROLLBACK;", "BEGIN;\nROLLBACK;", "SELECT 1",
                    "SELECT 1) AS a UNION ALL SELECT length(email)::bigint FROM (SELECT email FROM users;",
                    "SELECT pg_terminate_backend(1);", "SELECT ts_rewrite('a', 'b');", "SELECT x FROM t WHERE y = $1;",
                    "SELECT id FROM t -- trailing\n;",
                    "SELECT property.id, array_agg(DISTINCT link.source_system || '.' || link.source_table) FROM t GROUP BY 1;",
                    "SELECT id FROM t WHERE a || b = 'x';",
                    "SELECT id, array_agg(x) FROM t GROUP BY 1;"):
            with self.assertRaises(ValueError, msg=bad):
                module.target_checks(bad)

    def test_target_checks_may_use_trunc_jsonb_array_elements_and_using(self):
        module, *_ = load([], [])
        checks = module.target_checks(
            "-- IDR add-ons.\nSELECT 1 FROM booking.addon_definitions WHERE currency = 'IDR' AND price_amount <> trunc(price_amount);\n"
            "-- Fixed charges.\nSELECT 1 FROM booking.fixed_charge_heads h JOIN booking.fixed_charge_revisions r USING (property_id, revision) "
            "WHERE r.policy->>'currency' = 'IDR' AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.policy->'charges') c "
            "WHERE (c->>'amountMinor')::numeric % 100 <> 0);\n")
        self.assertEqual([(n, t) for n, t, _ in checks], [("1", "IDR add-ons."), ("2", "Fixed charges.")])
        for bad in ("SELECT 1 FROM t WHERE x = jsonb_each(y);", "SELECT pg_sleep(1) FROM t;", "SELECT 1 FROM t WHERE x = pg_catalog.trunc(y);"):
            with self.assertRaises(ValueError, msg=bad):
                module.target_checks(bad)
        # The counted-only functions stay refused in printed blocks.
        for bad in ("SELECT count(*) FILTER (WHERE price_amount <> trunc(price_amount)) FROM booking_addons",
                    "SELECT count(*) FROM t, jsonb_array_elements(t.x) e"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks("-- (1) LEGACY PMS database: x\n" + bad + ";")

    def test_plan_with_target_checks_only(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, "target.sql")
            target.write_text("-- IDR revisions.\nSELECT DISTINCT property_id FROM pms.pricing_v2_revisions WHERE currency = 'IDR';\n")
            result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--plan", "none", str(target)], capture_output=True, text=True,
                                    env={"PYTHONDONTWRITEBYTECODE": "1"})
            both = subprocess.run([sys.executable, "-I", str(SCRIPT), "--plan", "none", "none"], capture_output=True, text=True,
                                  env={"PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("Check 1 on vayada_target_prod as vayada_target_prod_user (TARGET_DATABASE_URL): IDR revisions."))
        self.assertNotIn("Block ", result.stdout)
        self.assertNotEqual(both.returncode, 0)

    def test_the_repository_copy_of_the_6c_check_is_counted_and_concatenation_free(self):
        module, *_ = load([], [])
        sql = (SCRIPT.parent / "legacy-predeploy-readonly-check.sql").read_text()
        self.assertNotIn("||", sql)
        self.assertNotIn("array_agg", sql)
        checks = module.target_checks(sql)
        self.assertEqual([number for number, _, _ in checks], ["1", "2"])
        self.assertTrue(checks[0][1].startswith("Properties the new guard would refuse"))
        self.assertTrue(checks[1][1].startswith("Channex enable jobs queued before the guard"))

    def test_each_kind_reads_only_its_pinned_database_over_verified_tls(self):
        for kind, results, database, user, fetches in (
                ("PMS", [[Record(hotel="1 Hotel", hotels=1)], [Record(billing_status="active", hotels=2)]], "vayada_pms_db", "vayada_pms_user", 2),
                ("BOOKING", [[Record(billing_active_plan=None, hotels=9)]], "vayada_booking_db", "vayada_booking_user", 1),
                ("TARGET", [[Record(rows_found=0)], [Record(rows_found=1)]], "vayada_target_prod", "vayada_target_prod_user", 2)):
            executed = []
            module, modules, connected = load(executed, results)
            output, error = run(module, modules, kind)
            self.assertIsNone(error, kind)
            self.assertEqual({(c["host"], c["port"], c["database"], c["user"]) for c in connected}, {(HOST, 5432, database, user)})
            self.assertEqual(len(connected), fetches)
            for kwargs in connected:
                self.assertEqual(kwargs["ssl"].verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(kwargs["ssl"].check_hostname)
            for index in range(fetches):
                session = [statement for _, statement in executed[index * 7:index * 7 + 7]]
                self.assertEqual(session[:4] + session[5:], ["BEGIN TRANSACTION READ ONLY", "SET LOCAL standard_conforming_strings = on",
                                                             "SET LOCAL statement_timeout = '15s'", "SET LOCAL lock_timeout = '1s'",
                                                             "ROLLBACK", "CLOSE"])
            self.assertEqual(output.splitlines()[-1], f"COUNTS_COMPLETE kind={kind} statements={fetches}")
            if kind == "TARGET":
                self.assertTrue(all(s.startswith("FETCH SELECT count(*) AS rows_found FROM ( SELECT") for _, s in executed if s.startswith("FETCH")))
                self.assertEqual(output.count("| rows_found |"), 2)
        self.assertEqual(connected[0]["password"], "pw")

    def test_a_target_check_must_return_one_count(self):
        module, modules, _ = load([], [[Record(rows_found=0), Record(rows_found=1)]])
        output, error = run(module, modules, "TARGET")
        self.assertEqual(str(error), "target_check_not_one_count")
        self.assertNotIn("COUNTS_COMPLETE", output)

    def test_unpinned_database_user_or_ca_is_refused_before_connecting(self):
        for kind, overrides, code in (
                ("PMS", {"DATABASE_URL": "postgresql://vayada_pms_user:p@other-host:5432/vayada_pms_db"}, "pms_database_not_pinned"),
                ("PMS", {"DATABASE_URL": f"postgresql://vayada_admin:p@{HOST}:5432/vayada_pms_db"}, "pms_database_not_pinned"),
                ("TARGET", {"TARGET_DATABASE_URL": f"postgresql://vayada_target_prod_user:p@{HOST}:5433/vayada_target_prod"}, "target_database_not_pinned"),
                ("BOOKING", {"BOOKING_ENGINE_DATABASE_URL": f"postgresql://vayada_booking_user:p@{HOST}:5432/postgres"}, "booking_database_not_pinned"),
                ("PMS", {"VAYADA_DB_RDS_CA_BUNDLE": CA + "\n"}, "rds_ca_mismatch")):
            module, modules, connected = load([], [])
            _, error = run(module, modules, kind, **overrides)
            self.assertEqual(str(error), code)
            self.assertEqual(connected, [])

    def test_row_cap_still_rolls_back(self):
        executed = []
        module, modules, _ = load(executed, [[Record(n=i) for i in range(51)]])
        _, error = run(module, modules, "BOOKING")
        self.assertEqual(str(error), "too_many_rows")
        self.assertEqual([s for _, s in executed][-2:], ["ROLLBACK", "CLOSE"])

    def test_failures_print_only_a_code(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "asyncpg.py").write_text(
                "async def connect(**kwargs):\n    raise RuntimeError('postgresql://user:secret@host/db refused')\n")
            result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, env={
                "PYTHONPATH": directory, "PYTHONDONTWRITEBYTECODE": "1", "COUNTS_KIND": "PMS", "COUNTS_SQL": COUNTS_SQL,
                "VAYADA_DB_RDS_CA_BUNDLE": CA, "DATABASE_URL": URLS["DATABASE_URL"]})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1], "COUNTS_FAILED: RuntimeError")
        self.assertNotIn("secret", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
