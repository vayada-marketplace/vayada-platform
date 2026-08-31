import pg from "pg";

const connectionString = process.env.TARGET_DATABASE_URL;
if (!connectionString) throw new Error("TARGET_DATABASE_URL is required");
const connectionUrl = new URL(connectionString);
if (connectionUrl.searchParams.get("sslmode") === "require" && !connectionUrl.searchParams.has("uselibpqcompat")) {
  connectionUrl.searchParams.set("uselibpqcompat", "true");
}

const client = new pg.Client({
  application_name: "finance-folio-recipient-inventory",
  connectionString: connectionUrl.toString(),
  connectionTimeoutMillis: 5_000,
  options: "-c default_transaction_read_only=on -c statement_timeout=10000",
});

let stage = "connect";
try {
  await client.connect();
  stage = "begin";
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  stage = "verify_read_only";
  const mode = await client.query("SHOW transaction_read_only");
  if (mode.rows[0]?.transaction_read_only !== "on") throw new Error("inventory is not read-only");

  stage = "totals";
  const totals = await client.query(`
    SELECT count(*)::text AS revision_count,
      count(DISTINCT folio_id)::text AS folio_count,
      count(DISTINCT property_id)::text AS property_count
    FROM finance.folio_revisions`);
  stage = "key_versions";
  const keyVersions = await client.query(`
    SELECT recipient_encryption_scheme,
      recipient_key_version,
      recipient_fingerprint_key_version,
      count(*)::text AS revision_count
    FROM finance.folio_revisions
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`);

  console.log(JSON.stringify({
    status: "PASS", transactionReadOnly: true, totals: totals.rows[0], keyVersions: keyVersions.rows,
  }));
} catch (error) {
  const sqlState = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  console.error(JSON.stringify({ status: "FAIL", code: "folio_recipient_inventory_failed", stage, sqlState }));
  process.exitCode = 1;
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end().catch(() => undefined);
}
