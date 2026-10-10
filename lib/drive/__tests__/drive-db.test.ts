// ShapesOS — Phase 21B (WS=drive): the Drive model against real Postgres, as the
// least-privilege app role (FORCE RLS applies).
//   - private homes are invisible to other members, admins and owners included;
//     they open only through an explicit share, on a folder or a file
//   - folder ACLs inherit, a deeper entry overrides
//   - folders: empty folders, nested create, rename/move rewrites the subtree
//     and the journal, case-only collisions refused, trash/restore as one batch
//   - the change journal numbers events strictly in commit order under
//     concurrent writers (no reader ever sees a gap)
//   - quota under concurrent writes: workspace, a person's home, an app container
//   - hosted mode refuses uploads without a malware scanner
//   - RLS: every new table is invisible without the workspace GUC
//   - the backfill migration fills folders and path keys for rows that pre-date Drive
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/drive-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = mkdtempSync(join(tmpdir(), "p21b-drive-"));
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { FsError, deleteFile, getQuota, moveFile, renameFile, restoreFile, setQuotaLimit, trashFile, writeFile } from "@/lib/filesystem/service";
import { createFolder, moveFolder, restoreFolder, trashFolder, renameFolder } from "@/lib/filesystem/folders";
import { listChanges } from "@/lib/drive/changes";
import { requireFileAction, listFileAccess, setFileAccess, type FileActor } from "@/lib/files/access";
import { driveRoleFor } from "@/lib/drive/access";
import { resetMalwareScannerForTests } from "@/lib/security/malware-scan";
import { setScopeLimit, getScopeUsage } from "@/lib/drive/quota-store";

const RUN = randomUUID().slice(0, 8);
const WS = `p21d-${RUN}`;
const ANA = `p21d-ana-${RUN}`; // editor
const BEN = `p21d-ben-${RUN}`; // editor
const ADM = `p21d-adm-${RUN}`; // admin
const OWN = `p21d-own-${RUN}`; // workspace owner
const VIC = `p21d-vic-${RUN}`; // viewer
const ana: FileActor = { workspaceId: WS, userId: ANA, role: "editor" };
const ben: FileActor = { workspaceId: WS, userId: BEN, role: "editor" };
const adm: FileActor = { workspaceId: WS, userId: ADM, role: "admin" };
const own: FileActor = { workspaceId: WS, userId: OWN, role: "owner" };
const vic: FileActor = { workspaceId: WS, userId: VIC, role: "viewer" };

const text = (s: string) => Buffer.from(s, "utf8");
const put = (logicalPath: string, body = "hello drive", createdBy = ANA) =>
  writeFile({ workspaceId: WS, logicalPath, kind: "file", bytes: text(body), createdBy, mimeType: "text/plain" });

async function expectFs(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof FsError && e.code === code, `expected FsError ${code}`);
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWN } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `ana-${RUN}@example.test`, name: "Ana" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `ben-${RUN}@example.test`, name: "Ben" },
      { workspaceId: WS, userId: ADM, role: "admin", email: `adm-${RUN}@example.test`, name: "Adm" },
      { workspaceId: WS, userId: OWN, role: "owner", email: `own-${RUN}@example.test`, name: "Own" },
      { workspaceId: WS, userId: VIC, role: "viewer", email: `vic-${RUN}@example.test`, name: "Vic" },
    ],
  });
});

