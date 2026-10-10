// ShapesOS — Phase 21B (WS=drive): per-app storage and the file-picker handle model
// against Postgres (app role). No app platform exists yet (21C): these are the typed
// seams it will use.
//   - each install has its own container and quota; nothing leaks between installs
//   - an app cannot name a path outside its container (.., absolute, encoded, other install)
//   - a picked file is ONE file behind an opaque handle; it dies with the person's access
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/app-container-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "p21b-app-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = DIR;
process.env.AUTH_SECRET = "p21b-app-container-test-secret-0123456789";
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { FsError, writeFile } from "@/lib/filesystem/service";
import { resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { appContainer, openHandle, pickFileForApp, purgeAppContainer, resolveInContainer } from "@/lib/drive/app-container";
import { setFileAccess } from "@/lib/files/access";
import { createFolderAs } from "@/lib/drive/ops";

const RUN = randomUUID().slice(0, 8);
const WS = `p21a-${RUN}`;
const ANA = `p21a-ana-${RUN}`;
const BEN = `p21a-ben-${RUN}`;
const VIC = `p21a-vic-${RUN}`;
const ana = { workspaceId: WS, userId: ANA, role: "editor" as const };
const ben = { workspaceId: WS, userId: BEN, role: "editor" as const };
const vic = { workspaceId: WS, userId: VIC, role: "viewer" as const };
const crm1 = { workspaceId: WS, appId: "crm-lite", install: "inst1" };
const crm2 = { workspaceId: WS, appId: "crm-lite", install: "inst2" };
const other = { workspaceId: WS, appId: "notes-plus", install: "inst1" };
const text = (s: string) => Buffer.from(s, "utf8");

async function expectFs(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof FsError && e.code === code, `expected FsError ${code}`);
}

before(async () => {
  resetStorageAdapterForTests();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `a-${RUN}@example.test`, name: "Ana" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `b-${RUN}@example.test`, name: "Ben" },
      { workspaceId: WS, userId: VIC, role: "viewer", email: `v-${RUN}@example.test`, name: "Vic" },
    ],
  });
  await createFolderAs(ana, "/shared/Docs");
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
  rmSync(DIR, { recursive: true, force: true });
});

describe("resolveInContainer (pure rules)", () => {
  it("accepts paths inside the container and refuses everything that leaves it", () => {
    assert.equal(resolveInContainer(crm1, "data/a.json"), "/apps/crm-lite/inst1/data/a.json");
    assert.equal(resolveInContainer(crm1, "/data/a.json"), "/apps/crm-lite/inst1/data/a.json");
    for (const bad of ["../inst2/a.json", "data/../../inst2/a.json", "../../notes-plus/inst1/a.json", "..\\x", "a/%2e%2e/b/../.."]) {
      assert.throws(() => resolveInContainer(crm1, bad), (e: unknown) => e instanceof FsError, bad);
    }
    assert.throws(() => resolveInContainer(crm1, "a\0b"), FsError);
    // A path is always RELATIVE to the app's own root: "/apps/…/inst2/…" is just a nested folder of its own.
    assert.equal(resolveInContainer(crm1, "/apps/crm-lite/inst2/a.json"), "/apps/crm-lite/inst1/apps/crm-lite/inst2/a.json");
  });
});

describe("container isolation and quota", () => {
  it("each install sees only its own files", async () => {
    const a = appContainer(crm1);
    const b = appContainer(crm2);
    const o = appContainer(other);
    await Promise.all([a.ensure(), b.ensure(), o.ensure()]);
    await a.write("data/a.txt", text("install one"));
    await b.write("data/a.txt", text("install two"));
    await o.write("data/a.txt", text("other app"));
    assert.equal((await a.read("data/a.txt"))!.bytes.toString(), "install one");
    assert.equal((await b.read("data/a.txt"))!.bytes.toString(), "install two");
    assert.deepEqual((await a.list("data")).map((e) => e.path), ["/data/a.txt"]);
    assert.equal(await a.read("data/missing.txt"), null);
    await assert.rejects(() => a.read("../inst2/data/a.txt"), FsError);
    await assert.rejects(() => a.write("../inst2/data/pwn.txt", text("x")), FsError);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: "/apps/crm-lite/inst2/data/pwn.txt" } }), 0);
  });

  it("writes need overwrite: true to replace, and a replace is a new version", async () => {
    const a = appContainer(crm1);
    await expectFs(a.write("data/a.txt", text("again")), "conflict");
    const r = await a.write("data/a.txt", text("again"), { overwrite: true });
    assert.deepEqual([r.created, r.version], [false, 2]);
  });

  it("an install's quota is its own: filling one leaves the others alone, and freeing gives it back", async () => {
    const small = appContainer({ workspaceId: WS, appId: "tiny", install: "i1" });
    const sibling = appContainer({ workspaceId: WS, appId: "tiny", install: "i2" });
    await small.ensure();
    await sibling.ensure();
    await small.setLimit(60);
    await small.write("a.txt", text("x".repeat(40)));
    await expectFs(small.write("b.txt", text("y".repeat(40))), "quota_exceeded");
    await sibling.write("b.txt", text("y".repeat(40)));
    assert.deepEqual(await small.usage(), { usedBytes: 40, limitBytes: 60 });
    assert.equal((await sibling.usage()).limitBytes, 1073741824, "a new install starts at 1 GiB");
  });

  it("purging an uninstalled app's container removes its files and frees its quota", async () => {
    const gone = { workspaceId: WS, appId: "gone", install: "i1" };
    const c = appContainer(gone);
    await c.ensure();
    await c.write("a.txt", text("12345"));
    await c.write("sub/b.txt", text("6789"));
    assert.equal((await purgeAppContainer(gone)).files, 2);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: { startsWith: "/apps/gone/i1/" } } }), 0);
    assert.equal((await c.usage()).usedBytes, 0);
  });
});

