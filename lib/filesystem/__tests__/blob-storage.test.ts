// Deploy PR (WS=state): the shared blob layer in lib/filesystem/storage.ts.
// SigV4 against the AWS documentation vectors, key validation, namespace
// mapping, refs + legacy paths, the local backend, and the S3 backend
// against the in-process S3-compatible FAKE (lib/filesystem/fake-s3.ts —
// a labelled fake that verifies every signature).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBlobPath,
  assertBlobPrefix,
  assertKeyShape,
  awsCredentialChain,
  blobDelete,
  blobDeletePrefix,
  blobGet,
  blobGetFirst,
  blobHead,
  blobList,
  blobPath,
  blobPut,
  blobRef,
  BlobKeyError,
  decodeBlobSegment,
  deleteStoredRef,
  encodeBlobSegment,
  headStoredRef,
  isBlobRef,
  LocalBlobBackend,
  localBlobDir,
  parseBlobRef,
  parseListObjectsV2,
  readStoredRef,
  resetStorageAdapterForTests,
  resolveStoredRef,
  rfc3986,
  S3BlobBackend,
  S3CompatibleAdapter,
  s3CanonicalPath,
  s3CanonicalQuery,
  s3ConfigFromEnv,
  setBlobBackendForTests,
  sha256Hex,
  signV4,
  storageDeploymentWarning,
  storageMode,
  type BlobNamespace,
} from "../storage";
import { startFakeS3 } from "../fake-s3";

// ---------------------------------------------------------------------------
// SigV4 — the four header-based examples in the AWS S3 documentation
// ("Examples: Signature calculations in AWS Signature Version 4",
// sig-v4-header-based-auth). Same credentials, date and bucket for all.
// ---------------------------------------------------------------------------