after(async () => {
  await new Promise((r) => setTimeout(r, 300)); // background index jobs
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("private homes", () => {
  let file = "";
  before(async () => {
    const f = await put(`/home/${ANA}/Taxes/return.txt`, "my taxes");
    file = f.id;
    assert.equal(f.ownerUserId, ANA);
  });

  it("belongs to its owner", async () => {
    const r = await requireFileAction(ana, file, "manageAccess");
    assert.equal(r.role, "owner");
  });

  it("is invisible to another editor, an admin, the workspace owner and a viewer (404, not 403)", async () => {
    for (const who of [ben, adm, own, vic]) {
      await assert.rejects(() => requireFileAction(who, file, "view"), (e: unknown) => (e as { status?: number }).status === 404, who.role);
    }
  });

  it("does not list the home to anyone else", async () => {
    const { listDir } = await import("@/lib/filesystem/service");
    const mine = await listDir({ workspaceId: WS, prefix: `/home/${ANA}/Taxes`, viewerUserId: ANA });
    assert.deepEqual(mine.files.map((f) => f.filename), ["return.txt"]);
    for (const viewerUserId of [BEN, ADM, OWN, undefined]) {
      const theirs = await listDir({ workspaceId: WS, prefix: `/home/${ANA}/Taxes`, viewerUserId });
      assert.deepEqual(theirs.files, [], String(viewerUserId));
    }
  });

  it("opens only through an explicit share on the file, never above editor", async () => {
    await setFileAccess(ana, file, ADM, "viewer");
    assert.equal((await requireFileAction(adm, file, "view")).role, "viewer", "an admin gets only what was shared");
    await assert.rejects(() => requireFileAction(adm, file, "edit"), (e: unknown) => (e as { status?: number }).status === 403);
    await assert.rejects(() => setFileAccess(ana, file, BEN, "owner"), /ownership stays/i);
    await setFileAccess(ana, file, BEN, "editor");
    assert.equal((await requireFileAction(ben, file, "edit")).role, "editor");
    await setFileAccess(ana, file, ADM, null);
    await assert.rejects(() => requireFileAction(adm, file, "view"), (e: unknown) => (e as { status?: number }).status === 404);
  });

  it("lists access only for the people who can see it", async () => {
    const { entries } = await listFileAccess(ana, file);
    assert.deepEqual(entries.map((e) => e.userId).sort(), [ANA, BEN].sort());
  });

  it("opens through a folder share, and a deeper entry can narrow it again", async () => {
    const taxes = (await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirst({ where: { workspaceId: WS, path: `/home/${ANA}/Taxes` } })))!;
    assert.equal(taxes.ownerUserId, ANA);
    await withWorkspaceScope(WS, (tx) => tx.workspaceFolderAcl.create({ data: { workspaceId: WS, folderId: taxes.id, userId: OWN, role: "viewer", grantedBy: ANA } }));
    assert.equal(await driveRoleFor(own, { path: `/home/${ANA}/Taxes/return.txt`, ownerUserId: ANA, createdBy: ANA, fileId: file }), "viewer");
    assert.equal(await driveRoleFor(own, { path: `/home/${ANA}/Other/x.txt`, ownerUserId: ANA, createdBy: ANA }), null, "the share is for that folder only");
    await withWorkspaceScope(WS, (tx) => tx.workspaceFileAcl.create({ data: { workspaceId: WS, fileId: file, userId: OWN, role: "editor", grantedBy: ANA } }));
    assert.equal(await driveRoleFor(own, { path: `/home/${ANA}/Taxes/return.txt`, ownerUserId: ANA, createdBy: ANA, fileId: file }), "editor", "a file entry overrides its folder");
  });
});

describe("folder ACL inheritance in the shared area", () => {
  it("a folder entry narrows everything beneath it; a deeper entry restores it", async () => {
    const f = await put("/shared/Marketing/plans/q4.txt", "plan");
    const folderOf = async (p: string) => (await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirst({ where: { workspaceId: WS, path: p } })))!;
    const marketing = await folderOf("/shared/Marketing");
    const plans = await folderOf("/shared/Marketing/plans");
    assert.equal((await requireFileAction(ben, f.id, "edit")).role, "editor");
    await withWorkspaceScope(WS, (tx) => tx.workspaceFolderAcl.create({ data: { workspaceId: WS, folderId: marketing.id, userId: BEN, role: "viewer", grantedBy: ADM } }));
    assert.equal((await requireFileAction(ben, f.id, "view")).role, "viewer", "inherited from Marketing");
    await assert.rejects(() => requireFileAction(ben, f.id, "edit"), (e: unknown) => (e as { status?: number }).status === 403);
    await withWorkspaceScope(WS, (tx) => tx.workspaceFolderAcl.create({ data: { workspaceId: WS, folderId: plans.id, userId: BEN, role: "editor", grantedBy: ADM } }));
    assert.equal((await requireFileAction(ben, f.id, "edit")).role, "editor", "the deeper entry wins");
    assert.equal((await requireFileAction(adm, f.id, "manageAccess")).role, "owner", "admins are never narrowed");
  });
});

