// VAY-1361: reversible target-only positive public profile and media delivery proof.
import { createRequire } from "node:module";

import {
  binding,
  guardedConnection,
  requireTrue,
} from "./migration-rehearsal-reader-contract.mjs";
import {
  applicationEnvironment,
  captureRows,
  captureRowsSnapshot,
  runReadOnlyApplication,
} from "./migration-rehearsal-app-readonly.mjs";
import {
  checkMediaBytes,
  checkPublicProfiles,
} from "./migration-rehearsal-public-media.mjs";
import {
  attestPositivePublicMediaRuntime,
  positivePublicMediaObject,
} from "./migration-rehearsal-positive-public-media-object.mjs";

const originalData =
  "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b";
const profile = Object.freeze({
  propertyId: "f52de7c1-644a-4ed4-b136-000000000001",
  slugId: "f52de7c1-644a-4ed4-b136-000000000002",
  propertyMediaId: "f52de7c1-644a-4ed4-b136-000000000003",
  mediaVariantId: "f52de7c1-644a-4ed4-b136-000000000005",
  publicId: "vay1361-positive-public-smoke",
  slug: "vay1361-positive-public-smoke",
  name: "VAY-1361 synthetic public smoke",
});
const tables = [
  "hotel_catalog.properties",
  "hotel_catalog.property_slugs",
  "hotel_catalog.property_media",
  "hotel_catalog.property_public_profile_read_model",
  "platform.media_objects",
  "platform.media_variants",
  "distribution.public_hotel_bookability_profiles",
];

export const positivePublicProfile = Object.freeze({ ...profile, tables });

export class PositivePublicCommitError extends Error {
  constructor(preparedHash, cause) {
    super("POSITIVE_PUBLIC_COMMIT_AMBIGUOUS", { cause });
    this.name = "PositivePublicCommitError";
    this.preparedHash = preparedHash;
  }
}

export function validatePositivePublicCleanupHash(expectedHash) {
  requireTrue(
    /^[a-f0-9]{64}$/.test(expectedHash ?? "") && expectedHash !== originalData,
    "EXPECTED_PUBLIC_HASH",
  );
}

const preparedPositivePublicHash = (error) =>
  error instanceof PositivePublicCommitError &&
  /^[a-f0-9]{64}$/.test(error.preparedHash)
    ? error.preparedHash
    : undefined;

const combineFailures = (runFailure, cleanupFailure) =>
  runFailure && cleanupFailure
    ? new AggregateError(
        [runFailure, cleanupFailure],
        "PUBLIC_RUN_AND_CLEANUP_FAILED",
      )
    : (cleanupFailure ?? runFailure);

async function lockRows(client, isolation = "SERIALIZABLE") {
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query("SELECT pg_advisory_xact_lock(1361,1362)");
  await client.query(
    `LOCK TABLE ${tables.join(",")} IN SHARE ROW EXCLUSIVE MODE`,
  );
}

async function deleteRows(client) {
  const statements = [
    [
      "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id=$1",
      profile.propertyId,
    ],
    [
      "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1",
      profile.propertyId,
    ],
    [
      "DELETE FROM hotel_catalog.property_media WHERE id=$1",
      profile.propertyMediaId,
    ],
    ["DELETE FROM platform.media_variants WHERE id=$1", profile.mediaVariantId],
    [
      "DELETE FROM platform.media_objects WHERE id=$1",
      positivePublicMediaObject.mediaObjectId,
    ],
    ["DELETE FROM hotel_catalog.property_slugs WHERE id=$1", profile.slugId],
    ["DELETE FROM hotel_catalog.properties WHERE id=$1", profile.propertyId],
  ];
  for (const [sql, id] of statements) {
    requireTrue(
      (await client.query(sql, [id])).rowCount === 1,
      "PUBLIC_CLEANUP_ROW_COUNT",
    );
  }
}

