import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const variables = readFileSync(new URL("../infra/variables.tf", import.meta.url), "utf8");
const match = variables.match(
  /can\(regex\("([^"]+)", secret\)\)/,
);
assert.ok(match, "unsubscribe signing-key validation regex must exist");
const terraformPattern = new RegExp(match[1]);

const canonicalKey = (bytes) => Buffer.alloc(bytes).toString("base64url");
const cases = [
  canonicalKey(32),
  canonicalKey(33),
  canonicalKey(34),
  canonicalKey(64),
  canonicalKey(31),
  `${canonicalKey(32).slice(0, -1)}B`,
  `${canonicalKey(34).slice(0, -1)}B`,
  `${canonicalKey(32)}=`,
  "A".repeat(45),
  `${"A".repeat(42)}+`,
];

for (const value of cases) {
  const decoded = Buffer.from(value, "base64url");
  const appAccepts =
    /^[A-Za-z0-9_-]+$/.test(value) &&
    decoded.toString("base64url") === value &&
    decoded.length >= 32;
  assert.equal(
    terraformPattern.test(value),
    appAccepts,
    `Terraform and application validation disagree for length ${value.length}`,
  );
}

console.log("Marketplace communication unsubscribe signing-key validation passed.");