describe("folders", () => {
  it("creates nested folders and empty folders, with the parents", async () => {
    const f = await createFolder({ workspaceId: WS, path: "/shared/Design/Logos/Archive", createdBy: ANA });
    assert.equal(f.path, "/shared/Design/Logos/Archive");
    const rows = await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findMany({ where: { workspaceId: WS, path: { startsWith: "/shared/Design" } }, orderBy: { path: "asc" } }));
    assert.deepEqual(rows.map((r) => r.path), ["/shared/Design", "/shared/Design/Logos", "/shared/Design/Logos/Archive"]);
    assert.equal(rows[2]!.parentId, rows[1]!.id);
    assert.equal(rows[0]!.parentId, null, "/shared itself is virtual");
  });

  it("refuses two folders (or a file and a folder) whose names differ only by case or Unicode form", async () => {
    await expectFs(createFolder({ workspaceId: WS, path: "/shared/design", createdBy: ANA }), "conflict");
    await expectFs(createFolder({ workspaceId: WS, path: "/shared/Café", createdBy: ANA }).then(() => createFolder({ workspaceId: WS, path: "/shared/Café", createdBy: ANA })), "conflict");
    await put("/shared/Notes/Report.txt", "x");
    await expectFs(put("/shared/Notes/report.TXT", "y"), "conflict");
    await expectFs(createFolder({ workspaceId: WS, path: "/shared/Notes/REPORT.txt", createdBy: ANA }), "conflict");
  });

  it("a file written under a different spelling of an existing folder lands in that folder", async () => {
    const f = await put("/shared/DESIGN/Logos/new.txt", "z");
    assert.equal(f.logicalPath, "/shared/Design/Logos/new.txt");
  });

  it("renaming a folder rewrites everything beneath it and the journal says so", async () => {
    await put("/shared/Old/a.txt", "a");
    await put("/shared/Old/sub/b.txt", "b");
    const before = await listChanges({ workspaceId: WS, viewerUserId: ANA });
    const old = await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path: "/shared/Old" } }));
    const moved = await renameFolder({ workspaceId: WS, folderId: old.id, name: "Renamed", actorUserId: ANA });
    assert.equal(moved.path, "/shared/Renamed");
    const files = await prisma.workspaceFile.findMany({ where: { workspaceId: WS, logicalPath: { startsWith: "/shared/Renamed/" } }, orderBy: { logicalPath: "asc" } });
    assert.deepEqual(files.map((f) => f.logicalPath), ["/shared/Renamed/a.txt", "/shared/Renamed/sub/b.txt"]);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: { startsWith: "/shared/Old/" } } }), 0);
    const after = await listChanges({ workspaceId: WS, viewerUserId: ANA, cursor: before.cursor });
    const moves = after.changes.filter((c) => c.type === "move");
    assert.deepEqual(moves.map((m) => [m.entity, m.prevPath, m.path]).sort(), [
      ["file", "/shared/Old/a.txt", "/shared/Renamed/a.txt"],
      ["file", "/shared/Old/sub/b.txt", "/shared/Renamed/sub/b.txt"],
      ["folder", "/shared/Old", "/shared/Renamed"],
      ["folder", "/shared/Old/sub", "/shared/Renamed/sub"],
    ]);
  });

  it("cannot move a folder into itself or onto an existing folder", async () => {
    const a = await createFolder({ workspaceId: WS, path: "/shared/Loop/A", createdBy: ANA });
    await expectFs(moveFolder({ workspaceId: WS, folderId: a.id, newPath: "/shared/Loop/A/B/A", actorUserId: ANA }), "invalid_path");
    await createFolder({ workspaceId: WS, path: "/shared/Loop/B", createdBy: ANA });
    await expectFs(moveFolder({ workspaceId: WS, folderId: a.id, newPath: "/shared/loop/b", actorUserId: ANA }), "conflict");
  });

  it("system folders cannot be moved or trashed", async () => {
    await put("/files/sys/a.txt", "a");
    const root = await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path: "/files" } }));
    assert.equal(root.system, true);
    await expectFs(moveFolder({ workspaceId: WS, folderId: root.id, newPath: "/shared/Files2", actorUserId: ANA }), "invalid_state");
    await expectFs(trashFolder({ workspaceId: WS, folderId: root.id, actorUserId: ANA }), "invalid_state");
  });

  it("trashing a folder takes its files with it; restoring brings back exactly those, and a file trashed earlier stays trashed", async () => {
    await put("/shared/Gone/keep.txt", "k");
    const early = await put("/shared/Gone/early.txt", "e");
    await trashFile({ workspaceId: WS, fileId: early.id, actorUserId: ANA });
    await put("/shared/Gone/sub/deep.txt", "d");
    const gone = await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path: "/shared/Gone" } }));
    const t = await trashFolder({ workspaceId: WS, folderId: gone.id, actorUserId: ANA });
    assert.deepEqual([t.files, t.folders], [2, 1]);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: { startsWith: "/shared/Gone/" }, trashedAt: null } }), 0);
    const r = await restoreFolder({ workspaceId: WS, folderId: gone.id, actorUserId: ANA });
    assert.equal(r.files, 2);
    const live = await prisma.workspaceFile.findMany({ where: { workspaceId: WS, logicalPath: { startsWith: "/shared/Gone/" }, trashedAt: null }, orderBy: { logicalPath: "asc" } });
    assert.deepEqual(live.map((f) => f.logicalPath), ["/shared/Gone/keep.txt", "/shared/Gone/sub/deep.txt"]);
    const stillTrashed = await prisma.workspaceFile.findFirstOrThrow({ where: { id: early.id } });
    assert.ok(stillTrashed.trashedAt, "the file trashed before the folder was not brought back by the folder restore");
  });

  it("restoring over a name that is taken again says conflict", async () => {
    await put("/shared/Dup/a.txt", "a");
    const dup = await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path: "/shared/Dup" } }));
    await trashFolder({ workspaceId: WS, folderId: dup.id, actorUserId: ANA });
    await createFolder({ workspaceId: WS, path: "/shared/Dup", createdBy: ANA });
    await expectFs(restoreFolder({ workspaceId: WS, folderId: dup.id, actorUserId: ANA }), "conflict");
  });

  it("moves a plain file between roots (files -> shared) and keeps managed roots in place", async () => {
    const f = await put("/files/mv/a.txt", "a");
    const moved = await moveFile({ workspaceId: WS, fileId: f.id, newPath: "/shared/Moved/a.txt", actorUserId: ANA });
    assert.equal(moved.logicalPath, "/shared/Moved/a.txt");
    const skill = await writeFile({ workspaceId: WS, logicalPath: "/memory/n.txt", kind: "memory", bytes: text("n"), createdBy: ANA, mimeType: "text/plain" });
    await expectFs(moveFile({ workspaceId: WS, fileId: skill.id, newPath: "/shared/n.txt", actorUserId: ANA }), "invalid_path");
    await expectFs(renameFile({ workspaceId: WS, fileId: moved.id, filename: "bad:name.txt", actorUserId: ANA }), "invalid_path");
    const renamed = await renameFile({ workspaceId: WS, fileId: moved.id, filename: "Café notes.txt", actorUserId: ANA });
    assert.equal(renamed.filename, "Café notes.txt");
  });

  it("moving a file from a private home to the shared area changes its owner and the quota scopes", async () => {
    const f = await put(`/home/${BEN}/draft.txt`, "0123456789", BEN);
    assert.equal((await getScopeUsage(prisma as never, WS, `user:${BEN}`)).usedBytes, 0, "plain prisma cannot read the RLS table");
    const scoped = (await withWorkspaceScope(WS, (tx) => getScopeUsage(tx, WS, `user:${BEN}`))).usedBytes;
    assert.equal(scoped, 10);
    const moved = await moveFile({ workspaceId: WS, fileId: f.id, newPath: "/shared/Published/draft.txt", actorUserId: BEN });
    assert.equal(moved.ownerUserId, null);
    assert.equal((await withWorkspaceScope(WS, (tx) => getScopeUsage(tx, WS, `user:${BEN}`))).usedBytes, 0);
  });
});

