import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const account = "269416271598";
const role = `arn:aws:iam::${account}:role/vayada-migration-rehearsal-application-task-role`;
const bucket = `arn:aws:s3:::vayada-migration-rehearsal-media-${account}`;
const keyPattern =
  /^arn:aws:kms:eu-west-1:269416271598:key\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function canonical(value) {
  if (Array.isArray(value))
    return value
      .map(canonical)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

// Read-only control-plane verification, not a substitute for live crypto/API smoke.
export function checkApplication(aws, recipient, fingerprint) {
  assert.match(recipient ?? "", keyPattern);
  assert.match(fingerprint ?? "", keyPattern);
  assert.notEqual(recipient, fingerprint);
  assert.equal(aws(["sts", "get-caller-identity"]).Account, account);
  const trust = aws(["iam", "get-role", "--role-name", role.split("/").at(-1)])
    .Role.AssumeRolePolicyDocument;
  assert.deepEqual(
    canonical(trust),
    canonical({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: { "aws:SourceAccount": account },
            ArnLike: { "aws:SourceArn": `arn:aws:ecs:eu-west-1:${account}:*` },
          },
        },
      ],
    }),
  );
  for (const [arn, spec, usage] of [
    [recipient, "SYMMETRIC_DEFAULT", "ENCRYPT_DECRYPT"],
    [fingerprint, "HMAC_256", "GENERATE_VERIFY_MAC"],
  ]) {
    const key = aws(["kms", "describe-key", "--key-id", arn]).KeyMetadata;
    assert.equal(key.Arn, arn);
    assert.equal(key.KeyState, "Enabled");
    assert.equal(key.KeySpec, spec);
    assert.equal(key.KeyUsage, usage);
    const policy = JSON.parse(
      aws([
        "kms",
        "get-key-policy",
        "--key-id",
        arn,
        "--policy-name",
        "default",
      ]).Policy,
    );
    assert.deepEqual(
      canonical(policy),
      canonical({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "EnableAccountAdministration",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${account}:root` },
            Action: "kms:*",
            Resource: "*",
          },
          {
            Sid: "DenyCryptographicUseOutsideRehearsalApplication",
            Effect: "Deny",
            Principal: "*",
            Resource: "*",
            Action: [
              "kms:Encrypt",
              "kms:Decrypt",
              "kms:GenerateDataKey*",
              "kms:ReEncrypt*",
              "kms:GenerateMac",
              "kms:VerifyMac",
            ],
            Condition: { ArnNotEquals: { "aws:PrincipalArn": role } },
          },
          {
            Sid: "DenyGrantCreation",
            Effect: "Deny",
            Principal: "*",
            Resource: "*",
            Action: "kms:CreateGrant",
          },
        ],
      }),
    );
  }
  const context = [
    ["kms:EncryptionAlgorithm", "SYMMETRIC_DEFAULT"],
    ["kms:EncryptionContext:purpose", "finance-folio-recipient-v1"],
    [
      "kms:EncryptionContext:propertyId",
      "00000000-0000-4000-8000-000000000001",
    ],
    ["kms:EncryptionContext:folioId", "00000000-0000-4000-8000-000000000002"],
    ["kms:EncryptionContext:revision", "1"],
    ["kms:MacAlgorithm", "HMAC_SHA_256"],
  ].map(([ContextKeyName, value]) => ({
    ContextKeyName,
    ContextKeyType: "string",
    ContextKeyValues: [value],
  }));
  context.push({
    ContextKeyName: "kms:EncryptionContextKeys",
    ContextKeyType: "stringList",
    ContextKeyValues: ["purpose", "propertyId", "folioId", "revision"],
  });
  function decision(resource, expected, actions, values = context) {
    const result = aws([
      "iam",
      "simulate-principal-policy",
      "--policy-source-arn",
      role,
      "--action-names",
      ...actions,
      "--resource-arns",
      resource,
      "--context-entries",
      JSON.stringify(values),
    ]).EvaluationResults;
    assert.equal(result.length, actions.length);
    assert.deepEqual(
      result.map((r) => r.EvalActionName).sort(),
      [...actions].sort(),
    );
    for (const r of result) {
      assert.equal(r.EvalResourceName, resource);
      assert.equal(r.EvalDecision, expected);
      assert.deepEqual(r.MissingContextValues, []);
    }
  }
  for (const prefix of ["public", "private"]) {
    decision(`${bucket}/${prefix}/media/check`, "allowed", ["s3:GetObject"]);
    decision(`${bucket}/${prefix}/media/check`, "explicitDeny", [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]);
  }
  decision(`${bucket}/rehearsal-control/owner.json`, "explicitDeny", [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
  ]);
  decision(
    "arn:aws:s3:::vayada-media-production/private/media/check",
    "explicitDeny",
    ["s3:GetObject", "s3:PutObject"],
  );
  decision("*", "explicitDeny", [
    "secretsmanager:GetSecretValue",
    "ssm:GetParameter",
    "iam:PassRole",
    "rds:DeleteDBInstance",
    "kms:CreateGrant",
  ]);
  decision(recipient, "allowed", [
    "kms:Encrypt",
    "kms:Decrypt",
    "kms:DescribeKey",
  ]);
  decision(fingerprint, "allowed", ["kms:GenerateMac", "kms:DescribeKey"]);
  decision(
    recipient,
    "implicitDeny",
    ["kms:Encrypt"],
    context.map((c) =>
      c.ContextKeyName.endsWith(":purpose")
        ? { ...c, ContextKeyValues: ["wrong-purpose"] }
        : c,
    ),
  );
  decision(
    fingerprint,
    "implicitDeny",
    ["kms:GenerateMac"],
    context.map((c) =>
      c.ContextKeyName === "kms:MacAlgorithm"
        ? { ...c, ContextKeyValues: ["HMAC_SHA_512"] }
        : c,
    ),
  );
  decision(
    "arn:aws:kms:eu-west-1:269416271598:key/ffffffff-ffff-4fff-8fff-ffffffffffff",
    "explicitDeny",
    ["kms:Decrypt", "kms:GenerateMac"],
  );
  return {
    passed: true,
    scope: "read-only IAM/key controls; application smoke still required",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const aws = (args) =>
      JSON.parse(
        execFileSync(
          "aws",
          [
            ...args,
            "--region",
            "eu-west-1",
            "--output",
            "json",
            "--no-cli-pager",
          ],
          {
            encoding: "utf8",
            timeout: 30_000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
    console.log(
      JSON.stringify(checkApplication(aws, ...process.argv.slice(2))),
    );
  } catch {
    console.error(
      "Isolated application IAM/key control check failed; no mutations performed.",
    );
    process.exitCode = 1;
  }
}
