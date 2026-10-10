// ShapesOS — Phase 21B (WS=drive): "restore this folder as of <time>" against Postgres
// (app role), built on version history and the change journal. Never deletes.
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/restore-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "p21b-restore-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = DIR;
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { resetStorageAdapterForTests, getStorageAdapter } from "@/lib/filesystem/storage";
import { moveFile, trashFile, writeFile } from "@/lib/filesystem/service";
import { overwriteFile, setVersionRetention } from "@/lib/filesystem/versions";
import { listChanges } from "@/lib/drive/changes";
import { restoreFolderAsOf } from "@/lib/drive/restore";

const RUN = randomUUID().slice(0, 8);
const WS = `p21r-${RUN}`;
const ED = `p21r-ed-${RUN}`;
const OTHER = `p21r-other-${RUN}`;
const VIEW = `p21r-view-${RUN}`;
const ed = { workspaceId: WS, userId: ED, role: "editor" as const };
const text = (s: string) => Buffer.from(s, "utf8");
const pause = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const mk = (p: string, body: string) => writeFile({ workspaceId: WS, logicalPath: p, kind: "file", bytes: text(body), createdBy: ED, mimeType: "text/plain" });
const ow = (id: string, body: string) => overwriteFile({ workspaceId: WS, fileId: id, bytes: text(body), mimeType: "text/plain", userId: ED });
const content = async (id: string) => {
  const f = await prisma.workspaceFile.findFirstOrThrow({ where: { id } });
  return (await getStorageAdapter().get(f.storageKey))!.toString();
};

let tA = new Date();
const id: Record<string, string> = {};

before(async () => {
  resetStorageAdapterForTests();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ED } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ED, role: "editor", email: `e-${RUN}@example.test`, name: "Ed" },
      { workspaceId: WS, userId: OTHER, role: "editor", email: `o-${RUN}@example.test`, name: "Other" },
      { workspaceId: WS, userId: VIEW, role: "viewer", email: `v-${RUN}@example.test`, name: "View" },
    ],
  });
  for (const n of ["a", "b", "d", "h", "g", "e"]) id[n] = (await mk(`/shared/Plans/${n}.txt`, `${n} v1`)).id;
  await pause();
  await trashFile({ workspaceId: WS, fileId: id.g!, actorUserId: ED }); // trashed BEFORE the time
  await pause();
  tA = new Date();
  await pause();
  await ow(id.a!, "a v2"); // changed after
  await ow(id.e!, "e v2");
  await ow(id.e!, "e v3");
  await setVersionRetention(WS, 1); // e's first version is purged: nothing to restore from
  await trashFile({ workspaceId: WS, fileId: id.d!, actorUserId: ED }); // trashed after
  await moveFile({ workspaceId: WS, fileId: id.h!, newPath: "/shared/Archive/h.txt", actorUserId: ED }); // moved out after
  id.c = (await mk("/shared/Plans/c.txt", "c v1")).id; // created after
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
  rmSync(DIR, { recursive: true, force: true });
});

describe("restoreFolderAsOf", () => {
  it("the dry run returns the plan and changes nothing", async () => {
    const before = await listChanges({ workspaceId: WS, viewerUserId: ED });
    const r = await restoreFolderAsOf({ actor: ed, folder: "/shared/Plans", asOf: tA });
    assert.equal(r.applied, false);
    assert.equal(r.plan.dryRun, true);
    const by = Object.fromEntries(r.plan.items.map((i) => [i.path.split("/").pop()!, i]));
    assert.equal(by["a.txt"]!.action, "restore_version");
    assert.equal(by["a.txt"]!.toVersion, 1);
    assert.equal(by["b.txt"]!.action, "unchanged");
    assert.equal(by["c.txt"]!.action, "skip_created_after");
    assert.equal(by["d.txt"]!.action, "untrash");
    assert.equal(by["g.txt"]!.action, "skip_trashed_then");
    assert.equal(by["h.txt"]!.action, "unchanged");
    assert.equal(by["h.txt"]!.movedFrom, "/shared/Plans/h.txt", "it was in the folder then and lives in Archive now");
    assert.equal(by["e.txt"]!.action, "unavailable", "its version history for that time was purged");
    assert.equal(r.plan.willDelete, 0);
    const after = await listChanges({ workspaceId: WS, viewerUserId: ED });
    assert.equal(after.head, before.head, "a dry run writes nothing to the journal");
    assert.equal(await content(id.a!), "a v2");
  });

  it("applies the plan as new versions and bring-backs, and never deletes: the file created later stays", async () => {
    const r = await restoreFolderAsOf({ actor: ed, folder: "/shared/Plans", asOf: tA, apply: true });
    assert.equal(r.applied, true);
    const res = Object.fromEntries(r.outcomes.map((o) => [o.path.split("/").pop()!, o]));
    assert.equal(res["a.txt"]!.result, "restored");
    assert.equal(res["a.txt"]!.newVersion, 3);
    assert.equal(res["d.txt"]!.result, "untrashed");
    assert.equal(res["c.txt"]!.result, "skipped");
    assert.equal(await content(id.a!), "a v1", "the bytes from that time came back");
    const a = await prisma.workspaceFile.findFirstOrThrow({ where: { id: id.a! } });
    assert.equal(a.version, 3, "as a NEW version; history only grows");
    assert.equal((await prisma.workspaceFile.findFirstOrThrow({ where: { id: id.d! } })).trashedAt, null);
    assert.ok(await prisma.workspaceFile.findFirst({ where: { id: id.c!, trashedAt: null } }), "nothing created later was deleted");
    assert.ok((await prisma.workspaceFile.findFirstOrThrow({ where: { id: id.g! } })).trashedAt, "the file that was already in the trash then stays there");
    assert.equal((await prisma.workspaceFile.findFirstOrThrow({ where: { id: id.h! } })).logicalPath, "/shared/Archive/h.txt", "a file moved away keeps its new place");
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS } }), 7, "every file is still there");
  });

  it("applying again is a no-op for what is already restored", async () => {
    const r = await restoreFolderAsOf({ actor: ed, folder: "/shared/Plans", asOf: tA, apply: true });
    assert.deepEqual(r.outcomes.filter((o) => o.result === "restored" || o.result === "untrashed"), [], "nothing left to restore");
  });

  it("a viewer can see the plan but not apply it; a time in the future or a folder in someone's home is refused", async () => {
    const view = { workspaceId: WS, userId: VIEW, role: "viewer" as const };
    assert.equal((await restoreFolderAsOf({ actor: view, folder: "/shared/Plans", asOf: tA })).applied, false);
    await assert.rejects(() => restoreFolderAsOf({ actor: view, folder: "/shared/Plans", asOf: tA, apply: true }), /edit access/);
    await assert.rejects(() => restoreFolderAsOf({ actor: ed, folder: "/shared/Plans", asOf: new Date(Date.now() + 60_000) }), /future/);
    await assert.rejects(() => restoreFolderAsOf({ actor: ed, folder: `/home/${OTHER}/Docs`, asOf: tA }), (e: unknown) => (e as { status?: number }).status === 404);
  });
});
