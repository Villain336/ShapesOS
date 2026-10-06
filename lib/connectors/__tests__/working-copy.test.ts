// Deploy PR (WS=state): the site working copy in the shared blob store.
// BlobDirProvider must behave exactly like LocalDirProvider (the single-box
// implementation) for every operation the IDE, builder, fix agent, sync and
// deploys use. The same script runs against LocalDirProvider on a temp dir,
// BlobDirProvider over the local blob backend, and BlobDirProvider over the
// S3 client pointed at the in-process S3-compatible FAKE (labelled fake,
// signature-checked); every observable result must be identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobDirProvider, LocalDirProvider, siteWorkingCopy, deleteSiteWorkingCopy, type WorkingCopyProvider } from "../local";
import {
  blobList,
  LocalBlobBackend,
  resetStorageAdapterForTests,
  S3BlobBackend,
  S3CompatibleAdapter,
  setBlobBackendForTests,
} from "@/lib/filesystem/storage";
import { startFakeS3 } from "@/lib/filesystem/fake-s3";

async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: T } | { err: string }> {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

/** Every observable result of a fixed script of operations. */
async function script(p: WorkingCopyProvider): Promise<unknown[]> {
  const out: unknown[] = [];
  await p.ensureRoot();
  out.push(await outcome(() => p.listDir("/")));
  await p.writeFile("/index.html", "<h1>home</h1>");
  await p.writeFile("css/site.css", "body{}");
  await p.writeFile("/css/deep/x.css", "x{}");
  await p.writeFile("/My Page (1).html", "unicode ✓ name");
  await p.writeFile("/.gitignore", "node_modules/\n");
  await p.writeFile("/.git/info/exclude", "x");
  await p.writeFile("/über/ñ.txt", "accents");
  const strip = (entries: unknown) =>
    (entries as Array<{ name: string; path: string; type: string; size?: number }>).map(({ name, path, type, size }) => ({ name, path, type, size }));
  const root = await outcome(() => p.listDir("/"));
  out.push("ok" in root ? strip(root.ok) : root);
  const css = await outcome(() => p.listDir("/css"));
  out.push("ok" in css ? strip(css.ok) : css);
  out.push(await outcome(() => p.listDir("/missing")));
  out.push(await outcome(() => p.readFile("/index.html")));
  out.push(await outcome(() => p.readFile("/My Page (1).html")));
  out.push(await outcome(() => p.readFile("/über/ñ.txt")));
  out.push(await outcome(() => p.readFile("/nope.html")));
  out.push(await outcome(() => p.readFile("/css")));
  out.push(await outcome(() => p.readFile("/../etc/passwd")));
  await p.writeFile("/big.txt", "a".repeat(200 * 1024 + 1));
  out.push(await outcome(() => p.readFile("/big.txt")));
  await p.writeFile("/bin.dat", "a\u0000b");
  out.push(await outcome(() => p.readFile("/bin.dat")));
  const st = async (path: string) => {
    const r = await outcome(() => p.stat(path));
    return "ok" in r ? { name: r.ok.name, path: r.ok.path, type: r.ok.type, size: r.ok.size } : r;
  };
  out.push(await st("/"), await st("/css"), await st("/index.html"), await st("/nope"));
  out.push(await outcome(() => p.listAllFiles()).then((r) => ("ok" in r ? [...r.ok].sort() : r)));
  out.push(await outcome(() => p.removeFile("/css/site.css")));
  out.push(await outcome(() => p.removeFile("/css/site.css")), "missing file: not an error");
  out.push(await outcome(() => p.removeFile("/")));
  out.push(await outcome(() => p.removeFile("/css")));
  out.push(await outcome(() => p.listAllFiles()).then((r) => ("ok" in r ? [...r.ok].sort() : r)));
  out.push((await p.test()).ok);
  return out;
}

test("BlobDirProvider matches LocalDirProvider on every operation (local blob backend and S3 fake)", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "wc-local-"));
  const dirB = await mkdtemp(join(tmpdir(), "wc-blob-"));
  const fake = await startFakeS3({ bucket: "sites", accessKeyId: "AK", secretAccessKey: "SK", maxKeys: 3 });
  try {
    const expected = await script(new LocalDirProvider(join(dirA, "s1", "working")));

    setBlobBackendForTests(new LocalBlobBackend((ns) => join(dirB, ns)));
    const viaLocalBlobs = await script(new BlobDirProvider("s1/working"));
    assert.deepEqual(viaLocalBlobs, expected);

    setBlobBackendForTests(
      new S3BlobBackend(new S3CompatibleAdapter({ endpoint: fake.endpoint, region: "us-east-1", bucket: "sites", accessKey: "AK", secretKey: "SK", forcePathStyle: true })),
    );
    const viaS3 = await script(new BlobDirProvider("s1/working"));
    assert.deepEqual(viaS3, expected);
    assert.ok(fake.requests.every((r) => r.signed));
    // Non-safe names are stored encoded, never raw.
    assert.ok([...fake.objects.keys()].every((k) => /^[A-Za-z0-9._~\/-]+$/.test(k)), [...fake.objects.keys()].join(" "));
  } finally {
    setBlobBackendForTests(null);
    await fake.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("siteWorkingCopy follows MARKETR_STORAGE; deleteSiteWorkingCopy removes only that site's copy", async () => {
  const saved = { ...process.env };
  const dir = await mkdtemp(join(tmpdir(), "wc-mode-"));
  try {
    process.env.MARKETR_STORAGE = "local";
    process.env.SITE_STORAGE_DIR = join(dir, "sites-local");
    resetStorageAdapterForTests();
    assert.ok(siteWorkingCopy("site_1") instanceof LocalDirProvider);
    assert.throws(() => siteWorkingCopy("../x"), /Invalid site id/);

    process.env.MARKETR_STORAGE = "s3";
    resetStorageAdapterForTests();
    setBlobBackendForTests(new LocalBlobBackend((ns) => join(dir, ns)));
    const a = siteWorkingCopy("site_a");
    const b = siteWorkingCopy("site_b");
    assert.ok(a instanceof BlobDirProvider);
    await a.writeFile("/index.html", "A");
    await b.writeFile("/index.html", "B");
    assert.equal((await a.readFile("/index.html")).content, "A", "copies are isolated per site");
    await deleteSiteWorkingCopy("site_a");
    assert.deepEqual((await blobList("sites", "site_a/")).objects, []);
    assert.equal((await b.readFile("/index.html")).content, "B");
    assert.throws(() => new BlobDirProvider("../x"), /Invalid working copy prefix/);
  } finally {
    process.env = saved;
    setBlobBackendForTests(null);
    resetStorageAdapterForTests();
    await rm(dir, { recursive: true, force: true });
  }
});