describe("change journal", () => {
  it("numbers events 1..N with no gaps and orders them by commit under concurrent writers; a poller never sees a hole", async () => {
    const ws = `p21d-j-${RUN}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
    try {
      const N = 24;
      let stop = false;
      const seen: bigint[][] = [];
      const poller = (async () => {
        while (!stop) {
          const page = await listChanges({ workspaceId: ws, viewerUserId: ANA, limit: 500 });
          seen.push(page.changes.map((c) => BigInt(c.seq)));
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          writeFile({ workspaceId: ws, logicalPath: `/shared/Race/f${i}.txt`, kind: "file", bytes: text(`file ${i}`), createdBy: ANA, mimeType: "text/plain" }),
        ),
      );
      stop = true;
      await poller;
      const final = await listChanges({ workspaceId: ws, viewerUserId: ANA, limit: 500 });
      const seqs = final.changes.map((c) => BigInt(c.seq));
      // N files + the folder /shared/Race (created once, by whichever writer got there first).
      assert.equal(seqs.length, N + 1);
      assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => BigInt(i + 1)), "contiguous from 1");
      assert.equal(final.changes.filter((c) => c.entity === "file").length, N);
      for (const snapshot of seen) {
        assert.deepEqual(snapshot, snapshot.map((_, i) => BigInt(i + 1)), "every poll saw a prefix 1..k, never a hole");
      }
      assert.equal(final.head, `v1.${seqs.length}`);
      // Following from a saved cursor yields exactly the later events.
      const mid = final.changes[9]!.cursor;
      const rest = await listChanges({ workspaceId: ws, viewerUserId: ANA, cursor: mid, limit: 500 });
      assert.equal(rest.changes.length, seqs.length - 10);
      assert.equal(rest.changes[0]!.seq, "11");
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });

  it("pages with hasMore and a cursor that continues", async () => {
    const p1 = await listChanges({ workspaceId: WS, viewerUserId: ANA, limit: 5 });
    assert.equal(p1.changes.length, 5);
    assert.equal(p1.hasMore, true);
    const p2 = await listChanges({ workspaceId: WS, viewerUserId: ANA, cursor: p1.cursor, limit: 5 });
    assert.equal(p2.changes[0]!.seq, String(Number(p1.changes[4]!.seq) + 1));
  });

  it("keeps a person's private home out of everyone else's feed", async () => {
    await put(`/home/${ANA}/secret-feed.txt`, "s");
    const mine = await listChanges({ workspaceId: WS, viewerUserId: ANA, limit: 500 });
    const theirs = await listChanges({ workspaceId: WS, viewerUserId: ADM, limit: 500 });
    assert.ok(mine.changes.some((c) => c.path === `/home/${ANA}/secret-feed.txt`));
    assert.ok(!theirs.changes.some((c) => c.path.startsWith(`/home/${ANA}/`)), "admins do not see private paths in the feed");
  });

  it("refuses a cursor from the future and reports a purged one", async () => {
    await assert.rejects(() => listChanges({ workspaceId: WS, viewerUserId: ANA, cursor: "v1.99999999" }), /future/i);
    await assert.rejects(() => listChanges({ workspaceId: WS, viewerUserId: ANA, cursor: "nonsense" }), /cursor/i);
  });
});

describe("quota under concurrent writes", () => {
  it("the workspace limit holds: 6 racing 40-byte writes into a 100-byte quota -> exactly 2 succeed", async () => {
    const ws = `p21d-q-${RUN}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
    try {
      await setQuotaLimit({ workspaceId: ws, limitBytes: 100 });
      const body = "x".repeat(40);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => writeFile({ workspaceId: ws, logicalPath: `/shared/Q/f${i}.txt`, kind: "file", bytes: text(body), createdBy: ANA, mimeType: "text/plain" })),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
      for (const r of results) if (r.status === "rejected") assert.equal((r.reason as FsError).code, "quota_exceeded");
      assert.equal((await getQuota({ workspaceId: ws })).usedBytes, 80);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });

  it("a person's home limit holds even when the workspace has room", async () => {
    const ws = `p21d-u-${RUN}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
    try {
      await withWorkspaceScope(ws, (tx) => setScopeLimit(tx, ws, `user:${ANA}`, 100));
      const body = "y".repeat(40);
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => writeFile({ workspaceId: ws, logicalPath: `/home/${ANA}/f${i}.txt`, kind: "file", bytes: text(body), createdBy: ANA, mimeType: "text/plain" })),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
      const used = await withWorkspaceScope(ws, (tx) => getScopeUsage(tx, ws, `user:${ANA}`));
      assert.deepEqual(used, { limitBytes: 100, usedBytes: 80 });
      // The shared area is not charged to the person.
      await writeFile({ workspaceId: ws, logicalPath: "/shared/S/free.txt", kind: "file", bytes: text(body), createdBy: ANA, mimeType: "text/plain" });
      assert.equal((await withWorkspaceScope(ws, (tx) => getScopeUsage(tx, ws, `user:${ANA}`))).usedBytes, 80);
      // Purging frees the scope again.
      const f = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: ws, logicalPath: { startsWith: `/home/${ANA}/` } } });
      await trashFile({ workspaceId: ws, fileId: f.id });
      await deleteFile({ workspaceId: ws, fileId: f.id });
      assert.equal((await withWorkspaceScope(ws, (tx) => getScopeUsage(tx, ws, `user:${ANA}`))).usedBytes, 40);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });

  it("app containers are isolated: each install has its own default 1 GiB limit and charges only itself", async () => {
    const ws = `p21d-a-${RUN}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
    try {
      await withWorkspaceScope(ws, (tx) => setScopeLimit(tx, ws, "app:crm/i1", 50));
      const body = "z".repeat(40);
      await writeFile({ workspaceId: ws, logicalPath: "/apps/crm/i1/a.txt", kind: "file", bytes: text(body), createdBy: ANA, mimeType: "text/plain" });
      await expectFs(writeFile({ workspaceId: ws, logicalPath: "/apps/crm/i1/b.txt", kind: "file", bytes: text(body), createdBy: ANA, mimeType: "text/plain" }), "quota_exceeded");
      // Another install of the same app, and another app, are unaffected.
      await writeFile({ workspaceId: ws, logicalPath: "/apps/crm/i2/a.txt", kind: "file", bytes: text(body), createdBy: ANA, mimeType: "text/plain" });
      await writeFile({ workspaceId: ws, logicalPath: "/apps/other/i1/a.txt", kind: "file", bytes: text(body), createdBy: ANA, mimeType: "text/plain" });
      const u = await withWorkspaceScope(ws, async (tx) => [await getScopeUsage(tx, ws, "app:crm/i1"), await getScopeUsage(tx, ws, "app:crm/i2")]);
      assert.deepEqual(u, [{ limitBytes: 50, usedBytes: 40 }, { limitBytes: 1073741824, usedBytes: 40 }]);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });
});

describe("hosted mode requires a malware scanner", () => {
  it("refuses a user upload without CLAMAV_HOST (scanner_unavailable) but still writes server-made files", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    delete process.env.CLAMAV_HOST;
    resetMalwareScannerForTests();
    try {
      await assert.rejects(
        () => put("/shared/Hosted/upload.txt", "hello"),
        (e: unknown) => e instanceof FsError && e.code === "scanner_unavailable" && /CLAMAV_HOST/.test(e.message),
      );
      assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: "/shared/Hosted/upload.txt" } }), 0, "nothing was stored");
      const made = await writeFile({ workspaceId: WS, logicalPath: "/shared/Hosted/report.txt", kind: "file", bytes: text("server made"), createdBy: ANA, skipSafety: true, mimeType: "text/plain" });
      assert.ok(made.id);
    } finally {
      delete process.env.DEPLOYMENT_MODE;
      resetMalwareScannerForTests();
    }
    const ok = await put("/shared/Hosted/selfhost.txt", "hello");
    assert.ok(ok.id, "self-hosted still uploads (with a warning)");
  });
});

