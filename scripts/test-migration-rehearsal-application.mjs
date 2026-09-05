import assert from "node:assert/strict";
import { checkApplication } from "./check-migration-rehearsal-application.mjs";

const recipient =
  "arn:aws:kms:eu-west-1:269416271598:key/00000000-0000-4000-8000-000000000001";
const fingerprint = recipient.slice(0, -1) + "2";
function fixture(fault) {
  return (args) => {
    const value = (name) => args[args.indexOf(name) + 1];
    if (args[0] === "sts")
      return { Account: fault === "account" ? "wrong" : "269416271598" };
    if (args[1] === "get-role")
      return {
        Role: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  Service:
                    fault === "trust-principal"
                      ? ["ecs-tasks.amazonaws.com", "ec2.amazonaws.com"]
                      : "ecs-tasks.amazonaws.com",
                },
                Action: "sts:AssumeRole",
                Condition: {
                  StringEquals:
                    fault === "trust-account"
                      ? {}
                      : { "aws:SourceAccount": "269416271598" },
                  ArnLike: {
                    "aws:SourceArn": "arn:aws:ecs:eu-west-1:269416271598:*",
                  },
                },
              },
            ],
          },
        },
      };
    if (args[1] === "describe-key")
      return {
        KeyMetadata: {
          Arn: value("--key-id"),
          KeyState: fault === "disabled" ? "Disabled" : "Enabled",
          KeySpec:
            value("--key-id") === recipient ? "SYMMETRIC_DEFAULT" : "HMAC_256",
          KeyUsage:
            value("--key-id") === recipient
              ? "ENCRYPT_DECRYPT"
              : "GENERATE_VERIFY_MAC",
        },
      };
    if (args[1] === "get-key-policy")
      return {
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            ...(fault === "missing-root"
              ? []
              : [
                  {
                    Sid: "EnableAccountAdministration",
                    Effect: "Allow",
                    Principal: { AWS: "arn:aws:iam::269416271598:root" },
                    Action: "kms:*",
                    Resource: "*",
                  },
                ]),
            ...(fault === "extra-allow"
              ? [
                  {
                    Sid: "BypassContext",
                    Effect: "Allow",
                    Principal: {
                      AWS: "arn:aws:iam::269416271598:role/vayada-migration-rehearsal-application-task-role",
                    },
                    Action: "kms:*",
                    Resource: "*",
                  },
                ]
              : []),
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
              Condition: {
                ArnNotEquals: {
                  "aws:PrincipalArn":
                    fault === "role"
                      ? "wrong"
                      : "arn:aws:iam::269416271598:role/vayada-migration-rehearsal-application-task-role",
                },
              },
            },
            {
              Sid: "DenyGrantCreation",
              Effect: "Deny",
              Principal: "*",
              Resource: "*",
              Action: fault === "grant" ? "kms:Other" : "kms:CreateGrant",
            },
          ],
        }),
      };
    assert.equal(args[1], "simulate-principal-policy");
    const resource = value("--resource-arns");
    const context = value("--context-entries");
    const actions = args.slice(
      args.indexOf("--action-names") + 1,
      args.indexOf("--resource-arns"),
    );
    return {
      EvaluationResults:
        fault === "missing"
          ? []
          : actions.map((action) => {
              let result = "explicitDeny";
              if (
                resource.includes("rehearsal-media-") &&
                /\/(public|private)\/media\//.test(resource) &&
                action === "s3:GetObject"
              )
                result = "allowed";
              if ([recipient, fingerprint].includes(resource))
                result =
                  context.includes("wrong-purpose") ||
                  context.includes("HMAC_SHA_512")
                    ? "implicitDeny"
                    : "allowed";
              return {
                EvalActionName: fault === "action" ? "wrong" : action,
                EvalResourceName: fault === "resource" ? "wrong" : resource,
                EvalDecision:
                  fault === "write" && action === "s3:PutObject"
                    ? "allowed"
                    : result,
                MissingContextValues: fault === "context" ? ["missing"] : [],
              };
            }),
    };
  };
}
assert.equal(checkApplication(fixture(), recipient, fingerprint).passed, true);
for (const fault of [
  "account",
  "disabled",
  "role",
  "grant",
  "missing",
  "action",
  "resource",
  "write",
  "context",
  "trust-principal",
  "trust-account",
  "missing-root",
  "extra-allow",
])
  assert.throws(
    () => checkApplication(fixture(fault), recipient, fingerprint),
    fault,
  );
assert.throws(() => checkApplication(fixture(), recipient, recipient));
assert.throws(() =>
  checkApplication(
    fixture(),
    recipient.replace("269416271598", "000000000000"),
    fingerprint,
  ),
);
console.log(
  "Isolated application checks: valid fixture and 15 unsafe/missing-evidence cases passed.",
);
