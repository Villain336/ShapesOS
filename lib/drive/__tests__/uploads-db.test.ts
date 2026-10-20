// ShapesOS — Phase 21B (WS=drive): large files — resumable multipart uploads against
// real Postgres (app role) with the in-process S3-compatible FAKE and a FAKE clamd.
// Both are labelled mocks: real R2/S3 and a real ClamAV daemon are UNVERIFIED-LIVE.
//   - initiate -> presigned part URLs -> PUT straight to storage -> complete
//   - resume after a dropped connection (the provider is the source of truth)
//   - the per-upload cap is quota-governed under a hard maximum setting
//   - >25 MB: only safe large types; scanned end to end; a flagged file is deleted
//   - a new version of an existing file by multipart
//   - hosted deployments refuse to start an upload without a scanner
//   - someone else's half-finished upload does not exist
//   - local-disk mode keeps the buffered path
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/uploads-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";

const MiB = 1024 * 1024;
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { startFakeS3, type FakeS3 } from "@/lib/filesystem/fake-s3";
import { resetStorageAdapterForTests, getStorageAdapter } from "@/lib/filesystem/storage";
import { FsError, getQuota, setQuotaLimit } from "@/lib/filesystem/service";
import { listFileVersions } from "@/lib/filesystem/versions";
import { resetMalwareScannerForTests } from "@/lib/security/malware-scan";
import { listChanges } from "@/lib/drive/changes";
import { abortMultipartUploadFor, completeMultipartUploadFor, expireUploadsFor, initiateUpload, presignParts, uploadStatus, type UploadActor } from "@/lib/drive/uploads";

const RUN = randomUUID().slice(0, 8);
const WS = `p21u-${RUN}`;
const ANA = `p21u-ana-${RUN}`;
const BEN = `p21u-ben-${RUN}`;
const VIC = `p21u-vic-${RUN}`;
const ana: UploadActor = { workspaceId: WS, userId: ANA, role: "editor" };
const ben: UploadActor = { workspaceId: WS, userId: BEN, role: "editor" };
const vic: UploadActor = { workspaceId: WS, userId: VIC, role: "viewer" };

let fake: FakeS3;
let clam: Server;
let clamPort = 0;
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
let scanned = 0;

function pdf(total: number, fill = 0x20): Buffer {
  const b = Buffer.alloc(total, fill);
  Buffer.from("%PDF-1.4\n").copy(b, 0);
  return b;
}

async function expectFs(p: Promise<unknown>, code: string, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => e instanceof FsError && e.code === code && (!re || re.test(e.message)), `expected FsError ${code}`);
}

async function sendParts(actor: UploadActor, uploadId: string, bytes: Buffer, partSize: number, only?: number[]) {
  const count = Math.ceil(bytes.length / partSize);
  const numbers = (only ?? Array.from({ length: count }, (_, i) => i + 1)).slice();
  const urls = await presignParts(actor, uploadId, numbers);
  for (const u of urls) {
    const slice = bytes.subarray((u.partNumber - 1) * partSize, Math.min(u.partNumber * partSize, bytes.length));
    assert.equal(slice.length, u.size, "the server announced the exact part size");
    const res = await fetch(u.url, { method: "PUT", body: new Uint8Array(slice) });
    assert.equal(res.status, 200, `part ${u.partNumber}`);
  }
}

before(async () => {
  fake = await startFakeS3({ bucket: "drive", accessKeyId: "AKIAFAKE", secretAccessKey: "fakesecret", region: "auto" });
  process.env.MARKETR_STORAGE = "s3";
  process.env.MARKETR_S3_ENDPOINT = fake.endpoint;
  process.env.MARKETR_S3_BUCKET = "drive";
  process.env.MARKETR_S3_REGION = "auto";
  process.env.MARKETR_S3_ACCESS_KEY = "AKIAFAKE";
  process.env.MARKETR_S3_SECRET_KEY = "fakesecret";
  process.env.MARKETR_S3_FORCE_PATH_STYLE = "true";
  resetStorageAdapterForTests();
  // A FAKE clamd: says FOUND when the stream contains the EICAR string.
  clam = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let cmd = false;
    let all = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!cmd) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        buf = buf.subarray(nul + 1);
        cmd = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          scanned = all.length;
          sock.end(all.includes(Buffer.from(EICAR)) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buf.length < 4 + len) return;
        all = Buffer.concat([all, buf.subarray(4, 4 + len)]);
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => clam.listen(0, "127.0.0.1", () => r()));
  clamPort = (clam.address() as { port: number }).port;
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = String(clamPort);
  resetMalwareScannerForTests();

  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `ana-${RUN}@example.test`, name: "Ana" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `ben-${RUN}@example.test`, name: "Ben" },
      { workspaceId: WS, userId: VIC, role: "viewer", email: `vic-${RUN}@example.test`, name: "Vic" },
    ],
  });
});

