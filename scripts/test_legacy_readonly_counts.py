"""Offline tests for scripts/legacy-readonly-counts.py with fake asyncpg and stripe modules."""
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
COUNTS_SQL = """-- header comment
-- (1) LEGACY PMS database: bookings per hotel.
WITH c(id) AS (VALUES ('00000000-0000-4000-8000-000000000001'::uuid))
SELECT count(*) AS bookings FROM bookings b LEFT JOIN c ON c.id = b.hotel_id;

-- (2) LEGACY PMS database: billing.
SELECT coalesce(status, '(none)') AS status, count(*) AS hotels FROM hotel_payment_settings GROUP BY 1;

-- (3) LEGACY BOOKING database: plan flag.
SELECT billing_active_plan, count(*) AS hotels FROM booking_hotels GROUP BY 1 ORDER BY 1;
"""
TARGET_SQL = """-- Pre-deploy check header.
-- Properties without a claim.
BEGIN READ ONLY;
SELECT property.id FROM hotel_catalog.properties property
WHERE NOT EXISTS (SELECT 1 FROM pms.channel_binding_claims claim WHERE claim.property_id = property.id);
-- Queued enable jobs.
SELECT job.id FROM platform.jobs job WHERE job.status IN ('pending', 'running');
ROLLBACK;
"""
URLS = {
    "DATABASE_URL": f"postgresql://pms:p%40ss@{HOST}:5432/vayada_pms_db?sslmode=require",
    "BOOKING_ENGINE_DATABASE_URL": f"postgresql://booking:pw@{HOST}/vayada_booking_db",
    "TARGET_DATABASE_URL": f"postgresql://owner:pw@{HOST}:5432/vayada_target_prod",
}


class Record(dict):
    pass


