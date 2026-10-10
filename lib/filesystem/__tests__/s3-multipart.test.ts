// ShapesOS — Phase 21B (WS=drive): multipart upload on the S3 adapter, against the
// in-process S3-compatible FAKE (lib/filesystem/fake-s3.ts — a labelled fake, not
// real R2/S3; real-provider behaviour is UNVERIFIED-LIVE). (unit, no database)
// Run: npx tsx --test lib/filesystem/__tests__/s3-multipart.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startFakeS3, type FakeS3 } from "../fake-s3";
import { S3CompatibleAdapter } from "../storage";

const MiB = 1024 * 1024;
let fake: FakeS3;
let s3: S3CompatibleAdapter;

before(async () => {
  fake = await startFakeS3({ bucket: "drive", accessKeyId: "AKIAFAKE", secretAccessKey: "fakesecret", region: "auto" });
  s3 = new S3CompatibleAdapter({ endpoint: fake.endpoint, region: "auto", bucket: "drive", accessKey: "AKIAFAKE", secretKey: "fakesecret", forcePathStyle: true });
});
after(async () => {
  await fake.close();
});

async function putPart(url: string, body: Buffer) {
  return fetch(url, { method: "PUT", body: new Uint8Array(body) });
}

describe("multipart upload through presigned part URLs", () => {
  it("uploads three parts straight to storage, lists them, completes, and the object is the concatenation", async () => {
    const key = randomUUID();
    const uploadId = await s3.createMultipartUpload(key, "application/pdf");
    const parts = [Buffer.alloc(5 * MiB, 1), Buffer.alloc(5 * MiB, 2), Buffer.alloc(1 * MiB, 3)];
    for (let i = 0; i < parts.length; i++) {
      const url = await s3.presignUploadPart(key, uploadId, i + 1, 900);
      assert.match(url, /X-Amz-Signature=/);
      const res = await putPart(url, parts[i]!);
      assert.equal(res.status, 200, `part ${i + 1}`);
    }
    const listed = await s3.listParts(key, uploadId);
    assert.deepEqual(listed.map((p) => [p.partNumber, p.size]), [[1, 5 * MiB], [2, 5 * MiB], [3, 1 * MiB]]);
    await s3.completeMultipartUpload(key, uploadId, listed.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
    assert.equal(await s3.size(key), 11 * MiB);
    const all = await s3.get(key);
    assert.ok(all && all.equals(Buffer.concat(parts)));
    assert.equal(fake.uploads.size, 0, "the upload is closed");
  });

  it("a part can be re-sent (resume) and the newest bytes win", async () => {
    const key = randomUUID();
    const uploadId = await s3.createMultipartUpload(key, "text/plain");
    const url = await s3.presignUploadPart(key, uploadId, 1, 900);
    await putPart(url, Buffer.from("first"));
    await putPart(url, Buffer.from("second"));
    const listed = await s3.listParts(key, uploadId);
    assert.deepEqual(listed.map((p) => [p.partNumber, p.size]), [[1, 6]]);
    await s3.abortMultipartUpload(key, uploadId);
  });

  it("refuses a tampered URL (another part number) and an expired one", async () => {
    const key = randomUUID();
    const uploadId = await s3.createMultipartUpload(key, "text/plain");
    const url = await s3.presignUploadPart(key, uploadId, 1, 900);
    const tampered = url.replace("partNumber=1", "partNumber=2");
    assert.equal((await putPart(tampered, Buffer.from("x"))).status, 403);
    const short = await s3.presignUploadPart(key, uploadId, 1, 1);
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal((await putPart(short, Buffer.from("x"))).status, 403);
    await s3.abortMultipartUpload(key, uploadId);
  });

  it("completing with a part that is too small in the middle fails like S3 does (EntityTooSmall)", async () => {
    const key = randomUUID();
    const uploadId = await s3.createMultipartUpload(key, "text/plain");
    await putPart(await s3.presignUploadPart(key, uploadId, 1, 900), Buffer.from("tiny"));
    await putPart(await s3.presignUploadPart(key, uploadId, 2, 900), Buffer.from("tail"));
    const listed = await s3.listParts(key, uploadId);
    await assert.rejects(() => s3.completeMultipartUpload(key, uploadId, listed.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))), /EntityTooSmall/);
    await s3.abortMultipartUpload(key, uploadId);
  });

  it("abort drops the upload; listing it afterwards fails", async () => {
    const key = randomUUID();
    const uploadId = await s3.createMultipartUpload(key, "text/plain");
    await s3.abortMultipartUpload(key, uploadId);
    await assert.rejects(() => s3.listParts(key, uploadId), /no longer exists/i);
    assert.equal(await s3.exists(key), false);
  });
});

describe("ranges and size", () => {
  it("reads a byte range and reports the size without downloading the object", async () => {
    const key = randomUUID();
    await s3.put(key, Buffer.from("0123456789"), "text/plain");
    assert.equal(await s3.size(key), 10);
    assert.equal((await s3.getRange(key, 2, 5))!.toString(), "2345");
    assert.equal(await s3.size(randomUUID()), null);
  });
});