describe("RLS", () => {
  const TABLES = [
    "workspace_folders",
    "workspace_folder_acls",
    "workspace_drive_cursors",
    "workspace_drive_changes",
    "workspace_drive_quotas",
    "workspace_uploads",
    "workspace_drive_favorites",
    "workspace_smart_folders",
    "agent_run_folders",
  ];
  it("every new table is invisible without the workspace GUC and visible with it", async () => {
    await withWorkspaceScope(WS, async (tx) => {
      await tx.workspaceDriveFavorite.create({ data: { workspaceId: WS, userId: ANA, entity: "file", entityId: "x" } });
      await tx.workspaceSmartFolder.create({ data: { workspaceId: WS, userId: ANA, name: "s", query: "q" } });
      await tx.agentRunFolder.create({ data: { workspaceId: WS, runId: "r1", folderPath: "/shared/Marketing", attachedBy: ANA } });
      await tx.workspaceUpload.create({
        data: { workspaceId: WS, logicalPath: "/shared/u.txt", filename: "u.txt", mimeType: "text/plain", totalBytes: 10n, partSize: 5242880, partCount: 1, storageKey: randomUUID(), createdBy: ANA, expiresAt: new Date(Date.now() + 1000) },
      });
    });
    for (const t of TABLES) {
      assert.equal(await countWithoutScope(t), 0, `${t} must show zero rows without the GUC`);
      const n = await withWorkspaceScope(WS, async (tx) => ((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t}"`)) as Array<{ n: number }>)[0]!.n);
      assert.ok(n > 0, `${t} must show its rows inside the workspace`);
    }
  });

  it("another workspace's scope cannot read or write this workspace's rows", async () => {
    const other = `p21d-o-${RUN}`;
    await prisma.workspace.create({ data: { id: other, name: other, ownerUserId: ANA } });
    try {
      const n = await withWorkspaceScope(other, (tx) => tx.workspaceFolder.count());
      assert.equal(n, 0);
      await assert.rejects(() => withWorkspaceScope(other, (tx) => tx.workspaceFolder.create({ data: { workspaceId: WS, path: "/shared/Evil", pathKey: "/shared/evil", name: "Evil", createdBy: ANA } })));
    } finally {
      await prisma.workspace.deleteMany({ where: { id: other } });
    }
  });
});

describe("backfill migration", () => {
  it("fills folders, parent links and path keys for rows that pre-date Drive, without touching logical_path", async () => {
    const ws = `p21d-b-${RUN}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
    try {
      const legacy = ["/files/a/b/one.txt", "/files/a/two.txt", "/files/Case.txt", "/files/case.txt", "/memory/m/x.md"];
      for (const [i, p] of legacy.entries()) {
        await prisma.workspaceFile.create({
          data: { workspaceId: ws, logicalPath: p, storageKey: randomUUID(), filename: p.split("/").pop()!, mimeType: "text/plain", sizeBytes: 1, kind: p.startsWith("/memory") ? "memory" : "file", createdBy: ANA, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) },
        });
      }
      const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261101200100_p21_drive_backfill/migration.sql"), "utf8");
      const idx = sql.indexOf("UPDATE workspace_files f");
      const doBlock = sql.slice(sql.indexOf("DO $$"), idx).trim().replace(/;\s*$/, "");
      const update = sql.slice(idx).trim().replace(/;\s*$/, "");
      // Scope the DO block to this workspace only (the migration loops every workspace).
      await prisma.$executeRawUnsafe(doBlock.replace("FOR ws IN SELECT DISTINCT workspace_id FROM workspace_files LOOP", `FOR ws IN SELECT DISTINCT workspace_id FROM workspace_files WHERE workspace_id = '${ws}' LOOP`));
      await prisma.$executeRawUnsafe(update.replace("WHERE trashed_at IS NULL AND path_key IS NULL", `WHERE trashed_at IS NULL AND path_key IS NULL AND workspace_id = '${ws}'`));
      const folders = await withWorkspaceScope(ws, (tx) => tx.workspaceFolder.findMany({ where: { workspaceId: ws }, orderBy: { path: "asc" } }));
      assert.deepEqual(folders.map((f) => [f.path, f.system]), [["/files", true], ["/files/a", false], ["/files/a/b", false], ["/memory", true], ["/memory/m", false]]);
      const byPath = new Map(folders.map((f) => [f.path, f]));
      assert.equal(byPath.get("/files/a/b")!.parentId, byPath.get("/files/a")!.id);
      assert.equal(byPath.get("/files/a")!.parentId, byPath.get("/files")!.id);
      assert.equal(byPath.get("/files")!.parentId, null);
      const files = await prisma.workspaceFile.findMany({ where: { workspaceId: ws }, orderBy: { logicalPath: "asc" } });
      assert.deepEqual(files.map((f) => f.logicalPath), [...legacy].sort(), "logical_path is untouched");
      const keyed = files.filter((f) => f.pathKey !== null).map((f) => f.logicalPath);
      assert.ok(keyed.includes("/files/a/b/one.txt"));
      assert.equal(keyed.filter((p) => p.toLowerCase() === "/files/case.txt").length, 1, "of two paths differing only by case, one keeps the key and the other stays NULL");
      // Idempotent.
      await prisma.$executeRawUnsafe(doBlock.replace("FOR ws IN SELECT DISTINCT workspace_id FROM workspace_files LOOP", `FOR ws IN SELECT DISTINCT workspace_id FROM workspace_files WHERE workspace_id = '${ws}' LOOP`));
      assert.equal(await withWorkspaceScope(ws, (tx) => tx.workspaceFolder.count({ where: { workspaceId: ws } })), 5);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: ws } });
    }
  });
});
