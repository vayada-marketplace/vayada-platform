"""Offline tests for scripts/legacy-readonly-counts.py with fake asyncpg and stripe modules."""
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parent / "legacy-readonly-counts.py"
SQL = """-- header comment
-- (1) LEGACY PMS database: bookings per hotel.
WITH c(id) AS (VALUES ('00000000-0000-4000-8000-000000000001'::uuid))
SELECT count(*) AS bookings FROM bookings b LEFT JOIN c ON c.id = b.hotel_id;

-- (2) LEGACY PMS database: billing.
SELECT coalesce(status, '(none)') AS status, count(*) AS hotels FROM hotel_payment_settings GROUP BY 1;

-- (3) LEGACY BOOKING database: plan flag.
SELECT billing_active_plan, count(*) AS hotels FROM booking_hotels GROUP BY 1 ORDER BY 1;
"""


class Record(dict):
    pass


def load(executed, results, statuses):
    connections = []

    class Connection:
        def __init__(self, url):
            self.url = url
            connections.append(url)

        async def execute(self, statement):
            executed.append((self.url, statement))

        async def fetch(self, statement):
            executed.append((self.url, "FETCH"))
            return results.pop(0)

        async def close(self):
            executed.append((self.url, "CLOSE"))

    async def connect(url):
        return Connection(url)

    class Page:
        def __init__(self, **params):
            self.params = params

        def auto_paging_iter(self):
            return iter({"status": status, "id": "sub_secret", "metadata": {"vayada_payment_kind": kind} if kind else {}}
                        for status, kind in statuses)

    listed = []
    stripe = types.SimpleNamespace(api_key=None, Subscription=types.SimpleNamespace(
        list=lambda **params: listed.append(params) or Page(**params)))
    modules = {"asyncpg": types.SimpleNamespace(connect=connect), "stripe": stripe}
    spec = importlib.util.spec_from_file_location("legacy_readonly_counts", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, modules, listed, stripe


def run(module, modules):
    output = io.StringIO()
    environment = {"COUNTS_SQL": SQL, "DATABASE_URL": "pms-url", "BOOKING_ENGINE_DATABASE_URL": "booking-url", "STRIPE_SECRET_KEY": "sk"}
    with mock.patch.dict(sys.modules, modules), mock.patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(output):
        try:
            module.main()
            return output.getvalue(), None
        except Exception as error:  # noqa: BLE001 - the test inspects the failure
            return output.getvalue(), error


class ReadonlyCountsTest(unittest.TestCase):
    def test_blocks_are_single_selects_bound_to_their_database(self):
        module, *_ = load([], [], [])
        self.assertEqual([(n, d) for n, d, _, _ in module.blocks(SQL)], [("1", "PMS"), ("2", "PMS"), ("3", "BOOKING")])
        for bad in ("-- (1) LEGACY PMS database: x\nSELECT 1; DELETE FROM bookings;",
                    "-- (1) LEGACY PMS database: x\nUPDATE bookings SET status = 'x';",
                    "-- (1) LEGACY PMS database: x\nSELECT pg_terminate_backend(pid) FROM pg_stat_activity;",
                    "-- (1) LEGACY BOOKING database: x\nSELECT * FROM dblink('x', 'y') AS t(a int);",
                    "SELECT 1;"):
            with self.assertRaises(ValueError):
                module.blocks(bad)

    def test_each_block_runs_read_only_and_rolls_back(self):
        executed = []
        results = [[Record(bookings=4)], [Record(status="active", hotels=2)], [Record(billing_active_plan=None, hotels=9)]]
        module, modules, listed, stripe = load(executed, results, [("active", "fixed_plan"), ("active", None), ("canceled", "fixed_plan"), ("paused", None)])
        output, error = run(module, modules)
        self.assertIsNone(error)
        for url in ("pms-url", "booking-url"):
            statements = [s for u, s in executed if u == url]
            self.assertEqual(statements[:5], ["BEGIN TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '60s'",
                                              "SET LOCAL lock_timeout = '2s'", "FETCH", "ROLLBACK"])
        self.assertEqual([u for u, s in executed if s == "FETCH"], ["pms-url", "pms-url", "booking-url"])
        self.assertEqual(listed, [{"status": "all", "limit": 100}])
        self.assertEqual(stripe.api_key, "sk")
        self.assertIn("| active | 2 | 1 |", output)
        self.assertIn("| canceled | 1 | 1 |", output)
        self.assertIn("| past_due | 0 | 0 |", output)
        self.assertIn("| other | 1 | 0 |", output)
        self.assertIn("| billing_active_plan | hotels |", output)
        self.assertNotIn("sub_secret", output)

    def test_row_cap_still_rolls_back(self):
        executed = []
        module, modules, *_ = load(executed, [[Record(n=i) for i in range(51)]], [])
        _, error = run(module, modules)
        self.assertEqual(str(error), "too_many_rows")
        self.assertEqual([s for _, s in executed][-2:], ["ROLLBACK", "CLOSE"])

    def test_failures_print_only_a_code(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "asyncpg.py").write_text(
                "async def connect(url):\n    raise RuntimeError('postgresql://user:secret@host/db refused')\n")
            Path(directory, "stripe.py").write_text("")
            result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, env={
                "PYTHONPATH": directory, "PYTHONDONTWRITEBYTECODE": "1", "COUNTS_SQL": SQL,
                "DATABASE_URL": "x", "BOOKING_ENGINE_DATABASE_URL": "x", "STRIPE_SECRET_KEY": "x"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1], "COUNTS_FAILED: RuntimeError")
        self.assertNotIn("secret", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