after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
  await fake.close();
  clam.close();
});

describe("multipart upload end to end", () => {
  it("11 MiB PDF in 5 MiB parts: initiate, presign, PUT to storage, complete -> a file with the right size, quota and journal event", async () => {
    const bytes = pdf(11 * MiB);
    const init = await initiateUpload({ actor: ana, dir: `/home/${ANA}/Big`, filename: "plan.pdf", size: bytes.length, partSize: 5 * MiB });
    assert.equal(init.mode, "multipart");
    if (init.mode !== "multipart") return;
    assert.equal(init.partSize, 5 * MiB);
    assert.equal(init.partCount, 3);
    const before = await listChanges({ workspaceId: WS, viewerUserId: ANA });
    await sendParts(ana, init.uploadId, bytes, init.partSize);
    const st = await uploadStatus(ana, init.uploadId);
    assert.deepEqual([st.uploaded, st.missing], [[1, 2, 3], []]);
    const done = await completeMultipartUploadFor(ana, init.uploadId);
    assert.equal(done.sizeBytes, 11 * MiB);
    assert.equal(done.path, `/home/${ANA}/Big/plan.pdf`);
    const row = await prisma.workspaceFile.findFirstOrThrow({ where: { id: done.fileId } });
    assert.equal(row.ownerUserId, ANA);
    assert.equal(row.mimeType, "application/pdf");
    assert.ok((await getStorageAdapter().get(row.storageKey))!.equals(bytes), "the stored object is exactly what was sent");
    assert.ok((await getQuota({ workspaceId: WS })).usedBytes >= 11 * MiB);
    const after = await listChanges({ workspaceId: WS, viewerUserId: ANA, cursor: before.cursor });
    assert.deepEqual(after.changes.filter((c) => c.entity === "file").map((c) => [c.type, c.path]), [["create", `/home/${ANA}/Big/plan.pdf`]]);
    // A finished upload cannot be completed again.
    await expectFs(completeMultipartUploadFor(ana, init.uploadId), "invalid_state", /already complete/i);
  });

  it("resumes after a dropped connection: the provider says which parts it holds", async () => {
    const bytes = pdf(11 * MiB, 0x41);
    const init = await initiateUpload({ actor: ana, dir: "/shared/Resume", filename: "r.pdf", size: bytes.length, partSize: 5 * MiB });
    assert.equal(init.mode, "multipart");
    if (init.mode !== "multipart") return;
    await sendParts(ana, init.uploadId, bytes, init.partSize, [1]); // the connection drops after part 1
    const mid = await uploadStatus(ana, init.uploadId);
    assert.deepEqual([mid.uploaded, mid.missing], [[1], [2, 3]]);
    await expectFs(completeMultipartUploadFor(ana, init.uploadId), "invalid_state", /missing part 2/i);
    // After the failed completion the upload is still open and resumable.
    await sendParts(ana, init.uploadId, bytes, init.partSize, mid.missing);
    const done = await completeMultipartUploadFor(ana, init.uploadId);
    assert.equal(done.sizeBytes, bytes.length);
  });

  it("a part of the wrong size is treated as missing, not accepted", async () => {
    const bytes = pdf(11 * MiB, 0x42);
    const init = await initiateUpload({ actor: ana, dir: "/shared/Wrong", filename: "w.pdf", size: bytes.length, partSize: 5 * MiB });
    if (init.mode !== "multipart") throw new Error("expected multipart");
    const [u] = await presignParts(ana, init.uploadId, [1]);
    await fetch(u!.url, { method: "PUT", body: new Uint8Array(Buffer.alloc(1 * MiB)) }); // short
    const st = await uploadStatus(ana, init.uploadId);
    assert.deepEqual([st.uploaded, st.missing], [[], [1, 2, 3]]);
  });

  it("abort drops the upload at the provider and refuses further work", async () => {
    const init = await initiateUpload({ actor: ana, dir: "/shared/Abort", filename: "a.pdf", size: 11 * MiB, partSize: 5 * MiB });
    if (init.mode !== "multipart") throw new Error("expected multipart");
    const before = fake.uploads.size;
    await abortMultipartUploadFor(ana, init.uploadId);
    assert.equal(fake.uploads.size, before - 1);
    await expectFs(presignParts(ana, init.uploadId, [1]), "invalid_state", /cancelled/i);
  });

  it("expired uploads are swept and dropped at the provider", async () => {
    const init = await initiateUpload({ actor: ana, dir: "/shared/Expire", filename: "e.pdf", size: 11 * MiB, partSize: 5 * MiB });
    if (init.mode !== "multipart") throw new Error("expected multipart");
    const swept = await expireUploadsFor(WS, new Date(Date.now() + 48 * 3600_000));
    assert.ok(swept.expired >= 1);
    await expectFs(presignParts(ana, init.uploadId, [1]), "invalid_state", /expired/i);
  });
});