export async function installPositivePublicRows(
  client,
  captureSnapshot = captureRowsSnapshot,
  emitPrepared = (record) => console.log(JSON.stringify(record)),
) {
  await lockRows(client);
  let preparedHash;
  try {
    requireTrue(
      (await captureSnapshot(client)).sha256 === originalData,
      "MIGRATED_ROWS_CHANGED",
    );
    const collision = (
      await client.query(
        `SELECT
          EXISTS(SELECT 1 FROM hotel_catalog.properties WHERE id=$1 OR public_id=$2) OR
          EXISTS(SELECT 1 FROM hotel_catalog.property_slugs WHERE id=$3 OR slug=$4) OR
          EXISTS(SELECT 1 FROM hotel_catalog.property_media WHERE id=$5) OR
          EXISTS(SELECT 1 FROM platform.media_objects WHERE id=$6) OR
          EXISTS(SELECT 1 FROM platform.media_variants WHERE id=$7) OR
          EXISTS(SELECT 1 FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1 OR public_id=$2) OR
          EXISTS(SELECT 1 FROM distribution.public_hotel_bookability_profiles WHERE property_id=$1 OR public_id=$2)
          AS found`,
        [
          profile.propertyId,
          profile.publicId,
          profile.slugId,
          profile.slug,
          profile.propertyMediaId,
          positivePublicMediaObject.mediaObjectId,
          profile.mediaVariantId,
        ],
      )
    ).rows[0];
    requireTrue(collision?.found === false, "PUBLIC_TEST_COLLISION");
    await client.query(
      `INSERT INTO hotel_catalog.properties
        (id,public_id,display_name,profile_status,lifecycle_status)
       VALUES ($1,$2,$3,'complete','active')`,
      [profile.propertyId, profile.publicId, profile.name],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_slugs (id,property_id,slug,purpose,status)
       VALUES ($1,$2,$3,'canonical','active')`,
      [profile.slugId, profile.propertyId, profile.slug],
    );
    await client.query(
      `INSERT INTO platform.media_objects
       (id,bucket,storage_key,visibility,purpose,property_id,resource_product,
         resource_type,resource_id,lifecycle_status,content_type,size_bytes,
         checksum_sha256,source_system,public_approved,source_metadata)
       VALUES ($1,$2,$3,'public','property.gallery_image',$4::uuid,'hotel_catalog',
         'property',$4::text,'active','image/png',$5,$6,'platform',TRUE,
         '{"temporary":true,"scope":"vay1361-positive-public-smoke"}'::jsonb)`,
      [
        positivePublicMediaObject.mediaObjectId,
        positivePublicMediaObject.bucket,
        positivePublicMediaObject.key,
        profile.propertyId,
        positivePublicMediaObject.body.length,
        positivePublicMediaObject.checksum,
      ],
    );
    await client.query(
      `INSERT INTO platform.media_variants
        (id,media_object_id,variant_name,visibility,storage_key,content_type,
         size_bytes,checksum_sha256,public_cdn_url)
       VALUES ($1,$2,'original_safe','public',$3,'image/png',$4,$5,$6)`,
      [
        profile.mediaVariantId,
        positivePublicMediaObject.mediaObjectId,
        positivePublicMediaObject.key,
        positivePublicMediaObject.body.length,
        positivePublicMediaObject.checksum,
        positivePublicMediaObject.url,
      ],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_media
        (id,property_id,media_type,url,alt_text,source_system,public_approved,platform_media_object_id)
       VALUES ($1,$2,'gallery_image',$3,'Synthetic rehearsal image','platform',TRUE,$4)`,
      [
        profile.propertyMediaId,
        profile.propertyId,
        `platform-media:${positivePublicMediaObject.mediaObjectId}`,
        positivePublicMediaObject.mediaObjectId,
      ],
    );
    const media = JSON.stringify([
      {
        type: "gallery_image",
        url: positivePublicMediaObject.url,
        altText: "Synthetic rehearsal image",
      },
    ]);
    await client.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model
        (property_id,public_id,display_name,canonical_slug,default_locale,
         supported_locales,profile_status,media,source_freshness)
       VALUES ($1,$2,$3,$4,'en',ARRAY['en'],'complete',$5::jsonb,
         jsonb_build_object('hotel_catalog',jsonb_build_object('status','fresh','generatedAt',now())))`,
      [profile.propertyId, profile.publicId, profile.name, profile.slug, media],
    );
    await client.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles
        (property_id,public_id,canonical_slug,canonical_url,booking_base_url,
         timezone,default_locale,supported_locales,default_currency,
         supported_currencies,profile_status,public_identity,media,capabilities,
         supported_quote_parameters,public_setup_completeness,source_freshness,
         freshness_status,data_sources)
       VALUES ($1,$2,$3,$4,$5,'Etc/UTC','en',ARRAY['en'],'EUR',ARRAY['EUR'],
         'public',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,
         '{"status":"ready","missing":[]}'::jsonb,$10::jsonb,'fresh',
         ARRAY['hotel_catalog','booking','pms','finance','distribution'])`,
      [
        profile.propertyId,
        profile.publicId,
        profile.slug,
        `https://${profile.slug}.booking.vayada.com/en`,
        `https://${profile.slug}.booking.vayada.com`,
        JSON.stringify({
          propertyId: profile.publicId,
          slug: profile.slug,
          name: profile.name,
        }),
        media,
        JSON.stringify({
          instantBook: false,
          onlinePayment: false,
          payAtProperty: true,
          promoCodes: false,
          referralCodes: false,
          bookingDeepLinks: true,
        }),
        JSON.stringify({
          minRooms: 1,
          maxRooms: 1,
          minAdults: 1,
          maxAdults: 2,
          childrenSupported: false,
          adultAgeThreshold: 18,
          supportedCurrencies: ["EUR"],
          supportedLocales: ["en"],
        }),
        JSON.stringify(
          Object.fromEntries(
            ["hotel_catalog", "booking", "pms", "finance", "distribution"].map(
              (owner) => [
                owner,
                { status: "fresh", generatedAt: "2026-09-10T14:00:00.000Z" },
              ],
            ),
          ),
        ),
      ],
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const installed = await captureSnapshot(client);
    requireTrue(
      installed.tables === 210 && installed.rows === 449386,
      "PUBLIC_ROW_DELTA",
    );
    await client.query("SAVEPOINT cleanup_probe");
    await deleteRows(client);
    requireTrue(
      (await captureSnapshot(client)).sha256 === originalData,
      "PUBLIC_INSERT_SIDE_EFFECT",
    );
    await client.query("ROLLBACK TO SAVEPOINT cleanup_probe");
    preparedHash = installed.sha256;
    emitPrepared({
      status: "POSITIVE_PUBLIC_PREPARED",
      runId: binding.runId,
      release: binding.release,
      temporaryDataSha256: preparedHash,
      addedRows: 7,
      committed: false,
    });
    try {
      await client.query("COMMIT");
    } catch (error) {
      throw new PositivePublicCommitError(preparedHash, error);
    }
    return preparedHash;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function deleteInstalledRows(
  client,
  expectedHash,
  captureSnapshot = captureRowsSnapshot,
) {
  validatePositivePublicCleanupHash(expectedHash);
  requireTrue(
    (await captureSnapshot(client)).sha256 === expectedHash,
    "PUBLIC_OR_MIGRATED_DATA_DRIFT",
  );
  await deleteRows(client);
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  requireTrue(
    (await captureSnapshot(client)).sha256 === originalData,
    "PUBLIC_CLEANUP_DATA_MISMATCH",
  );
}

export async function ensurePositivePublicRowsRemoved(
  Client,
  env,
  expectedHash,
) {
  validatePositivePublicCleanupHash(expectedHash);
  const admin = new Client({
    connectionString: guardedConnection(
      env.ADMIN_DATABASE_URL,
      "admin",
    ).toString(),
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=15000 -c lock_timeout=3000",
    application_name: "vay1361-positive-public-cleanup",
  });
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    await lockRows(admin, "READ COMMITTED");
    const current = await captureRowsSnapshot(admin);
    if (current.sha256 === originalData) {
      await admin.query("ROLLBACK");
      return { dataSha256: originalData, removedRows: 0, alreadyAbsent: true };
    }
    requireTrue(
      current.sha256 === expectedHash,
      "PUBLIC_OR_MIGRATED_DATA_DRIFT",
    );
    await deleteInstalledRows(admin, expectedHash);
    await admin.query("COMMIT");
    requireTrue(
      (await captureRows(admin)).sha256 === originalData,
      "PUBLIC_POST_COMMIT_CLEANUP_MISMATCH",
    );
    return { dataSha256: originalData, removedRows: 7, alreadyAbsent: false };
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await admin.end().catch(() => {});
  }
}

export async function checkPositivePublicMedia(
  reader,
  s3,
  GetObjectCommand,
  http,
  s3TimeoutMs = 15000,
) {
  const result = await reader.query(
    `SELECT m.id::text,m.bucket,m.storage_key AS key,m.content_type AS mime,
       m.size_bytes::int AS bytes,m.checksum_sha256 AS checksum,
       m.public_approved AS approved,m.lifecycle_status AS lifecycle,
       v.public_cdn_url AS url
     FROM platform.media_objects m
     JOIN platform.media_variants v ON v.media_object_id=m.id
       AND v.variant_name='original_safe' AND v.visibility='public'
     JOIN hotel_catalog.property_media p ON p.platform_media_object_id=m.id
       AND p.property_id=m.property_id AND p.public_approved
     WHERE m.id=$1 AND m.property_id=$2`,
    [positivePublicMediaObject.mediaObjectId, profile.propertyId],
  );
  const row = result.rows[0];
  requireTrue(
    result.rows.length === 1 &&
      row.bucket === positivePublicMediaObject.bucket &&
      row.key === positivePublicMediaObject.key &&
      row.mime === "image/png" &&
      row.bytes === positivePublicMediaObject.body.length &&
      row.checksum === positivePublicMediaObject.checksum &&
      row.url === positivePublicMediaObject.url &&
      row.approved === true &&
      row.lifecycle === "active",
    "POSITIVE_PUBLIC_MEDIA_REGISTRY",
  );
  const controller = new AbortController();
  const timeoutError = new Error("POSITIVE_PUBLIC_S3_TIMEOUT");
  let object;
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(timeoutError);
      object?.Body?.destroy?.(timeoutError);
      Promise.resolve(object?.Body?.cancel?.(timeoutError)).catch(() => {});
      reject(timeoutError);
    }, s3TimeoutMs);
  });
  try {
    object = await Promise.race([
      s3.send(
        new GetObjectCommand({
          Bucket: row.bucket,
          Key: row.key,
          ChecksumMode: "ENABLED",
        }),
        { abortSignal: controller.signal },
      ),
      timeout,
    ]);
    requireTrue(
      object.ContentLength === row.bytes && object.ContentType === row.mime,
      "POSITIVE_PUBLIC_MEDIA_METADATA",
    );
    await Promise.race([checkMediaBytes(object.Body, row), timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  const response = await http(row.url, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  requireTrue(
    response.status === 200 &&
      response.headers.get("content-type") === row.mime,
    "POSITIVE_PUBLIC_CDN_STATUS",
  );
  await checkMediaBytes(response.body, row);
  const raw = await http(
    `https://${row.bucket}.s3.eu-west-1.amazonaws.com/${row.key}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    },
  );
  await raw.body?.cancel?.();
  requireTrue(raw.status === 403, "POSITIVE_PUBLIC_RAW_S3_ACCESS");
  return { publicObjects: 1, publicCdnDeliveries: 1, rawS3Denials: 1 };
}

export async function runPositivePublicProfile(Client, env) {
  applicationEnvironment(env);
  const runtime = await attestPositivePublicMediaRuntime(
    fetch,
    env,
    "positive-public-profile",
  );
  const req = createRequire(process.cwd() + "/package.json");
  const { assertPublicBookabilityPublicSafe } = req(
    "@vayada/domain-distribution",
  );
  const { GetObjectCommand, S3Client } = req("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "eu-west-1",
    endpoint: "https://s3.eu-west-1.amazonaws.com",
    credentials: runtime.credentials,
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const admin = new Client({
    connectionString: guardedConnection(
      env.ADMIN_DATABASE_URL,
      "admin",
    ).toString(),
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=15000 -c lock_timeout=3000",
    application_name: "vay1361-positive-public",
  });
  let installed;
  let result;
  let failure;
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    try {
      installed = await installPositivePublicRows(admin);
    } catch (error) {
      installed = preparedPositivePublicHash(error);
      throw error;
    }
    console.log(
      JSON.stringify({
        status: "POSITIVE_PUBLIC_INSTALLED",
        runId: binding.runId,
        temporaryDataSha256: installed,
        addedRows: 7,
      }),
    );
    const application = await runReadOnlyApplication(
      Client,
      env,
      async (get, reader, before) => {
        requireTrue(before.sha256 === installed, "PUBLIC_INSTALLED_HASH");
        const profiles = await checkPublicProfiles(
          get,
          reader,
          assertPublicBookabilityPublicSafe,
        );
        requireTrue(
          profiles.positivePublicProfileProven === true &&
            profiles.allowedRequests === 2,
          "POSITIVE_PUBLIC_PROFILE",
        );
        for (const prefix of ["/api/booking-web/hotels/", "/api/ai/hotels/"]) {
          const response = await get(prefix + profile.slug);
          const body = await response.json();
          requireTrue(
            response.status === 200 &&
              body.hotel?.propertyId === profile.publicId &&
              body.hotel?.images?.some(
                (image) => image.url === positivePublicMediaObject.url,
              ),
            "POSITIVE_PUBLIC_PROFILE_MEDIA",
          );
        }
        const media = await checkPositivePublicMedia(
          reader,
          s3,
          GetObjectCommand,
          fetch,
        );
        result = { profiles, media };
      },
    );
    requireTrue(
      application.applicationStopped === true,
      "PUBLIC_APPLICATION_STOP",
    );
  } catch (error) {
    failure = error;
  }
  await admin.end().catch(() => {});
  s3.destroy();
  let cleanupFailure;
  if (installed) {
    try {
      const cleanup = await ensurePositivePublicRowsRemoved(
        Client,
        env,
        installed,
      );
      console.log(
        JSON.stringify({
          status: "POSITIVE_PUBLIC_REMOVED",
          runId: binding.runId,
          ...cleanup,
        }),
      );
    } catch (error) {
      cleanupFailure = error;
    }
  }
  const finalFailure = combineFailures(failure, cleanupFailure);
  if (finalFailure) throw finalFailure;
  return {
    status: "PASS",
    scope: "positive-public-profile-and-media",
    runId: binding.runId,
    release: binding.release,
    taskArn: runtime.taskArn,
    imageDigest: runtime.imageDigest,
    roleArn: runtime.roleArn,
    ...result,
    dataSha256: originalData,
    addedRows: 7,
    removedRows: 7,
    applicationStopped: true,
    positivePublicProfileProven: true,
    positivePublicMediaProven: true,
    fullSmokeAccepted: false,
  };
}

export async function runPositivePublicCleanup(Client, env) {
  const cleanup = await ensurePositivePublicRowsRemoved(
    Client,
    env,
    env.REHEARSAL_CLEANUP_HASH,
  );
  return {
    status: "PASS",
    scope: "positive-public-cleanup-only",
    runId: binding.runId,
    ...cleanup,
    positivePublicProfileProven: false,
    positivePublicMediaProven: false,
    fullSmokeAccepted: false,
  };
}