def load(executed, results, subscriptions):
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

    class Page:
        def auto_paging_iter(self):
            return iter({"status": status, "id": "sub_secret", "metadata": {"vayada_payment_kind": kind} if kind else {}}
                        for status, kind in subscriptions)

    listed = []
    stripe = types.SimpleNamespace(api_key=None, Subscription=types.SimpleNamespace(
        list=lambda **params: listed.append(params) or Page()))
    modules = {"asyncpg": types.SimpleNamespace(connect=connect), "stripe": stripe}
    spec = importlib.util.spec_from_file_location("legacy_readonly_counts", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, modules, connected, listed


def run(module, modules, **overrides):
    output = io.StringIO()
    environment = {"COUNTS_SQL": COUNTS_SQL, "TARGET_CHECK_SQL": TARGET_SQL, "VAYADA_DB_RDS_CA_BUNDLE": CA,
                   "STRIPE_SECRET_KEY": "sk", **URLS, **overrides}
    with mock.patch.dict(sys.modules, modules), mock.patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(output):
        try:
            module.main()
            return output.getvalue(), None
        except Exception as error:  # noqa: BLE001 - the test inspects the failure
            return output.getvalue(), error


class ReadonlyCountsTest(unittest.TestCase):
    def test_only_single_read_only_aggregate_selects_are_accepted(self):
        module, *_ = load([], [], [])
        self.assertEqual([(n, d) for n, d, _, _ in module.legacy_blocks(COUNTS_SQL)], [("1", "PMS"), ("2", "PMS"), ("3", "BOOKING")])
        for bad in ("-- (1) LEGACY PMS database: x\nSELECT count(*) FROM a; DELETE FROM bookings;",
                    "-- (1) LEGACY PMS database: x\nUPDATE bookings SET status = 'x';",
                    "-- (1) LEGACY PMS database: x\nSELECT count(*) FROM bookings FOR UPDATE;",
                    "-- (1) LEGACY PMS database: x\nSELECT count(*), pg_terminate_backend(pid) FROM pg_stat_activity;",
                    "-- (1) LEGACY BOOKING database: x\nSELECT count(*) FROM dblink('x', 'y') AS t(a int);",
                    "-- (1) LEGACY PMS database: x\nSELECT email FROM users;",
                    "SELECT count(*) FROM bookings;"):
            with self.assertRaises(ValueError, msg=bad):
                module.legacy_blocks(bad)

    def test_target_checks_drop_the_file_transaction_and_count_only(self):
        module, *_ = load([], [], [])
        checks = module.target_checks(TARGET_SQL)
        self.assertEqual([(n, t) for n, t, _ in checks], [("1", "Pre-deploy check header. Properties without a claim."), ("2", "Queued enable jobs.")])
        for _, _, statement in checks:
            self.assertTrue(statement.startswith("SELECT count(*) AS rows_found FROM (\nSELECT "))
            self.assertTrue(statement.endswith("\n) AS check_rows"))
        for bad in ("BEGIN READ ONLY;\nDELETE FROM platform.jobs;\nROLLBACK;", "BEGIN;\nROLLBACK;", "SELECT 1"):
            with self.assertRaises(ValueError, msg=bad):
                module.target_checks(bad)

    def test_each_statement_is_read_only_on_its_pinned_database_over_verified_tls(self):
        executed = []
        results = [[Record(bookings=4)], [Record(status="active", hotels=2)], [Record(billing_active_plan=None, hotels=9)],
                   [Record(rows_found=0)], [Record(rows_found=1)]]
        module, modules, connected, listed = load(executed, results, [("active", "fixed_plan"), ("active", None), ("canceled", "fixed_plan"), ("paused", None)])
        output, error = run(module, modules)
        self.assertIsNone(error)
        self.assertEqual([(c["host"], c["port"], c["database"]) for c in connected],
                         [(HOST, 5432, "vayada_pms_db"), (HOST, 5432, "vayada_pms_db"), (HOST, 5432, "vayada_booking_db"),
                          (HOST, 5432, "vayada_target_prod"), (HOST, 5432, "vayada_target_prod")])
        self.assertEqual(connected[0]["password"], "p@ss")
        for kwargs in connected:
            self.assertIsInstance(kwargs["ssl"], ssl.SSLContext)
            self.assertEqual(kwargs["ssl"].verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(kwargs["ssl"].check_hostname)
        for index in range(5):
            session = [statement for _, statement in executed[index * 6:index * 6 + 6]]
            self.assertEqual(session[:3] + session[4:], ["BEGIN TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '60s'",
                                                         "SET LOCAL lock_timeout = '2s'", "ROLLBACK", "CLOSE"])
            self.assertTrue(session[3].startswith("FETCH "))
        target_fetches = [s for d, s in executed if d == "vayada_target_prod" and s.startswith("FETCH")]
        self.assertTrue(all(s.startswith("FETCH SELECT count(*) AS rows_found FROM ( SELECT") for s in target_fetches))
        self.assertEqual(listed, [{"status": "all", "limit": 100}])
        counts, target = output.split("<!-- predeploy-readonly-check -->\n")
        self.assertIn("| active | 2 | 1 |", counts)
        self.assertIn("| canceled | 1 | 1 |", counts)
        self.assertIn("| other | 1 | 0 |", counts)
        self.assertIn("| billing_active_plan | hotels |", counts)
        self.assertEqual(target.count("| rows_found |"), 2)
        self.assertIn("| 1 |", target)
        self.assertNotIn("sub_secret", output)

    def test_unpinned_database_or_ca_is_refused_before_connecting(self):
        for overrides, code in (({"DATABASE_URL": "postgresql://u:p@other-host:5432/vayada_pms_db"}, "pms_database_not_pinned"),
                                ({"TARGET_DATABASE_URL": f"postgresql://u:p@{HOST}:5433/vayada_target_prod"}, "target_database_not_pinned"),
                                ({"BOOKING_ENGINE_DATABASE_URL": f"postgresql://u:p@{HOST}:5432/postgres"}, "booking_database_not_pinned"),
                                ({"VAYADA_DB_RDS_CA_BUNDLE": CA + "\n"}, "rds_ca_mismatch")):
            module, modules, connected, _ = load([], [], [])
            _, error = run(module, modules, **overrides)
            self.assertEqual(str(error), code)
            self.assertEqual(connected, [])

    def test_row_cap_still_rolls_back(self):
        executed = []
        module, modules, *_ = load(executed, [[Record(n=i) for i in range(51)]], [])
        _, error = run(module, modules)
        self.assertEqual(str(error), "too_many_rows")
        self.assertEqual([s for _, s in executed][-2:], ["ROLLBACK", "CLOSE"])

    def test_failures_print_only_a_code(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "asyncpg.py").write_text(
                "async def connect(**kwargs):\n    raise RuntimeError('postgresql://user:secret@host/db refused')\n")
            Path(directory, "stripe.py").write_text("")
            result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, env={
                "PYTHONPATH": directory, "PYTHONDONTWRITEBYTECODE": "1", "COUNTS_SQL": COUNTS_SQL,
                "TARGET_CHECK_SQL": TARGET_SQL, "VAYADA_DB_RDS_CA_BUNDLE": CA, "STRIPE_SECRET_KEY": "x", **URLS})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1], "COUNTS_FAILED: RuntimeError")
        self.assertNotIn("secret", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
