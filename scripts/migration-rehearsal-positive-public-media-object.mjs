// VAY-1361: one retained synthetic PNG in the isolated rehearsal bucket.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const release = "7200a43a8ced02df98c518bf72a4101060434337";
const imageDigest =
  "sha256:fab6bafdd04009d5807b9e9362b2c0e0974e15077592343a02d23f18f27c8689";
const bucket = "vayada-rehearsal-7200a43a-269416271598";
const cdn = "https://d30tn7en2eythj.cloudfront.net";
const mediaObjectId = "f52de7c1-644a-4ed4-b136-000000000004";
const body = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const checksum = createHash("sha256").update(body).digest("hex");
const checksumBase64 = Buffer.from(checksum, "hex").toString("base64");
const key = `public/media/${mediaObjectId}/original_safe/sha256-${checksum}.png`;
const url = `${cdn}/${key.slice("public/".length)}`;
const taskRoles = Object.freeze({
  "positive-public-media-object":
    "arn:aws:iam::269416271598:role/vayada-rehearsal-7200a43a-media",
  "positive-public-profile":
    "arn:aws:iam::269416271598:role/vayada-rehearsal-7200a43a-application",
});
const alternateCredentialEnvironment = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
];

export const positivePublicMediaObject = Object.freeze({
  release,
  imageDigest,
  bucket,
  cdn,
  mediaObjectId,
  body,
  checksum,
  checksumBase64,
  key,
  url,
});

const requireTrue = (condition, code) => {
  if (!condition) throw new Error(code);
};

export function validatePositivePublicMediaEnvironment(env) {
  requireTrue(env.APPLICATION_RELEASE === release, "RELEASE_BINDING");
  requireTrue(env.PLATFORM_MEDIA_BUCKET === bucket, "BUCKET_BINDING");
  requireTrue(env.PLATFORM_MEDIA_CDN_BASE_URL === cdn, "CDN_BINDING");
  requireTrue(
    /^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9-]+$/.test(
      env.ECS_CONTAINER_METADATA_URI_V4 ?? "",
    ),
    "ECS_METADATA_URI",
  );
  requireTrue(
    /^\/v2\/credentials\/[A-Za-z0-9-]+$/.test(
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? "",
    ),
    "ECS_CREDENTIAL_URI",
  );
  requireTrue(
    alternateCredentialEnvironment.every((name) => !env[name]),
    "AWS_CREDENTIAL_SOURCE",
  );
}

export async function attestPositivePublicMediaRuntime(
  fetchMetadata,
  env,
  containerName = "positive-public-media-object",
) {
  validatePositivePublicMediaEnvironment(env);
  const expectedRoleArn = taskRoles[containerName];
  requireTrue(expectedRoleArn, "ECS_CONTAINER_NAME");
  const response = await fetchMetadata(
    `${env.ECS_CONTAINER_METADATA_URI_V4}/task`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    },
  );
  requireTrue(response.status === 200, "ECS_METADATA_STATUS");
  const metadata = await response.json();
  requireTrue(
    /^arn:aws:ecs:eu-west-1:269416271598:task\/vayada-backend-cluster\/[0-9a-f]{32}$/.test(
      metadata?.TaskARN ?? "",
    ),
    "ECS_TASK_ARN",
  );
  const matches = (metadata?.Containers ?? []).filter(
    (container) => container?.Name === containerName,
  );
  requireTrue(
    matches.length === 1 && matches[0].ImageID === imageDigest,
    "ECS_IMAGE_DIGEST",
  );
  const credentialResponse = await fetchMetadata(
    `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`,
    { redirect: "manual", signal: AbortSignal.timeout(5000) },
  );
  requireTrue(credentialResponse.status === 200, "ECS_CREDENTIAL_STATUS");
  const taskCredentials = await credentialResponse.json();
  requireTrue(taskCredentials?.RoleArn === expectedRoleArn, "ECS_TASK_ROLE");
  requireTrue(
    typeof taskCredentials.AccessKeyId === "string" &&
      taskCredentials.AccessKeyId.length > 0 &&
      typeof taskCredentials.SecretAccessKey === "string" &&
      taskCredentials.SecretAccessKey.length > 0 &&
      typeof taskCredentials.Token === "string" &&
      taskCredentials.Token.length > 0,
    "ECS_CREDENTIAL_FORMAT",
  );
  return {
    taskArn: metadata.TaskARN,
    imageDigest: matches[0].ImageID,
    roleArn: taskCredentials.RoleArn,
    credentials: {
      accessKeyId: taskCredentials.AccessKeyId,
      secretAccessKey: taskCredentials.SecretAccessKey,
      sessionToken: taskCredentials.Token,
    },
  };
}