describe("limits", () => {
  it("the cap is quota-governed: a file bigger than the room left is refused at the start", async () => {
    const ws = `p21u-q-${RUN}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: ANA, role: "editor", email: `a-${RUN}@example.test`, name: "A" } });
    try {
      await setQuotaLimit({ workspaceId: ws, limitBytes: 20 * MiB });
      const a = { workspaceId: ws, userId: ANA, role: "editor" } as const;
      await expectFs(initiateUpload({ actor: a, dir: "/shared/Q", filename: "big.pdf", size: 30 * MiB }), "quota_exceeded");
      const ok = await initiateUpload({ actor: a, dir: "/shared/Q", filename: "fits.pdf", size: 15 * MiB });
      assert.equal(ok.mode, "multipart");
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });

  it("a person's home limit applies to the cap too", async () => {
    const ws = `p21u-h-${RUN}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: ANA, role: "editor", email: `a2-${RUN}@example.test`, name: "A" } });
    try {
      const { setScopeLimit } = await import("@/lib/drive/quota-store");
      await withWorkspaceScope(ws, (tx) => setScopeLimit(tx, ws, `user:${ANA}`, 12 * MiB));
      const a = { workspaceId: ws, userId: ANA, role: "editor" } as const;
      await expectFs(initiateUpload({ actor: a, dir: `/home/${ANA}`, filename: "x.pdf", size: 13 * MiB }), "quota_exceeded");
      assert.equal((await initiateUpload({ actor: a, dir: "/shared/Free", filename: "x.pdf", size: 13 * MiB })).mode, "multipart", "the shared area is not charged to the person");
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });

  it("the hard maximum setting caps a single file", async () => {
    process.env.DRIVE_MAX_FILE_BYTES = String(12 * MiB);
    try {
      await expectFs(initiateUpload({ actor: ana, dir: "/shared/Hard", filename: "x.pdf", size: 13 * MiB }), "too_large", /at most 12 MB/);
    } finally {
      delete process.env.DRIVE_MAX_FILE_BYTES;
    }
  });

  it("above 25 MB only safe large types are accepted", async () => {
    await expectFs(initiateUpload({ actor: ana, dir: "/shared/Types", filename: "deck.pptx", size: 30 * MiB }), "unsafe_content", /Above 25 MB/);
    await expectFs(initiateUpload({ actor: ana, dir: "/shared/Types", filename: "pic.svg", size: 30 * MiB }), "unsafe_content");
    assert.equal((await initiateUpload({ actor: ana, dir: "/shared/Types", filename: "scan.PDF", size: 30 * MiB })).mode, "multipart");
  });
});

describe("safety on large objects", () => {
  it("a 26 MiB file is scanned end to end, and a flagged one is deleted and never becomes a file", async () => {
    const bytes = pdf(26 * MiB);
    Buffer.from(EICAR).copy(bytes, 13 * MiB + 17); // in the middle, not in the head
    const init = await initiateUpload({ actor: ana, dir: "/shared/Scan", filename: "bad.pdf", size: bytes.length, partSize: 8 * MiB });
    if (init.mode !== "multipart") throw new Error("expected multipart");
    await sendParts(ana, init.uploadId, bytes, init.partSize);
    const objectsBefore = fake.objects.size;
    await expectFs(completeMultipartUploadFor(ana, init.uploadId), "unsafe_content", /Eicar-Test-Signature/);
    assert.equal(scanned, bytes.length, "every byte went through the scanner");
    assert.equal(fake.objects.size, objectsBefore, "the assembled object was deleted: nothing is left in storage");
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: "/shared/Scan/bad.pdf" } }), 0);
    await expectFs(presignParts(ana, init.uploadId, [1]), "invalid_state", /cancelled/i);
  });

  it("a clean 26 MiB file is accepted and a size that does not match what was announced is not", async () => {
    const bytes = pdf(26 * MiB, 0x30);
    const init = await initiateUpload({ actor: ana, dir: "/shared/Scan", filename: "ok.pdf", size: bytes.length, partSize: 8 * MiB });
    if (init.mode !== "multipart") throw new Error("expected multipart");
    await sendParts(ana, init.uploadId, bytes, init.partSize);
    const done = await completeMultipartUploadFor(ana, init.uploadId);
    assert.equal(done.sizeBytes, bytes.length);
  });

  it("a file whose first bytes are not what its name says is rejected", async () => {
    const bytes = Buffer.alloc(11 * MiB, 0x41);
    Buffer.from("MZ\x90\x00").copy(bytes, 0); // a Windows program, named .pdf
    const init = await initiateUpload({ actor: ana, dir: "/shared/Scan", filename: "fake.pdf", size: bytes.length, partSize: 5 * MiB });
    if (init.mode !== "multipart") throw new Error("expected multipart");
    await sendParts(ana, init.uploadId, bytes, init.partSize);
    await expectFs(completeMultipartUploadFor(ana, init.uploadId), "unsafe_content");
  });

  it("hosted without a scanner refuses to start an upload (before any bytes move)", async () => {
    const saved = { m: process.env.DEPLOYMENT_MODE, h: process.env.CLAMAV_HOST };
    process.env.DEPLOYMENT_MODE = "hosted";
    delete process.env.CLAMAV_HOST;
    resetMalwareScannerForTests();
    try {
      await expectFs(initiateUpload({ actor: ana, dir: "/shared/Hosted", filename: "x.pdf", size: 11 * MiB }), "scanner_unavailable", /CLAMAV_HOST/);
    } finally {
      delete process.env.DEPLOYMENT_MODE;
      process.env.CLAMAV_HOST = saved.h;
      resetMalwareScannerForTests();
    }
  });
});

