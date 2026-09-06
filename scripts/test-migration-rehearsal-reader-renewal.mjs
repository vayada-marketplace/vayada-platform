import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertRenewalWindow, previousExpiry, renewedExpiry } from "./migration-rehearsal-reader-renewal.mjs";
const now = Date.parse("2026-09-06T02:25:00Z");
const role = { rolcanlogin: true, rolconnlimit: 16, rolvaliduntil: previousExpiry,
  rolconfig: ["statement_timeout=15s", "default_transaction_read_only=on", "idle_in_transaction_session_timeout=30s"] };
assertRenewalWindow(role, now);
assertRenewalWindow(role, Date.parse(renewedExpiry) - 8 * 3600000);
assert.throws(() => assertRenewalWindow(role, Date.parse(renewedExpiry) - 8 * 3600000 - 1));
for (const changed of [undefined, {...role,rolcanlogin:false}, {...role,rolconnlimit:-1},
  {...role,rolvaliduntil:renewedExpiry}, {...role,rolconfig:["default_transaction_read_only=off"]}])
  assert.throws(() => assertRenewalWindow(changed, now));
for (const time of [Date.parse(previousExpiry)-1, Date.parse(renewedExpiry)-60000, Date.parse(renewedExpiry)+1])
  assert.throws(() => assertRenewalWindow(role, time));
const source = readFileSync(new URL("./migration-rehearsal-reader-renewal.mjs", import.meta.url), "utf8");
assert.equal((source.match(/ALTER ROLE/g) ?? []).length, 1);
assert(!/CREATE ROLE|GRANT |PASSWORD |ALTER DATABASE/.test(source));
assert(source.indexOf("assertRenewalWindow(role)") < source.indexOf("ALTER ROLE"));
assert(source.indexOf("captureRows(admin)") < source.indexOf("ALTER ROLE"));
console.log("PASS: exact expired-role/default/window matrix and expiry-only SQL guard");
