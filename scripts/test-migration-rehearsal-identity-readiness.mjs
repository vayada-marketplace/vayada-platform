import assert from "node:assert/strict";
import { readinessAccounts, readinessSql, summarizeReadiness } from "./migration-rehearsal-identity-readiness.mjs";

const absent = readinessAccounts.map(label => ({ label, users: 0, provider_bindings: 0, active_memberships: 0 }));
assert.deepEqual(summarizeReadiness(absent).absentAccounts, readinessAccounts);
const present = absent.map(row => ({ ...row, users: 1, provider_bindings: 1, active_memberships: 1 }));
const result = summarizeReadiness(present);
assert.deepEqual(result.absentAccounts, []);
assert.equal(result.providerIdentityVerified, false);
assert.equal(result.authenticatedReadsProven, false);
assert.equal(result.mappingChanged, false);
assert.deepEqual(summarizeReadiness([{ ...present[0], users: 2 }, ...present.slice(1)]).ambiguousAccounts, ["creator"]);
for (const invalid of [[], [...absent, absent[0]], absent.map(() => absent[0]),
  [{ ...absent[0], users: -1 }, ...absent.slice(1)], [{ ...absent[0], provider_bindings: "0" }, ...absent.slice(1)]])
  assert.throws(() => summarizeReadiness(invalid), /IDENTITY_AUDIT_SHAPE/);
assert(readinessSql.includes("unnest($1::text[])"));
assert(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT)\b/.test(readinessSql));
console.log("PASS: four-account presence, absence, ambiguity, invalid counts and no inferred identity/grant/smoke acceptance");