const AWS_EXAMPLE = {
  credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  region: "us-east-1",
  host: "examplebucket.s3.amazonaws.com",
  now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
};
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("SigV4: AWS example GET Object (Range header) matches the documented signature", () => {
  const s = signV4({
    ...AWS_EXAMPLE,
    method: "GET",
    canonicalPath: s3CanonicalPath("/test.txt"),
    canonicalQuery: "",
    headers: { range: "bytes=0-9" },
    payloadHash: EMPTY_SHA,
  });
  assert.equal(
    s.canonicalRequest,
    [
      "GET",
      "/test.txt",
      "",
      "host:examplebucket.s3.amazonaws.com",
      "range:bytes=0-9",
      `x-amz-content-sha256:${EMPTY_SHA}`,
      "x-amz-date:20130524T000000Z",
      "",
      "host;range;x-amz-content-sha256;x-amz-date",
      EMPTY_SHA,
    ].join("\n"),
  );
  assert.equal(
    s.stringToSign,
    "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
  );
  assert.equal(s.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(
    s.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("SigV4: AWS example PUT Object (encoded key, extra headers, body hash)", () => {
  const body = Buffer.from("Welcome to Amazon S3.");
  assert.equal(sha256Hex(body), "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const s = signV4({
    ...AWS_EXAMPLE,
    method: "PUT",
    canonicalPath: s3CanonicalPath("/test$file.text"),
    canonicalQuery: "",
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    payloadHash: sha256Hex(body),
  });
  assert.match(s.canonicalRequest, /^PUT\n\/test%24file\.text\n/);
  assert.equal(s.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("SigV4: AWS example GET Bucket Lifecycle (valueless sub-resource)", () => {
  const s = signV4({
    ...AWS_EXAMPLE,
    method: "GET",
    canonicalPath: "/",
    canonicalQuery: s3CanonicalQuery({ lifecycle: "" }),
    payloadHash: EMPTY_SHA,
  });
  assert.equal(s.signature, "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
});

test("SigV4: AWS example LIST objects (sorted, encoded query) — the LIST signing path", () => {
  const query = s3CanonicalQuery({ prefix: "J", "max-keys": "2" });
  assert.equal(query, "max-keys=2&prefix=J");
  const s = signV4({ ...AWS_EXAMPLE, method: "GET", canonicalPath: "/", canonicalQuery: query, payloadHash: EMPTY_SHA });
  assert.equal(s.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("SigV4: a session token is signed; RFC 3986 encoding of query values", () => {
  const s = signV4({
    ...AWS_EXAMPLE,
    credentials: { ...AWS_EXAMPLE.credentials, sessionToken: "TOKEN/+=" },
    method: "GET",
    canonicalPath: "/",
    canonicalQuery: s3CanonicalQuery({ prefix: "blobs/sites/a b/", "list-type": "2", delimiter: "/" }),
    payloadHash: EMPTY_SHA,
  });
  assert.equal(s.headers["x-amz-security-token"], "TOKEN/+=");
  assert.match(s.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  assert.match(s.canonicalRequest, /\ndelimiter=%2F&list-type=2&prefix=blobs%2Fsites%2Fa%20b%2F\n/);
  assert.equal(rfc3986("a!'()*"), "a%21%27%28%29%2A");
});

// ---------------------------------------------------------------------------
// Key validation and namespaces
// ---------------------------------------------------------------------------

test("blob paths: dot segments, absolute paths, bad characters and empty segments are refused", () => {
  for (const bad of ["", "/a", "a/", "../x", "a/../b", "a/./b", "a//b", "a\\b", "a b", "a/%2e%2e", "ü.pdf", "a?b", "a#b", "x".repeat(1025)]) {
    assert.throws(() => assertBlobPath(bad), BlobKeyError, bad);
  }
  for (const good of ["a.pdf", "ws_1/run-2/video.webm", "~YWJj", ".gitignore", "a.b.c/d-e_f~g"]) {
    assert.equal(assertBlobPath(good), good);
  }
  assert.throws(() => assertBlobPath(".blobtmp-1234"), BlobKeyError, "reserved temp prefix");
  assert.equal(assertBlobPrefix(""), "");
  assert.equal(assertBlobPrefix("ws/run/"), "ws/run/");
  assert.throws(() => assertBlobPrefix("ws/run"), BlobKeyError);
  assert.throws(() => assertBlobPrefix("../"), BlobKeyError);
  assert.throws(() => blobPath("ws", "..", "x"), BlobKeyError);
  assert.equal(blobPath("ws", "r", "x.pdf"), "ws/r/x.pdf");
  // The UUID API is untouched: it still refuses anything but a UUID.
  assert.throws(() => assertKeyShape("blobs/reports/x.pdf"));
});

test("segment encoding is reversible and always lands in the safe charset", () => {
  for (const name of ["index.html", "My Photo (1).png", "über.txt", "a/b", "..", ".", "~tilde", "x".repeat(150)]) {
    const enc = encodeBlobSegment(name);
    assert.doesNotThrow(() => assertBlobPath(enc), name);
    assert.equal(decodeBlobSegment(enc), name);
  }
  assert.equal(encodeBlobSegment("index.html"), "index.html");
  assert.ok(encodeBlobSegment("a b").startsWith("~"));
});

test("refs: blob:<namespace>/<path> round-trips; foreign namespaces and bad paths do not parse", () => {
  const ref = blobRef("reports", "ws1/r.pdf");
  assert.equal(ref, "blob:reports/ws1/r.pdf");
  assert.ok(isBlobRef(ref));
  assert.deepEqual(parseBlobRef(ref), { namespace: "reports", path: "ws1/r.pdf" });
  assert.equal(parseBlobRef("blob:nope/x"), null);
  assert.equal(parseBlobRef("blob:reports/../x"), null);
  assert.equal(parseBlobRef(".data/reports/x.pdf"), null);
  assert.throws(() => blobRef("nope" as BlobNamespace, "x"), BlobKeyError);
});

test("namespaces map onto the historic local directories (and their env overrides)", () => {
  const saved = { ...process.env };
  try {
    delete process.env.REPORT_STORAGE_DIR;
    delete process.env.SITE_STORAGE_DIR;
    assert.equal(localBlobDir("reports"), join(process.cwd(), ".data", "reports"));
    assert.equal(localBlobDir("logos"), join(process.cwd(), ".data", "reports", "logos"));
    assert.equal(localBlobDir("run-recordings"), join(process.cwd(), ".run-artifacts"));
    assert.equal(localBlobDir("sites"), join(process.cwd(), ".data", "sites"));
    process.env.REPORT_STORAGE_DIR = "/srv/reports";
    process.env.SITE_STORAGE_DIR = "/srv/sites";
    assert.equal(localBlobDir("reports"), "/srv/reports");
    assert.equal(localBlobDir("logos"), "/srv/reports/logos");
    assert.equal(localBlobDir("sites"), "/srv/sites");
  } finally {
    process.env = saved;
  }
});

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

test("storage mode: local by default, s3 on request, anything else refused", () => {
  assert.equal(storageMode(env({})), "local");
  assert.equal(storageMode(env({ MARKETR_STORAGE: " S3 " })), "s3");
  assert.throws(() => storageMode(env({ MARKETR_STORAGE: "nfs" })), /Unknown MARKETR_STORAGE/);
});

test("boot check: hosted needs shared storage; s3 needs complete settings", () => {
  assert.equal(storageDeploymentWarning(env({})), null, "a single box on local disk is fine");
  assert.match(storageDeploymentWarning(env({ DEPLOYMENT_MODE: "hosted" })) ?? "", /invisible to the others/);
  assert.match(storageDeploymentWarning(env({ DEPLOYMENT_MODE: "hosted", MARKETR_STORAGE: "s3" })) ?? "", /incomplete/);
  assert.equal(
    storageDeploymentWarning(env({ DEPLOYMENT_MODE: "hosted", MARKETR_STORAGE: "s3", MARKETR_S3_ENDPOINT: "https://r2", MARKETR_S3_BUCKET: "b", MARKETR_S3_ACCESS_KEY: "k", MARKETR_S3_SECRET_KEY: "s" })),
    null,
  );
});

test("S3 config: static keys, else the AWS chain (env keys or ECS endpoint), else null", async () => {
  const base = { MARKETR_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", MARKETR_S3_BUCKET: "shapesos-files" };
  assert.equal(s3ConfigFromEnv(env({ ...base })), null, "no credentials → fail closed");
  assert.equal(s3ConfigFromEnv(env({ MARKETR_S3_BUCKET: "b", MARKETR_S3_ACCESS_KEY: "k", MARKETR_S3_SECRET_KEY: "s" })), null, "no endpoint");
  const stat = s3ConfigFromEnv(env({ ...base, MARKETR_S3_ACCESS_KEY: "k", MARKETR_S3_SECRET_KEY: "s" }))!;
  assert.equal(stat.endpoint, "https://acct.r2.cloudflarestorage.com");
  assert.equal(stat.accessKey, "k");
  assert.equal(stat.forcePathStyle, true);
  const viaEnv = s3ConfigFromEnv(env({ ...base, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_SESSION_TOKEN: "T" }))!;
  assert.equal(viaEnv.accessKey, "");
  assert.deepEqual(await viaEnv.credentials!(), { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "T" });

  // ECS task role: fetched once, cached until 5 min before expiry.
  let calls = 0;
  let now = Date.parse("2026-10-05T00:00:00Z");
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls++;
    assert.equal(url, "http://169.254.170.2/v2/credentials/abc");
    assert.equal((init?.headers as Record<string, string>).authorization, "tok");
    return new Response(JSON.stringify({ AccessKeyId: "ASIA1", SecretAccessKey: "sec", Token: "sess", Expiration: "2026-10-05T01:00:00Z" }));
  }) as unknown as typeof fetch;
  const chain = awsCredentialChain(
    env({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc", AWS_CONTAINER_AUTHORIZATION_TOKEN: "tok" }),
    fakeFetch,
    () => now,
  )!;
  const a = await chain();
  assert.equal(a.accessKeyId, "ASIA1");
  assert.equal(a.sessionToken, "sess");
  await chain();
  assert.equal(calls, 1, "cached");
  now = Date.parse("2026-10-05T00:56:00Z");
  await chain();
  assert.equal(calls, 2, "refreshed inside the 5-minute window");
  assert.equal(awsCredentialChain(env({})), null);
});

test("ListObjectsV2 parser: contents, common prefixes, entities, continuation", () => {
  const xml =
    `<ListBucketResult><Contents><Key>blobs/sites/a&amp;b.txt</Key><LastModified>2026-10-05T00:00:00.000Z</LastModified><Size>12</Size></Contents>` +
    `<CommonPrefixes><Prefix>blobs/sites/dir/</Prefix></CommonPrefixes><IsTruncated>true</IsTruncated>` +
    `<NextContinuationToken>tok&lt;1&gt;</NextContinuationToken></ListBucketResult>`;
  const p = parseListObjectsV2(xml);
  assert.deepEqual(p.objects.map((o) => [o.key, o.size]), [["blobs/sites/a&b.txt", 12]]);
  assert.deepEqual(p.prefixes, ["blobs/sites/dir/"]);
  assert.equal(p.nextToken, "tok<1>");
  assert.equal(parseListObjectsV2("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").nextToken, null);
});

// ---------------------------------------------------------------------------
// Backends — the same contract against local disk and the S3 fake
// ---------------------------------------------------------------------------

async function contract(label: string, setup: () => Promise<{ teardown: () => Promise<void> }>) {
  test(`blob contract (${label}): put/get/range/head/list/delete/deletePrefix`, async () => {
    const { teardown } = await setup();
    try {
      const ref = await blobPut("reports", "ws1/r1.pdf", Buffer.from("%PDF-1.7 hello"), "application/pdf");
      assert.equal(ref, "blob:reports/ws1/r1.pdf");
      assert.equal((await blobGet("reports", "ws1/r1.pdf"))!.toString(), "%PDF-1.7 hello");
      assert.equal((await blobGet("reports", "ws1/r1.pdf", { start: 2, end: 4 }))!.toString(), "DF-");
      const head = await blobHead("reports", "ws1/r1.pdf");
      assert.equal(head!.size, 14);
      assert.equal(await blobGet("reports", "ws1/missing.pdf"), null);
      assert.equal(await blobHead("reports", "ws1/missing.pdf"), null);
      assert.equal((await blobGetFirst("reports", ["ws1/missing.pdf", "ws1/r1.pdf"]))!.toString(), "%PDF-1.7 hello");

      await blobPut("sites", "s1/working/index.html", "<h1>hi</h1>");
      await blobPut("sites", "s1/working/css/a.css", "a{}");
      await blobPut("sites", "s1/working/css/deep/b.css", "b{}");
      await blobPut("sites", "s2/working/index.html", "other");
      const flat = await blobList("sites", "s1/working/");
      assert.deepEqual(flat.objects.map((o) => o.path), ["s1/working/css/a.css", "s1/working/css/deep/b.css", "s1/working/index.html"]);
      const shallow = await blobList("sites", "s1/working/", { delimiter: "/" });
      assert.deepEqual(shallow.objects.map((o) => o.path), ["s1/working/index.html"]);
      assert.deepEqual(shallow.prefixes, ["s1/working/css/"]);
      assert.equal(shallow.objects[0]!.size, 11);

      // Namespaces are isolated from each other.
      assert.equal(await blobGet("logos", "ws1/r1.pdf"), null);

      assert.equal(await blobDeletePrefix("sites", "s1/"), 3);
      assert.deepEqual((await blobList("sites", "s1/")).objects, []);
      assert.equal((await blobList("sites", "s2/")).objects.length, 1);
      await blobDelete("reports", "ws1/r1.pdf");
      await blobDelete("reports", "ws1/r1.pdf"); // missing is fine
      assert.equal(await blobGet("reports", "ws1/r1.pdf"), null);
      await assert.rejects(() => blobDeletePrefix("sites", ""), BlobKeyError);
      await assert.rejects(() => blobPut("reports", "../escape.pdf", "x"), BlobKeyError);
    } finally {
      await teardown();
    }
  });
}

void contract("local disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-local-"));
  setBlobBackendForTests(new LocalBlobBackend((ns) => join(root, ns)));
  return {
    teardown: async () => {
      setBlobBackendForTests(null);
      await rm(root, { recursive: true, force: true });
    },
  };
});

void contract("S3 fake (signature-checked)", async () => {
  const fake = await startFakeS3({ bucket: "shapes", accessKeyId: "AK", secretAccessKey: "SK", maxKeys: 2 });
  const s3 = new S3CompatibleAdapter({ endpoint: fake.endpoint, region: "us-east-1", bucket: "shapes", accessKey: "AK", secretKey: "SK", forcePathStyle: true });
  setBlobBackendForTests(new S3BlobBackend(s3));
  return {
    teardown: async () => {
      setBlobBackendForTests(null);
      assert.ok(fake.requests.length > 10);
      assert.ok(fake.requests.every((r) => r.signed), "every request carried a valid signature");
      assert.ok([...fake.objects.keys()].every((k) => k.startsWith("blobs/")), "namespaced under blobs/");
      await fake.close();
    },
  };
});

test("S3 fake rejects a wrong secret (the signature check is real)", async () => {
  const fake = await startFakeS3({ bucket: "shapes", accessKeyId: "AK", secretAccessKey: "SK" });
  try {
    const bad = new S3BlobBackend(
      new S3CompatibleAdapter({ endpoint: fake.endpoint, region: "us-east-1", bucket: "shapes", accessKey: "AK", secretKey: "WRONG", forcePathStyle: true }),
    );
    await assert.rejects(() => bad.put("system", "x.txt", Buffer.from("x"), "text/plain"), /S3 PUT failed \(403\)/);
    // The UUID API shares the same client and signer.
    const ok = new S3CompatibleAdapter({ endpoint: fake.endpoint, region: "us-east-1", bucket: "shapes", accessKey: "AK", secretKey: "SK", forcePathStyle: true });
    const key = "0b3a1c6e-2f4d-4e5a-9b8c-7d6e5f4a3b2c";
    await ok.put(key, Buffer.from("uuid bytes"), "text/plain");
    assert.equal((await ok.get(key))!.toString(), "uuid bytes");
    assert.equal(await ok.exists(key), true);
    assert.ok(fake.objects.has(key), "UUID keys stay at the bucket root (unchanged layout)");
    await ok.delete(key);
    assert.equal(await ok.exists(key), false);
  } finally {
    await fake.close();
  }
});

test("stored refs: blob refs of the right namespace, legacy paths confined to the namespace dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-legacy-"));
  const saved = process.env.REPORT_STORAGE_DIR;
  process.env.REPORT_STORAGE_DIR = join(root, "reports");
  setBlobBackendForTests(new LocalBlobBackend((ns) => (ns === "reports" ? join(root, "reports") : join(root, ns))));
  try {
    await mkdir(join(root, "reports"), { recursive: true });
    await writeFile(join(root, "reports", "old.pdf"), "legacy bytes");
    await writeFile(join(root, "outside.pdf"), "secret");
    // Legacy absolute path inside the namespace dir: served.
    assert.equal((await readStoredRef(join(root, "reports", "old.pdf"), "reports"))!.toString(), "legacy bytes");
    assert.equal((await headStoredRef(join(root, "reports", "old.pdf"), "reports"))!.size, 12);
    // Escapes and foreign namespaces: refused.
    assert.equal(resolveStoredRef(join(root, "outside.pdf"), "reports"), null);
    assert.equal(resolveStoredRef(join(root, "reports", "..", "outside.pdf"), "reports"), null);
    assert.equal(await readStoredRef("blob:logos/x.png", "reports"), null);
    // New refs.
    const ref = await blobPut("reports", "ws/new.pdf", "new bytes");
    assert.equal((await readStoredRef(ref, "reports"))!.toString(), "new bytes");
    assert.equal((await readStoredRef(ref, "reports", { range: { start: 4, end: 8 } }))!.toString(), "bytes");
    assert.equal(await deleteStoredRef(ref, "reports"), true);
    assert.equal(await readStoredRef(ref, "reports"), null);
    assert.equal(await deleteStoredRef(join(root, "reports", "old.pdf"), "reports"), true);
    await assert.rejects(() => readFile(join(root, "reports", "old.pdf")));
    assert.equal(await readStoredRef(null, "reports"), null);
  } finally {
    if (saved === undefined) delete process.env.REPORT_STORAGE_DIR;
    else process.env.REPORT_STORAGE_DIR = saved;
    setBlobBackendForTests(null);
    resetStorageAdapterForTests();
    await rm(root, { recursive: true, force: true });
  }
});
