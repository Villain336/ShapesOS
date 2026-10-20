// ShapesOS — Phase 21B (WS=drive): SigV4 query-string signing (presigned URLs) (unit).
// Run: npx tsx --test lib/filesystem/__tests__/s3-presign.test.ts
//
// The vector is AWS's published example ("Authenticating Requests: Using Query
// Parameters", GET /test.txt on examplebucket, 2013-05-24): the expected
// signature below comes from the AWS documentation, not from this code.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { presignV4 } from "../s3-presign";

const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

describe("presignV4", () => {
  it("matches the AWS documentation example signature", () => {
    const r = presignV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      canonicalPath: "/test.txt",
      query: {},
      region: "us-east-1",
      credentials: creds,
      now: new Date("2013-05-24T00:00:00Z"),
      expiresSec: 86400,
    });
    assert.equal(r.signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    assert.equal(
      r.canonicalRequest,
      [
        "GET",
        "/test.txt",
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
        "host:examplebucket.s3.amazonaws.com",
        "",
        "host",
        "UNSIGNED-PAYLOAD",
      ].join("\n"),
    );
    assert.ok(r.queryString.endsWith("&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"));
  });

  it("signs extra query parameters (partNumber, uploadId) and the session token", () => {
    const r = presignV4({
      method: "PUT",
      host: "bucket.example.test",
      canonicalPath: "/0b0c9a46-6b3e-4f61-8a5b-1b8f0b5f0c11",
      query: { partNumber: "3", uploadId: "abc+/=" },
      region: "auto",
      credentials: { ...creds, sessionToken: "tok/en" },
      now: new Date("2026-11-01T10:00:00Z"),
      expiresSec: 900,
    });
    assert.match(r.queryString, /(^|&)partNumber=3(&|$)/);
    assert.match(r.queryString, /uploadId=abc%2B%2F%3D/);
    assert.match(r.queryString, /X-Amz-Security-Token=tok%2Fen/);
    assert.match(r.queryString, /X-Amz-Expires=900/);
    assert.match(r.queryString, /X-Amz-Date=20261101T100000Z/);
    // Changing anything signed changes the signature.
    const r2 = presignV4({ method: "PUT", host: "bucket.example.test", canonicalPath: "/0b0c9a46-6b3e-4f61-8a5b-1b8f0b5f0c11", query: { partNumber: "4", uploadId: "abc+/=" }, region: "auto", credentials: { ...creds, sessionToken: "tok/en" }, now: new Date("2026-11-01T10:00:00Z"), expiresSec: 900 });
    assert.notEqual(r.signature, r2.signature);
  });

  it("refuses an expiry beyond 7 days or below 1 second", () => {
    const base = { method: "GET", host: "h", canonicalPath: "/k", query: {}, region: "r", credentials: creds, now: new Date() };
    assert.throws(() => presignV4({ ...base, expiresSec: 604801 }), /expir/i);
    assert.throws(() => presignV4({ ...base, expiresSec: 0 }), /expir/i);
  });
});