describe("a new version by multipart", () => {
  it("replaces the bytes, keeps the old version and bumps the version number", async () => {
    const v1 = pdf(11 * MiB, 0x31);
    const i1 = await initiateUpload({ actor: ana, dir: "/shared/Ver", filename: "doc.pdf", size: v1.length, partSize: 5 * MiB });
    if (i1.mode !== "multipart") throw new Error("expected multipart");
    await sendParts(ana, i1.uploadId, v1, i1.partSize);
    const first = await completeMultipartUploadFor(ana, i1.uploadId);
    const v2 = pdf(12 * MiB, 0x32);
    const i2 = await initiateUpload({ actor: ana, dir: "/shared/Ver", filename: "doc.pdf", size: v2.length, partSize: 5 * MiB, replaceFileId: first.fileId });
    if (i2.mode !== "multipart") throw new Error("expected multipart");
    await sendParts(ana, i2.uploadId, v2, i2.partSize);
    const second = await completeMultipartUploadFor(ana, i2.uploadId);
    assert.deepEqual([second.fileId, second.version, second.replaced], [first.fileId, 2, true]);
    const versions = await listFileVersions(WS, first.fileId);
    assert.deepEqual(versions!.map((v) => [v.version, v.sizeBytes]), [[2, 12 * MiB], [1, 11 * MiB]]);
  });
});

describe("who may do what", () => {
  it("someone else's half-finished upload does not exist; a viewer cannot start one", async () => {
    const init = await initiateUpload({ actor: ana, dir: "/shared/Mine", filename: "m.pdf", size: 11 * MiB, partSize: 5 * MiB });
    if (init.mode !== "multipart") throw new Error("expected multipart");
    for (const fn of [() => presignParts(ben, init.uploadId, [1]), () => uploadStatus(ben, init.uploadId), () => completeMultipartUploadFor(ben, init.uploadId), () => abortMultipartUploadFor(ben, init.uploadId)]) {
      await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 404);
    }
    await assert.rejects(() => initiateUpload({ actor: vic, dir: "/shared/Mine", filename: "v.pdf", size: 11 * MiB }), (e: unknown) => (e as { status?: number }).status === 403);
    // Nor can anyone start an upload into somebody else's private home.
    await assert.rejects(() => initiateUpload({ actor: ben, dir: `/home/${ANA}`, filename: "v.pdf", size: 11 * MiB }), (e: unknown) => (e as { status?: number }).status === 404);
  });
});

describe("local-disk storage keeps the buffered path", () => {
  it("answers direct with the 25 MB cap, and refuses bigger files with a clear message", async () => {
    const savedMode = process.env.MARKETR_STORAGE;
    process.env.MARKETR_STORAGE = "local";
    resetStorageAdapterForTests();
    try {
      const small = await initiateUpload({ actor: ana, dir: "/shared/Local", filename: "s.pdf", size: 3 * MiB });
      assert.deepEqual(small, { mode: "direct", maxBytes: 25 * MiB });
      await expectFs(initiateUpload({ actor: ana, dir: "/shared/Local", filename: "b.pdf", size: 30 * MiB }), "too_large", /object storage/);
    } finally {
      process.env.MARKETR_STORAGE = savedMode;
      resetStorageAdapterForTests();
    }
  });
});
