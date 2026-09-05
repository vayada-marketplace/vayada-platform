import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  binding,
  guardedConnection,
  scramVerifier,
  unsafePrivilegesSql,
  verifyPgSettings,
} from "./migration-rehearsal-reader-contract.mjs";

const password = "A".repeat(43); // Synthetic vector, never a deployed credential.
const readerUrl = `postgresql://${binding.reader}:${password}@${binding.host}/${binding.database}?sslmode=require`;
const adminUrl = `postgresql://isolated_admin:${password}@${binding.host}/postgres?sslmode=require`;
assert.equal(
  guardedConnection(readerUrl, "reader").pathname,
  "/" + binding.database,
);
assert.equal(
  guardedConnection(adminUrl, "admin").pathname,
  "/" + binding.database,
);
assert.equal(
  guardedConnection(readerUrl, "reader").searchParams.get("uselibpqcompat"),
  "true",
);
const invalid = [
  [readerUrl.replace(binding.host, "production.example.test"), "reader"],
  [readerUrl.replace(binding.database, "auth"), "reader"],
  [readerUrl.replace(binding.reader, binding.owner), "reader"],
  [readerUrl.replace(password, "short"), "reader"],
  [readerUrl.replace("sslmode=require", "sslmode=disable"), "reader"],
  [readerUrl.replace("?sslmode=require", ""), "reader"],
  [readerUrl + "&sslmode=disable", "reader"],
  [readerUrl + "&options=-c%20default_transaction_read_only=off", "reader"],
  [readerUrl + "&host=production.example.test", "reader"],
  [readerUrl + "&uselibpqcompat=true&uselibpqcompat=false", "reader"],
  [readerUrl + "#fragment", "reader"],
  [readerUrl.replace(binding.host, binding.host + ":5433"), "reader"],
  [readerUrl.replace("postgresql:", "https:"), "reader"],
  [readerUrl, "admin"],
  [adminUrl.replace("/postgres?", "/auth?"), "admin"],
  [adminUrl, "unknown"],
];
for (const [url, mode] of invalid)
  assert.throws(() => guardedConnection(url, mode));
// Independently calculated with Python stdlib PBKDF2/HMAC/SHA256.
assert.equal(
  scramVerifier(password, Buffer.from(Array.from({ length: 16 }, (_, i) => i))),
  "SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$/UZSvpaUZ5zPd66PhhDihV6MDrOTYSZnN99+mAO2rMA=:781RluSbuQtAsxQx4/YINy79R2ip6NHdzEWMOEBI7i4=",
);
assert.notEqual(scramVerifier(password), scramVerifier(password));
assert(!scramVerifier(password).includes(password));
for (const privilege of [
  "TRUNCATE",
  "TRIGGER",
  "MAINTAIN",
  "has_any_column_privilege",
  "has_sequence_privilege",
  "has_function_privilege",
  "pg_auth_members",
])
  assert(unsafePrivilegesSql.includes(privilege));
const settings = JSON.parse(
  readFileSync(
    new URL("./fixtures/migration-rehearsal-pg-settings.json", import.meta.url),
    "utf8",
  ),
);
verifyPgSettings([settings]);
for (const changed of [
  [],
  [settings, settings],
  [{ ...settings, triggers: 1 }],
  [{ ...settings, owner: binding.reader }],
  [{ ...settings, relkind: "r" }],
  [{ ...settings, definition: "SELECT 1" }],
  [{ ...settings, rules: [] }],
  [{ ...settings, rules: [...settings.rules, settings.rules[1]] }],
  [
    {
      ...settings,
      rules: settings.rules.map((r) => ({ ...r, definition: "unexpected" })),
    },
  ],
]) {
  assert.throws(() => verifyPgSettings(changed), /PG_SETTINGS_CONTRACT/);
}
assert(
  unsafePrivilegesSql.includes("c.oid <> 'pg_catalog.pg_settings'::regclass"),
);
assert(unsafePrivilegesSql.includes("CASE WHEN c.relkind='S'"));
assert(
  unsafePrivilegesSql.includes(
    "INSERT,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN",
  ),
);
console.log(
  "PASS: URL/TLS denial matrix, SCRAM vector and native settings tamper matrix",
);