describe("picker handles", () => {
  let fileId = "";
  let otherFileId = "";
  before(async () => {
    fileId = (await writeFile({ workspaceId: WS, logicalPath: "/shared/Docs/contract.txt", kind: "file", bytes: text("the contract"), createdBy: ANA, mimeType: "text/plain" })).id;
    otherFileId = (await writeFile({ workspaceId: WS, logicalPath: "/shared/Docs/other.txt", kind: "file", bytes: text("other file"), createdBy: ANA, mimeType: "text/plain" })).id;
  });

  it("hands the app one file behind an opaque handle: it can read that file and nothing else", async () => {
    const picked = await pickFileForApp({ actor: ana, app: crm1, fileId });
    assert.equal(picked.name, "contract.txt");
    assert.doesNotMatch(picked.handle, /contract|Docs|shared/);
    const h = await openHandle(crm1, picked.handle);
    assert.equal((await h.read()).toString(), "the contract");
    await assert.rejects(() => h.write(text("x")), /read-only/);
    // The handle cannot be turned into another file: its signature covers the file id.
    const [body, sig] = picked.handle.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), file: otherFileId })).toString("base64url");
    await assert.rejects(() => openHandle(crm1, `${forged}.${sig}`), /isn't valid/);
  });

  it("is useless to another app install or another workspace", async () => {
    const picked = await pickFileForApp({ actor: ana, app: crm1, fileId });
    await assert.rejects(() => openHandle(crm2, picked.handle), /isn't valid/);
    await assert.rejects(() => openHandle(other, picked.handle), /isn't valid/);
    await assert.rejects(() => openHandle({ ...crm1, workspaceId: "someone-else" }, picked.handle), /isn't valid/);
  });

  it("a readwrite handle writes a NEW VERSION of exactly that file; a viewer cannot pick readwrite", async () => {
    const picked = await pickFileForApp({ actor: ana, app: crm1, fileId, mode: "readwrite" });
    const h = await openHandle(crm1, picked.handle);
    assert.deepEqual(await h.write(text("the amended contract")), { version: 2 });
    await expectFs(pickFileForApp({ actor: vic, app: crm1, fileId, mode: "readwrite" }), "forbidden");
    assert.equal((await pickFileForApp({ actor: vic, app: crm1, fileId, mode: "read" })).mode, "read");
  });

  it("expires, and dies with the person's access", async () => {
    const short = await pickFileForApp({ actor: ana, app: crm1, fileId, ttlMs: 1000 });
    await new Promise((r) => setTimeout(r, 1200));
    await assert.rejects(() => openHandle(crm1, short.handle), /isn't valid/);
    // Ana picks a file from her private home; when it stops being hers to share the handle stops working.
    const priv = await writeFile({ workspaceId: WS, logicalPath: `/home/${BEN}/mine.txt`, kind: "file", bytes: text("ben's"), createdBy: BEN, mimeType: "text/plain" });
    await setFileAccess(ben, priv.id, ANA, "viewer");
    const picked = await pickFileForApp({ actor: ana, app: crm1, fileId: priv.id });
    assert.equal((await (await openHandle(crm1, picked.handle)).read()).toString(), "ben's");
    await setFileAccess(ben, priv.id, ANA, null);
    await assert.rejects(() => openHandle(crm1, picked.handle), /no longer has access/);
    await expectFs(pickFileForApp({ actor: ana, app: crm1, fileId: priv.id }), "not_found");
  });

  it("is off without a signing secret (fails closed)", async () => {
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      await expectFs(pickFileForApp({ actor: ana, app: crm1, fileId }), "invalid_state");
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });
});
