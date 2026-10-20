// ShapesOS — Phase 21B (WS=drive): the multipart upload state machine (unit).
// Run: npx tsx --test lib/drive/__tests__/multipart.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PART_BYTES,
  MAX_PARTS,
  choosePartSize,
  completeUpload,
  newUpload,
  abortUpload,
  recordPart,
  expire,
  type UploadState,
} from "../multipart";

const MiB = 1024 * 1024;
const t0 = new Date("2026-11-01T10:00:00Z");

function started(total = 40 * MiB, partSize = 16 * MiB): UploadState {
  return newUpload({ totalBytes: total, partSize, now: t0, ttlMs: 24 * 3600_000 });
}

describe("choosePartSize", () => {
  it("uses 16 MiB parts for ordinary files", () => {
    assert.equal(choosePartSize(100 * MiB), 16 * MiB);
  });
  it("grows the part size so a huge file never needs more than 10,000 parts", () => {
    const total = 400 * 1024 * MiB; // 400 GiB
    const size = choosePartSize(total);
    assert.ok(Math.ceil(total / size) <= MAX_PARTS);
    assert.equal(size % MiB, 0, "whole MiB");
  });
  it("never goes below the S3 minimum part size", () => {
    assert.ok(choosePartSize(1) >= MIN_PART_BYTES);
  });
});

describe("state machine", () => {
  it("starts initiated with the part count worked out from the size", () => {
    const u = started(40 * MiB, 16 * MiB);
    assert.equal(u.status, "initiated");
    assert.equal(u.partCount, 3); // 16 + 16 + 8
    assert.equal(u.expiresAt.toISOString(), "2026-11-02T10:00:00.000Z");
  });

  it("records parts in any order and resumes: re-sending a part replaces its etag", () => {
    let u = started();
    u = recordPart(u, 2, { etag: "b", size: 16 * MiB });
    u = recordPart(u, 1, { etag: "a", size: 16 * MiB });
    u = recordPart(u, 2, { etag: "b2", size: 16 * MiB });
    assert.deepEqual(Object.keys(u.parts).sort(), ["1", "2"]);
    assert.equal(u.parts[2]!.etag, "b2");
    assert.equal(u.status, "uploading");
  });

  it("rejects a part number outside the plan or a wrong-sized non-final part", () => {
    const u = started();
    assert.throws(() => recordPart(u, 0, { etag: "x", size: 1 }), /part number/i);
    assert.throws(() => recordPart(u, 4, { etag: "x", size: 1 }), /part number/i);
    assert.throws(() => recordPart(u, 1, { etag: "x", size: 5 * MiB }), /size/i);
    assert.throws(() => recordPart(u, 3, { etag: "x", size: 9 * MiB }), /size/i, "the final part must be exactly the remainder");
    recordPart(u, 3, { etag: "x", size: 8 * MiB });
  });

  it("completes only when every part is present, returning them in order with their etags", () => {
    let u = started();
    u = recordPart(u, 3, { etag: "c", size: 8 * MiB });
    u = recordPart(u, 1, { etag: "a", size: 16 * MiB });
    assert.throws(() => completeUpload(u), /missing part 2/i);
    u = recordPart(u, 2, { etag: "b", size: 16 * MiB });
    const done = completeUpload(u);
    assert.equal(done.state.status, "completing");
    assert.deepEqual(done.parts, [
      { partNumber: 1, etag: "a" },
      { partNumber: 2, etag: "b" },
      { partNumber: 3, etag: "c" },
    ]);
  });

  it("abort and expiry are terminal; nothing can be recorded after", () => {
    const aborted = abortUpload(started());
    assert.equal(aborted.status, "aborted");
    assert.throws(() => recordPart(aborted, 1, { etag: "a", size: 16 * MiB }), /aborted/i);
    assert.throws(() => completeUpload(aborted), /aborted/i);
    const old = expire(started(), new Date("2026-11-02T10:00:01Z"));
    assert.equal(old.status, "expired");
    assert.equal(expire(started(), new Date("2026-11-02T09:59:59Z")).status, "initiated");
  });

  it("a completed upload is final: a second complete is refused", () => {
    let u = started(10 * MiB, 16 * MiB);
    u = recordPart(u, 1, { etag: "a", size: 10 * MiB });
    const done = completeUpload(u);
    assert.throws(() => completeUpload({ ...done.state, status: "completed" }), /already/i);
  });
});
