import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PositivePublicCommitError,
  checkPositivePublicMedia,
  deleteInstalledRows,
  installPositivePublicRows,
  positivePublicProfile,
  validatePositivePublicCleanupHash,
} from "./migration-rehearsal-positive-public.mjs";
import { positivePublicMediaObject as media } from "./migration-rehearsal-positive-public-media-object.mjs";

const original =
  "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b";
const installed = "a".repeat(64);

function databaseFixture(options = {}) {
  let rows = new Set();
  let transaction = new Set();
  let savepoint = new Set();
  let disconnected = false;
  const mutations = [];
  const events = [];
  const client = {
    async query(sql) {
      if (disconnected) throw new Error("CONNECTION_LOST");
      events.push(sql);
      if (sql.startsWith("BEGIN")) transaction = new Set(rows);
      if (sql === "SAVEPOINT cleanup_probe") savepoint = new Set(rows);
      if (sql === "ROLLBACK TO SAVEPOINT cleanup_probe")
        rows = new Set(savepoint);
      if (sql === "ROLLBACK") rows = new Set(transaction);
      if (sql === "COMMIT" && options.commitFailure)
        throw new Error("COMMIT_FAILED");
      if (sql === "COMMIT" && options.commitAfterApply) {
        disconnected = true;
        throw new Error("CONNECTION_LOST_AFTER_COMMIT");
      }
      if (sql.includes("AS found"))
        return { rows: [{ found: options.collision === true }] };
      const insert = sql.match(/^INSERT INTO ([a-z_.]+)/);
      if (insert) {
        mutations.push(sql);
        rows.add(insert[1]);
      }
      const remove = sql.match(/^DELETE FROM ([a-z_.]+)/);
      if (remove) {
        mutations.push(sql);
        const existed = rows.delete(remove[1]);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const capture = async () => {
    const count = rows.size;
    return {
      sha256: options.hashDrift
        ? "b".repeat(64)
        : count === 0
          ? original
          : installed,
      tables: 210,
      rows: 449379 + count,
    };
  };
  return {
    client,
    capture,
    emit: (record) => events.push(record),
    events,
    mutations,
    rowCount: () => rows.size,
    begin: () => client.query("BEGIN ISOLATION LEVEL READ COMMITTED"),
    reconnect: () => {
      disconnected = false;
    },
  };
}

{
  const fixture = databaseFixture();
  assert.equal(
    await installPositivePublicRows(
      fixture.client,
      fixture.capture,
      fixture.emit,
    ),
    installed,
  );
  assert.equal(fixture.rowCount(), 7);
  assert.equal(
    fixture.mutations.filter((sql) => sql.startsWith("INSERT")).length,
    7,
  );
  assert(
    fixture.mutations.every(
      (sql) =>
        !/production_media_migration|source_extraction|legacy/i.test(sql),
    ),
  );
  const prepared = fixture.events.find(
    (event) => event?.status === "POSITIVE_PUBLIC_PREPARED",
  );
  assert.deepEqual(prepared, {
    status: "POSITIVE_PUBLIC_PREPARED",
    runId: "vay1360-27ba9106a4be3e023992ca59",
    release: "7200a43a8ced02df98c518bf72a4101060434337",
    temporaryDataSha256: installed,
    addedRows: 7,
    committed: false,
  });
  assert(fixture.events.indexOf(prepared) < fixture.events.indexOf("COMMIT"));

  await fixture.begin();
  await deleteInstalledRows(fixture.client, installed, fixture.capture);
  assert.equal(fixture.rowCount(), 0);
  assert.equal(
    fixture.mutations.filter((sql) => sql.startsWith("DELETE")).length,
    14,
  );
}

for (const [options, failure] of [
  [{ collision: true }, /PUBLIC_TEST_COLLISION/],
  [{ hashDrift: true }, /MIGRATED_ROWS_CHANGED/],
  [{ commitFailure: true }, PositivePublicCommitError],
]) {
  const fixture = databaseFixture(options);
  await assert.rejects(
    installPositivePublicRows(fixture.client, fixture.capture, fixture.emit),
    failure,
  );
  assert.equal(fixture.rowCount(), 0);
}

{
  const fixture = databaseFixture({ commitAfterApply: true });
  let failure;
  await assert.rejects(
    installPositivePublicRows(fixture.client, fixture.capture, fixture.emit),
    (error) => {
      failure = error;
      return error instanceof PositivePublicCommitError;
    },
  );
  assert.equal(failure.preparedHash, installed);
  assert.equal(fixture.rowCount(), 7);
  fixture.reconnect();
  await fixture.begin();
  await deleteInstalledRows(
    fixture.client,
    failure.preparedHash,
    fixture.capture,
  );
  assert.equal(fixture.rowCount(), 0);
}

for (const value of [undefined, "bad", original]) {
  assert.throws(
    () => validatePositivePublicCleanupHash(value),
    /EXPECTED_PUBLIC_HASH/,
  );
}
validatePositivePublicCleanupHash(installed);

{
  const fixture = databaseFixture();
  await assert.rejects(
    deleteInstalledRows(fixture.client, installed, fixture.capture),
    /PUBLIC_OR_MIGRATED_DATA_DRIFT/,
  );
  assert.equal(fixture.rowCount(), 0);
}

class GetObjectCommand {
  constructor(input) {
    this.input = input;
  }
}
const registryRow = {
  id: media.mediaObjectId,
  bucket: media.bucket,
  key: media.key,
  mime: "image/png",
  bytes: media.body.length,
  checksum: media.checksum,
  approved: true,
  lifecycle: "active",
  url: media.url,
};
const reader = {
  async query(_sql, values) {
    assert.deepEqual(values, [
      media.mediaObjectId,
      positivePublicProfile.propertyId,
    ]);
    return { rows: [registryRow] };
  },
};
const s3 = {
  async send(command) {
    assert(command instanceof GetObjectCommand);
    assert.deepEqual(command.input, {
      Bucket: media.bucket,
      Key: media.key,
      ChecksumMode: "ENABLED",
    });
    return {
      ContentLength: media.body.length,
      ContentType: "image/png",
      Body: [media.body],
    };
  },
};
const response = (status, body = media.body) => ({
  status,
  headers: new Headers({ "content-type": "image/png" }),
  body: [body],
});
const http = async (url) => response(url === media.url ? 200 : 403);
assert.deepEqual(
  await checkPositivePublicMedia(reader, s3, GetObjectCommand, http),
  { publicObjects: 1, publicCdnDeliveries: 1, rawS3Denials: 1 },
);
await assert.rejects(
  checkPositivePublicMedia(reader, s3, GetObjectCommand, async () =>
    response(200),
  ),
  /POSITIVE_PUBLIC_RAW_S3_ACCESS/,
);
await assert.rejects(
  checkPositivePublicMedia(
    { query: async () => ({ rows: [{ ...registryRow, approved: false }] }) },
    s3,
    GetObjectCommand,
    http,
  ),
  /POSITIVE_PUBLIC_MEDIA_REGISTRY/,
);

const source = readFileSync(
  new URL("./migration-rehearsal-positive-public.mjs", import.meta.url),
  "utf8",
);
assert(!/INSERT INTO platform\.production_media_migration/.test(source));
assert(!/source_url|original_url|legacy_database/i.test(source));
assert(!/UPDATE |TRUNCATE|ON CONFLICT|CASCADE/.test(source));
assert(source.includes("fullSmokeAccepted: false"));
assert(source.includes('endpoint: "https://s3.eu-west-1.amazonaws.com"'));

console.log(
  "PASS: seven fresh rows, no legacy/ledger claim, exact cleanup, public CDN bytes, raw-S3 denial, and drift refusal",
);
