import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  attestPositivePublicMediaRuntime,
  ensurePositivePublicMediaObject,
  positivePublicMediaObject as expected,
  validatePositivePublicMediaEnvironment,
} from "./migration-rehearsal-positive-public-media-object.mjs";

const env = {
  APPLICATION_RELEASE: expected.release,
  PLATFORM_MEDIA_BUCKET: expected.bucket,
  PLATFORM_MEDIA_CDN_BASE_URL: expected.cdn,
  ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/synthetic",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/synthetic",
};
validatePositivePublicMediaEnvironment(env);
for (const [name, value] of [
  ["APPLICATION_RELEASE", "wrong"],
  ["PLATFORM_MEDIA_BUCKET", "production"],
  ["PLATFORM_MEDIA_CDN_BASE_URL", "https://evil.test"],
  ["ECS_CONTAINER_METADATA_URI_V4", "https://169.254.170.2/v4/bad"],
  ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "https://evil.test/credentials"],
  ["AWS_ACCESS_KEY_ID", "static-credential"],
  ["AWS_PROFILE", "broader-profile"],
  ["AWS_ENDPOINT_URL", "https://evil.test"],
  ["AWS_ENDPOINT_URL_S3", "https://evil.test"],
]) {
  assert.throws(() =>
    validatePositivePublicMediaEnvironment({ ...env, [name]: value }),
  );
}

class HeadObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
class GetObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
class PutObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
const commands = { HeadObjectCommand, GetObjectCommand, PutObjectCommand };
const metadata = {
  TaskARN:
    "arn:aws:ecs:eu-west-1:269416271598:task/vayada-backend-cluster/0123456789abcdef0123456789abcdef",
  Containers: [
    { Name: "positive-public-media-object", ImageID: expected.imageDigest },
  ],
};
const taskCredentials = {
  RoleArn: "arn:aws:iam::269416271598:role/vayada-rehearsal-7200a43a-media",
  AccessKeyId: "synthetic-access-key",
  SecretAccessKey: "synthetic-secret-key",
  Token: "synthetic-session-token",
};
const response = (
  status,
  bytes = expected.body,
  contentType = "image/png",
) => ({
  status,
  headers: new Headers({ "content-type": contentType }),
  arrayBuffer: async () => bytes,
  body: { cancel: async () => {} },
});
const http = async (url) =>
  url.endsWith("/task")
    ? { status: 200, json: async () => metadata }
    : url.includes("/v2/credentials/")
      ? { status: 200, json: async () => taskCredentials }
      : response(url === expected.url ? 200 : 403);

const makeS3 = (options = {}) => {
  const {
    present = false,
    drift = false,
    putVersion = "version-1",
    headVersion = "version-1",
  } = options;
  let exists = present;
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (command instanceof PutObjectCommand) {
        assert.equal(command.input.IfNoneMatch, "*");
        assert.equal(command.input.ChecksumSHA256, expected.checksumBase64);
        exists = true;
        return { VersionId: putVersion };
      }
      if (!exists) {
        const error = new Error("missing");
        error.name = "NotFound";
        throw error;
      }
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: drift ? 1 : expected.body.length,
          ContentType: "image/png",
          CacheControl: "public, max-age=31536000, immutable",
          ServerSideEncryption: "AES256",
          ChecksumSHA256: expected.checksumBase64,
          Metadata: { "rehearsal-run": "vay1360-27ba9106a4be3e023992ca59" },
          VersionId: headVersion,
        };
      }
      return {
        Body: { transformToByteArray: async () => expected.body },
      };
    },
  };
};

const createdS3 = makeS3();
const created = await ensurePositivePublicMediaObject({
  s3: createdS3,
  commands,
  http,
  env,
});
assert.equal(created.created, true);
assert.equal(created.retainedForEvidence, true);
assert.equal(created.roleArn, taskCredentials.RoleArn);
assert(!JSON.stringify(created).includes(taskCredentials.SecretAccessKey));
assert.equal(
  createdS3.calls.filter((call) => call instanceof PutObjectCommand).length,
  1,
);

const existingS3 = makeS3({ present: true });
const existing = await ensurePositivePublicMediaObject({
  s3: existingS3,
  commands,
  http,
  env,
});
assert.equal(existing.created, false);
assert.equal(
  existingS3.calls.some((call) => call instanceof PutObjectCommand),
  false,
);

await assert.rejects(
  ensurePositivePublicMediaObject({
    s3: makeS3({ present: true, drift: true }),
    commands,
    http,
    env,
  }),
  /OBJECT_METADATA/,
);
await assert.rejects(
  ensurePositivePublicMediaObject({
    s3: makeS3({ present: true }),
    commands,
    http: async (url) =>
      url.endsWith("/task")
        ? { status: 200, json: async () => ({ ...metadata, Containers: [] }) }
        : response(200),
    env,
  }),
  /ECS_IMAGE_DIGEST/,
);
await assert.rejects(
  ensurePositivePublicMediaObject({
    s3: makeS3({ present: true }),
    commands,
    http: async (url) =>
      url.endsWith("/task")
        ? { status: 200, json: async () => metadata }
        : url.includes("/v2/credentials/")
          ? {
              status: 200,
              json: async () => ({
                ...taskCredentials,
                RoleArn:
                  "arn:aws:iam::269416271598:role/vayada-production-application",
              }),
            }
          : response(url === expected.url ? 200 : 403),
    env,
  }),
  /ECS_TASK_ROLE/,
);
const applicationRole =
  "arn:aws:iam::269416271598:role/vayada-rehearsal-7200a43a-application";
const applicationRuntime = await attestPositivePublicMediaRuntime(
  async (url) =>
    url.endsWith("/task")
      ? {
          status: 200,
          json: async () => ({
            ...metadata,
            Containers: [
              {
                Name: "positive-public-profile",
                ImageID: expected.imageDigest,
              },
            ],
          }),
        }
      : {
          status: 200,
          json: async () => ({ ...taskCredentials, RoleArn: applicationRole }),
        },
  env,
  "positive-public-profile",
);
assert.equal(applicationRuntime.roleArn, applicationRole);
assert.equal(
  applicationRuntime.credentials.accessKeyId,
  taskCredentials.AccessKeyId,
);
await assert.rejects(
  attestPositivePublicMediaRuntime(
    async (url) =>
      url.endsWith("/task")
        ? { status: 200, json: async () => metadata }
        : {
            status: 200,
            json: async () => ({ ...taskCredentials, Token: "" }),
          },
    env,
  ),
  /ECS_CREDENTIAL_FORMAT/,
);
for (const options of [
  { present: true, headVersion: "null" },
  { putVersion: "null" },
  { putVersion: "version-1", headVersion: "version-2" },
]) {
  await assert.rejects(
    ensurePositivePublicMediaObject({
      s3: makeS3(options),
      commands,
      http,
      env,
    }),
    /OBJECT_METADATA|PUT_RECEIPT|PUT_VERSION_MISMATCH/,
  );
}

const source = readFileSync(
  new URL(
    "./migration-rehearsal-positive-public-media-object.mjs",
    import.meta.url,
  ),
  "utf8",
);
assert(source.includes('endpoint: "https://s3.eu-west-1.amazonaws.com"'));

console.log(
  "PASS: exact image/roles, container-only credentials, versioned object recovery, CDN bytes, raw-S3 denial, and drift refusal",
);
