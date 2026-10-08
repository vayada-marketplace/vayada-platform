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
                session = [statement for _, statement in executed[index * 6:index * 6 + 6]]
                self.assertEqual(session[:3] + session[4:], ["BEGIN TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '15s'",
                                                             "SET LOCAL lock_timeout = '1s'", "ROLLBACK", "CLOSE"])
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
