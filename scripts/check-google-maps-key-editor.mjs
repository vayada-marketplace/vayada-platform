#!/usr/bin/env node
// Read-only check of next-api's Google Maps key editor (VAY-2589).
//
//   node scripts/check-google-maps-key-editor.mjs
//
// Reads /vayada/prod/next-api-google-maps-key-name and /vayada/prod/next-api-google-maps-key-editor
// from SSM (profile $AWS_PROFILE, default vayada) and never prints the service account key. It only
// reads from Google: the key's website list, and two reads the service account must be refused
// (listing keys, reading a key string). Exit code 0 when the key reads as a website-restricted key
// and both refusals hold.
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const profile = process.env.AWS_PROFILE || "vayada";
const ssm = (name) =>
  execFileSync(
    "aws",
    [
      "ssm",
      "get-parameter",
      "--profile",
      profile,
      "--region",
      "eu-west-1",
      "--name",
      name,
      "--with-decryption",
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();

const keyName = ssm("/vayada/prod/next-api-google-maps-key-name");
let account;
try {
  account = JSON.parse(ssm("/vayada/prod/next-api-google-maps-key-editor"));
} catch {
  console.error("The service account key in SSM is not valid JSON.");
  process.exit(1);
}
if (account.type !== "service_account" || !account.client_email || !account.private_key) {
  console.error("The value in SSM is not a service account key.");
  process.exit(1);
}
console.log("key name:", keyName);
console.log("service account:", account.client_email);

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
  iss: account.client_email,
  scope: "https://www.googleapis.com/auth/cloud-platform",
  aud: "https://oauth2.googleapis.com/token",
  iat: now,
  exp: now + 600,
})}`;
const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${signature}`,
  }).toString(),
});
const tokenBody = await tokenResponse.json().catch(() => ({}));
if (!tokenResponse.ok || typeof tokenBody.access_token !== "string") {
  console.error("token: HTTP", tokenResponse.status, tokenBody.error ?? "");
  process.exit(1);
}
const get = async (path) => {
  const response = await fetch(`https://apikeys.googleapis.com/v2/${path}`, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let ok = true;
const key = await get(keyName);
if (key.status !== 200) {
  console.error("read the key: HTTP", key.status, key.body.error?.status ?? "");
  process.exit(1);
}
const referrers = key.body.restrictions?.browserKeyRestrictions?.allowedReferrers;
console.log("read the key: HTTP 200 ->", key.body.name, `"${key.body.displayName ?? ""}"`);
if (!Array.isArray(referrers) || referrers.length === 0) {
  console.log("website list: none -> NOT a website-restricted key; next-api will leave it alone");
  ok = false;
} else {
  console.log(`website list (${referrers.length}):`);
  for (const referrer of referrers) console.log("  ", referrer);
  const routes = JSON.parse(
    readFileSync(new URL("../infra/booking_custom_domains.auto.tfvars.json", import.meta.url)),
  ).next_booking_custom_domains;
  for (const host of Object.keys(routes)) {
    const listed = referrers.includes(`https://${host}/*`) || referrers.includes(`${host}/*`);
    console.log(`routed hotel domain ${host}: ${listed ? "listed" : "missing (next-api adds it)"}`);
  }
}
console.log("API restrictions:", JSON.stringify(key.body.restrictions?.apiTargets ?? "none"));

// The service account's role holds only apikeys.keys.get and apikeys.keys.update.
const project = keyName.split("/")[1];
for (const [probe, path] of [
  ["list the project's keys", `projects/${project}/locations/global/keys`],
  ["read the key string", `${keyName}/keyString`],
]) {
  const { status } = await get(path);
  const refused = status === 403;
  ok &&= refused;
  console.log(`${probe}: HTTP ${status} -> ${refused ? "refused, as expected" : "NOT refused"}`);
}
console.log("RESULT:", ok ? "ready" : "NOT ready");
process.exit(ok ? 0 : 1);
