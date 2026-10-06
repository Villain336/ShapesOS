// Deploy PR (WS=state): the knowledge corpus on a shared (multi-instance)
// install — publish once, every instance refreshes its read cache; runtime
// corpus edits are refused there. The shared store is the in-process
// S3-compatible FAKE (lib/filesystem/fake-s3.ts — labelled fake, it checks
// every SigV4 signature) behind the real S3 client.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S3BlobBackend, S3CompatibleAdapter, setBlobBackendForTests, resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { startFakeS3, type FakeS3 } from "@/lib/filesystem/fake-s3";
import { corpusReadOnlyReason, corpusIsShared, ensureCorpusFresh, publishCorpusSnapshot, __resetCorpusSyncForTests } from "../sync";
import { corpusDir, loadChunks, loadManifest } from "../store";
import { listProposed } from "../proposals";

let fake: FakeS3;
let tmp: string;
const saved = { ...process.env };

function writeCorpus(dir: string, version: number, chunkText: string, proposals: string[] = []) {
  fs.mkdirSync(path.join(dir, "main"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ corpusVersion: version, sources: [] }));
  fs.writeFileSync(
    path.join(dir, "main", "chunks.jsonl"),
    JSON.stringify({ id: `c${version}`, text: chunkText, embedding: [1, 0], provenance: { sourceId: "s1", sourceTitle: "S", author: "A", license: "CC-BY-4.0" } }) + "\n",
  );
  fs.writeFileSync(path.join(dir, "main", "LICENSE.txt"), "licence");
  fs.rmSync(path.join(dir, "proposed"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "proposed"), { recursive: true });
  for (const p of proposals) {
    fs.writeFileSync(path.join(dir, "proposed", `${p}.json`), JSON.stringify({ id: p, title: p, pillar: "marketing", kind: "url", status: "proposed", createdAt: "2026-10-05T00:00:00Z", createdBy: "op" }));
  }
}

before(async () => {
  fake = await startFakeS3({ bucket: "corpus", accessKeyId: "AK", secretAccessKey: "SK" });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-sync-"));
});

beforeEach(() => {
  __resetCorpusSyncForTests();
  process.env = { ...saved };
  resetStorageAdapterForTests();
});

after(async () => {
  process.env = saved;
  setBlobBackendForTests(null);
  resetStorageAdapterForTests();
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function useSharedStorage(cacheDir: string) {
  process.env.MARKETR_STORAGE = "s3";
  process.env.CORPUS_DIR = cacheDir;
  setBlobBackendForTests(
    new S3BlobBackend(new S3CompatibleAdapter({ endpoint: fake.endpoint, region: "us-east-1", bucket: "corpus", accessKey: "AK", secretKey: "SK", forcePathStyle: true })),
  );
}

describe("shared corpus snapshot", () => {
  it("a single box needs no sync and stays editable", async () => {
    delete process.env.MARKETR_STORAGE;
    delete process.env.DEPLOYMENT_MODE;
    assert.equal(corpusIsShared(), false);
    assert.equal(corpusReadOnlyReason(), null);
    assert.equal(await ensureCorpusFresh({ force: true }), "local");
  });

  it("publish once; another instance's cache picks it up, and later republishes", async () => {
    const source = path.join(tmp, "operator-checkout");
    writeCorpus(source, 1, "first", ["p-one"]);
    useSharedStorage(path.join(tmp, "instance-b-cache"));
    assert.equal(await ensureCorpusFresh({ force: true }), "unavailable", "nothing published yet");

    const pub = await publishCorpusSnapshot(source);
    assert.equal(pub.uploaded[pub.uploaded.length - 1], "manifest.json", "manifest is uploaded last");
    assert.ok(fake.objects.has("blobs/corpus/main/chunks.jsonl"));

    assert.equal(await ensureCorpusFresh({ force: true }), "synced");
    assert.equal(corpusDir(), path.join(tmp, "instance-b-cache"));
    assert.equal(loadManifest()!.corpusVersion, 1);
    assert.equal(loadChunks("main")[0]!.text, "first");
    assert.deepEqual(listProposed().map((p) => p.id), ["p-one"]);
    assert.equal(await ensureCorpusFresh({ force: true }), "fresh", "unchanged manifest → nothing downloaded");
    assert.equal(await ensureCorpusFresh(), "fresh", "throttled");

    writeCorpus(source, 2, "second", []);
    const pub2 = await publishCorpusSnapshot(source);
    assert.deepEqual(pub2.removed, ["proposed/p-one.json"], "stale proposals are removed remotely");
    assert.equal(await ensureCorpusFresh({ force: true }), "synced");
    assert.equal(loadManifest()!.corpusVersion, 2);
    assert.equal(loadChunks("main")[0]!.text, "second");
    assert.deepEqual(listProposed(), []);
    assert.ok(fake.requests.every((r) => r.signed));
  });

  it("runtime corpus edits are refused on a shared or hosted install", () => {
    process.env.MARKETR_STORAGE = "s3";
    assert.match(corpusReadOnlyReason() ?? "", /read-only/);
    delete process.env.MARKETR_STORAGE;
    process.env.DEPLOYMENT_MODE = "hosted";
    assert.match(corpusReadOnlyReason() ?? "", /corpus-publish/);
  });

  it("the default cache on a shared install is per-instance tmp, not the repo's data/corpus", () => {
    process.env.MARKETR_STORAGE = "s3";
    delete process.env.CORPUS_DIR;
    assert.equal(corpusDir(), path.join(os.tmpdir(), "shapes-corpus"));
    process.env.MARKETR_STORAGE = "local";
    assert.equal(corpusDir(), path.join(process.cwd(), "data", "corpus"));
  });
});