function isMissing(error) {
  return (
    error?.name === "NotFound" ||
    error?.name === "NoSuchKey" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function verifyObject(s3, commands) {
  const expected = {
    Bucket: bucket,
    Key: key,
    ChecksumMode: "ENABLED",
  };
  const head = await s3.send(new commands.HeadObjectCommand(expected));
  requireTrue(
    head.ContentLength === body.length &&
      head.ContentType === "image/png" &&
      head.CacheControl === "public, max-age=31536000, immutable" &&
      head.ServerSideEncryption === "AES256" &&
      head.ChecksumSHA256 === checksumBase64 &&
      head.Metadata?.["rehearsal-run"] === "vay1360-27ba9106a4be3e023992ca59" &&
      typeof head.VersionId === "string" &&
      head.VersionId.length > 0 &&
      head.VersionId !== "null",
    "OBJECT_METADATA",
  );
  const object = await s3.send(new commands.GetObjectCommand(expected));
  const bytes = Buffer.from(await object.Body.transformToByteArray());
  requireTrue(bytes.equals(body), "OBJECT_BYTES");
  return head.VersionId;
}

export async function ensurePositivePublicMediaObject({
  s3,
  commands,
  http,
  env,
  runtime: providedRuntime,
}) {
  const runtime =
    providedRuntime ?? (await attestPositivePublicMediaRuntime(http, env));
  let created = false;
  let createdVersionId;
  try {
    await verifyObject(s3, commands);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const put = await s3.send(
      new commands.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: "image/png",
        CacheControl: "public, max-age=31536000, immutable",
        ServerSideEncryption: "AES256",
        ChecksumSHA256: checksumBase64,
        IfNoneMatch: "*",
        Metadata: { "rehearsal-run": "vay1360-27ba9106a4be3e023992ca59" },
      }),
    );
    requireTrue(
      typeof put.VersionId === "string" &&
        put.VersionId.length > 0 &&
        put.VersionId !== "null",
      "PUT_RECEIPT",
    );
    createdVersionId = put.VersionId;
    created = true;
  }
  const versionId = await verifyObject(s3, commands);
  if (created)
    requireTrue(versionId === createdVersionId, "PUT_VERSION_MISMATCH");
  let response;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    response = await http(url, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  requireTrue(
    response?.status === 200 &&
      response.headers.get("content-type") === "image/png",
    "PUBLIC_CDN_STATUS",
  );
  requireTrue(
    Buffer.from(await response.arrayBuffer()).equals(body),
    "PUBLIC_CDN_BYTES",
  );
  const raw = await http(
    `https://${bucket}.s3.eu-west-1.amazonaws.com/${key}`,
    { redirect: "error", signal: AbortSignal.timeout(5000) },
  );
  await raw.body?.cancel?.();
  requireTrue(raw.status === 403, "RAW_S3_PUBLIC_ACCESS");
  return {
    status: "PASS",
    scope: "positive-public-media-object",
    release,
    taskArn: runtime.taskArn,
    imageDigest: runtime.imageDigest,
    roleArn: runtime.roleArn,
    mediaObjectId,
    key,
    url,
    checksum,
    bytes: body.length,
    versionId,
    created,
    retainedForEvidence: true,
  };
}

export async function runPositivePublicMediaObject(env = process.env) {
  const req = createRequire(process.cwd() + "/package.json");
  const commands = req("@aws-sdk/client-s3");
  const runtime = await attestPositivePublicMediaRuntime(fetch, env);
  const s3 = new commands.S3Client({
    region: "eu-west-1",
    endpoint: "https://s3.eu-west-1.amazonaws.com",
    credentials: runtime.credentials,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    return await ensurePositivePublicMediaObject({
      s3,
      commands,
      http: fetch,
      env,
      runtime,
    });
  } finally {
    s3.destroy();
  }
}
