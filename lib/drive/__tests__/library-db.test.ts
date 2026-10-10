// ShapesOS — Phase 21B (WS=drive): folder sharing, favourites, tags and smart folders
// against Postgres (app role).
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/library-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "p21b-lib-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = DIR;
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { writeFile } from "@/lib/filesystem/service";
import { requireFileAction } from "@/lib/files/access";
import { createFolderAs } from "@/lib/drive/ops";
import { listFolderAccess, setFolderAccess } from "@/lib/drive/sharing";
import { cleanTags, deleteSmartFolder, filesWithTag, listFavorites, listSmartFolders, listTags, saveSmartFolder, setFavorite, setFileTags } from "@/lib/drive/library";
import { listChildren, listRoots, listTrash, recents, sharedWithMe, storageUsage } from "@/lib/drive/tree";
import { trashItemAs } from "@/lib/drive/ops";
import { setFileAccess } from "@/lib/files/access";

const RUN = randomUUID().slice(0, 8);
const WS = `p21l-${RUN}`;
const ANA = `p21l-ana-${RUN}`;
const BEN = `p21l-ben-${RUN}`;
const ADM = `p21l-adm-${RUN}`;
const VIC = `p21l-vic-${RUN}`;
const ana = { workspaceId: WS, userId: ANA, role: "editor" as const };
const ben = { workspaceId: WS, userId: BEN, role: "editor" as const };
const adm = { workspaceId: WS, userId: ADM, role: "admin" as const };
const vic = { workspaceId: WS, userId: VIC, role: "viewer" as const };
const text = (s: string) => Buffer.from(s, "utf8");
const mk = (p: string, by = ANA) => writeFile({ workspaceId: WS, logicalPath: p, kind: "file", bytes: text("content of " + p), createdBy: by, mimeType: "text/plain" });
const folderId = async (path: string) => (await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path } }))).id;
const status = (e: unknown) => (e as { status?: number }).status;

before(async () => {
  resetStorageAdapterForTests();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ADM } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `a-${RUN}@example.test`, name: "Ana" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `b-${RUN}@example.test`, name: "Ben" },
      { workspaceId: WS, userId: ADM, role: "admin", email: `d-${RUN}@example.test`, name: "Adm" },
      { workspaceId: WS, userId: VIC, role: "viewer", email: `v-${RUN}@example.test`, name: "Vic" },
    ],
  });
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
  rmSync(DIR, { recursive: true, force: true });
});

describe("sharing a folder", () => {
  it("in the shared area, an entry narrows an editor for everything beneath, and admins are never narrowed", async () => {
    await createFolderAs(ana, "/shared/Finance");
    const f = await mk("/shared/Finance/budget.txt");
    const id = await folderId("/shared/Finance");
    assert.equal((await requireFileAction(ben, f.id, "edit")).role, "editor");
    const entries = await setFolderAccess(adm, id, BEN, "viewer");
    assert.equal(entries.find((e) => e.userId === BEN)!.override, "viewer");
    assert.equal((await requireFileAction(ben, f.id, "view")).role, "viewer");
    await assert.rejects(() => requireFileAction(ben, f.id, "edit"), (e) => status(e) === 403);
    await assert.rejects(() => setFolderAccess(adm, id, ADM, "viewer"), /always have full access/);
    await assert.rejects(() => setFolderAccess(adm, id, VIC, "editor"), /more access than their workspace role/);
    await assert.rejects(() => setFolderAccess(ben, id, BEN, "owner"), (e) => status(e) === 403, "someone without manage rights cannot change access");
    await setFolderAccess(adm, id, BEN, null);
    assert.equal((await requireFileAction(ben, f.id, "edit")).role, "editor", "back to the workspace role");
  });

  it("system folders are shared with the whole workspace, not by entries", async () => {
    await mk("/files/sys/x.txt");
    const root = await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path: "/files" } }));
    await assert.rejects(() => setFolderAccess(adm, root.id, BEN, "viewer"), /System folders/);
  });

  it("a private home is shared only by its owner, as view or edit, and never by an admin", async () => {
    await createFolderAs(ana, `/home/${ANA}/Taxes`);
    const f = await mk(`/home/${ANA}/Taxes/return.txt`);
    const id = await folderId(`/home/${ANA}/Taxes`);
    await assert.rejects(() => setFolderAccess(adm, id, BEN, "viewer"), (e) => status(e) === 404, "an admin cannot even see the folder");
    await assert.rejects(() => setFolderAccess(ana, id, BEN, "owner"), /ownership stays/);
    await assert.rejects(() => setFolderAccess(ana, id, ANA, "viewer"), /already theirs/);
    const entries = await setFolderAccess(ana, id, ADM, "viewer");
    assert.deepEqual(entries.map((e) => [e.userId, e.effective]).sort(), [[ADM, "viewer"], [ANA, "owner"]].sort());
    assert.equal((await requireFileAction(adm, f.id, "view")).role, "viewer", "now the admin sees exactly what was shared");
    await assert.rejects(() => requireFileAction(ben, f.id, "view"), (e) => status(e) === 404, "nobody else does");
    const { entries: listed } = await listFolderAccess(ana, id);
    assert.deepEqual(listed.map((e) => e.userId).sort(), [ADM, ANA].sort(), "only the owner and the people it was shared with are listed");
    // "Shared with me" shows it to the sharee, flagged as from a private folder.
    const sw = await sharedWithMe(adm);
    assert.deepEqual(sw.map((s) => [s.kind, s.name, s.role, s.inPrivateHome, s.sharedBy]), [["folder", "Taxes", "viewer", true, ANA]]);
  });
});

describe("tree reads", () => {
  it("roots: home and shared always, trash last; home is created on demand", async () => {
    const roots = await listRoots(ben);
    assert.deepEqual(roots.map((r) => r.key), ["home", "shared", "trash"]);
    assert.equal(roots[0]!.path, `/home/${BEN}`);
  });

  it("lists /shared with the four system folders first-class, folders before files, and nobody's private home", async () => {
    await mk("/shared/loose.txt");
    const l = await listChildren({ actor: ben, path: "/shared" });
    const names = l.items.map((i) => `${i.kind}:${i.name}`);
    assert.ok(names.includes("folder:skills") && names.includes("folder:memory") && names.includes("folder:artifacts") && names.includes("folder:files"));
    assert.ok(names.includes("folder:Finance") && names.includes("file:loose.txt"));
    assert.ok(names.indexOf("folder:Finance") < names.indexOf("file:loose.txt"), "folders come first");
    assert.deepEqual(l.items.find((i) => i.name === "files")!.path, "/shared/files");
    const homeList = await listChildren({ actor: ana, path: `/home/${ANA}` });
    assert.deepEqual(homeList.items.map((i) => i.name), ["Taxes"]);
    await assert.rejects(() => listChildren({ actor: ben, path: `/home/${ANA}` }), (e) => status(e) === 404);
    // The admin was shared exactly the Taxes folder (above): that lists, the home around it does not.
    assert.deepEqual((await listChildren({ actor: adm, path: `/home/${ANA}/Taxes` })).items.map((i) => i.name), ["return.txt"]);
    await assert.rejects(() => listChildren({ actor: adm, path: `/home/${ANA}` }), (e) => status(e) === 404);
  });

  it("the system folders are reachable under /shared/files and list their files", async () => {
    const l = await listChildren({ actor: ben, path: "/shared/files/sys" });
    assert.deepEqual(l.items.map((i) => i.name), ["x.txt"]);
    assert.equal(l.path, "/shared/files/sys");
    assert.deepEqual(l.breadcrumbs.map((b) => b.name), ["shared", "files", "sys"]);
  });

  it("sorts and pages: by name, size and modified, ascending and descending", async () => {
    await createFolderAs(ana, "/shared/Sorted");
    await writeFile({ workspaceId: WS, logicalPath: "/shared/Sorted/b.txt", kind: "file", bytes: text("bb"), createdBy: ANA, mimeType: "text/plain" });
    await writeFile({ workspaceId: WS, logicalPath: "/shared/Sorted/a.txt", kind: "file", bytes: text("aaaa"), createdBy: ANA, mimeType: "text/plain" });
    await writeFile({ workspaceId: WS, logicalPath: "/shared/Sorted/c.txt", kind: "file", bytes: text("c"), createdBy: ANA, mimeType: "text/plain" });
    const names = async (sort: "name" | "size" | "modified", dir: "asc" | "desc", extra: { limit?: number; offset?: number } = {}) => (await listChildren({ actor: ana, path: "/shared/Sorted", sort, dir, ...extra })).items.map((i) => i.name);
    assert.deepEqual(await names("name", "asc"), ["a.txt", "b.txt", "c.txt"]);
    assert.deepEqual(await names("name", "desc"), ["c.txt", "b.txt", "a.txt"]);
    assert.deepEqual(await names("size", "desc"), ["a.txt", "b.txt", "c.txt"]);
    assert.deepEqual(await names("size", "asc"), ["c.txt", "b.txt", "a.txt"]);
    assert.deepEqual(await names("name", "asc", { limit: 2 }), ["a.txt", "b.txt"]);
    assert.deepEqual(await names("name", "asc", { limit: 2, offset: 2 }), ["c.txt"]);
    const full = await listChildren({ actor: ana, path: "/shared/Sorted", limit: 2 });
    assert.equal(full.total, 3);
  });

  it("the Trash lists what a person trashed, a folder as one item, and restoring is theirs alone to see", async () => {
    await createFolderAs(ana, "/shared/Doomed");
    const a = await mk("/shared/Doomed/a.txt");
    await mk("/shared/Doomed/b.txt");
    const solo = await mk("/shared/solo.txt");
    await trashItemAs(ana, { kind: "file", id: solo.id });
    await trashItemAs(ana, { kind: "folder", id: await folderId("/shared/Doomed") });
    const trash = await listTrash(ben);
    assert.deepEqual(trash.map((t) => [t.kind, t.name]).sort(), [["file", "solo.txt"], ["folder", "Doomed"]].sort(), "the folder is one item; its files ride with it");
    // A private file in the trash is its owner's only.
    const priv = await mk(`/home/${ANA}/gone.txt`);
    await trashItemAs(ana, { kind: "file", id: priv.id });
    assert.ok((await listTrash(ana)).some((t) => t.name === "gone.txt"));
    assert.ok(!(await listTrash(adm)).some((t) => t.name === "gone.txt"));
    void a;
  });

  it("usage splits the workspace total from this person's home, and hides other people's homes", async () => {
    const u = await storageUsage(ben);
    assert.ok(u.workspace.usedBytes > 0);
    assert.ok(u.byArea.every((a) => a.area !== "other"));
    assert.ok(u.byArea.some((a) => a.area === "shared"));
  });

  it("recents are my own recent changes, live files only", async () => {
    const r = await recents(ana);
    assert.ok(r.length > 0);
    assert.ok(r.every((i) => i.kind === "file"));
    assert.ok(!r.some((i) => i.name === "solo.txt"), "trashed files are not in recents");
  });
});

describe("favourites", () => {
  it("favourites are personal, and quietly drop out when access is taken away", async () => {
    const f = await mk(`/home/${BEN}/mine.txt`, BEN);
    await setFavorite(ben, "file", f.id, true);
    await setFavorite(ana, "file", (await mk("/shared/fav.txt")).id, true);
    assert.deepEqual((await listFavorites(ben)).map((i) => i.name), ["mine.txt"]);
    assert.deepEqual((await listFavorites(ana)).map((i) => i.name), ["fav.txt"]);
    await assert.rejects(() => setFavorite(ana, "file", f.id, true), (e) => status(e) === 404, "you can't favourite what you can't see");
    // Share to Ana then take it away: the favourite goes with the access.
    await setFileAccess(ben, f.id, ANA, "viewer");
    await setFavorite(ana, "file", f.id, true);
    assert.equal((await listFavorites(ana)).some((i) => i.name === "mine.txt"), true);
    await setFileAccess(ben, f.id, ANA, null);
    assert.equal((await listFavorites(ana)).some((i) => i.name === "mine.txt"), false);
    await setFavorite(ben, "file", f.id, false);
    assert.deepEqual(await listFavorites(ben), []);
    const folder = await folderId("/shared/Finance");
    await setFavorite(ben, "folder", folder, true);
    assert.deepEqual((await listFavorites(ben)).map((i) => [i.kind, i.name, i.favorite]), [["folder", "Finance", true]]);
  });
});

describe("tags", () => {
  it("cleans tags: NFC, trimmed, de-duplicated ignoring case, no commas, bounded", () => {
    assert.deepEqual(cleanTags(" Q3 , q3,Invoice  2025 ,"), ["Q3", "Invoice 2025"]);
    assert.deepEqual(cleanTags(["Café", "Café"]), ["Café"]);
    assert.throws(() => cleanTags(["x".repeat(41)]), /at most 40/);
    assert.throws(() => cleanTags(Array.from({ length: 21 }, (_, i) => `t${i}`)), /At most 20/);
  });
  it("setting tags needs edit access; listing and filtering see only visible files", async () => {
    const f = await mk("/shared/tagged.txt");
    assert.deepEqual(await setFileTags(ana, f.id, "Q3, Invoice"), ["Q3", "Invoice"]);
    await assert.rejects(() => setFileTags(vic, f.id, "nope"), (e) => status(e) === 403);
    const secret = await mk(`/home/${ANA}/secret-tagged.txt`);
    await setFileTags(ana, secret.id, "Q3");
    assert.deepEqual((await listTags(ben)).find((t) => t.tag === "Q3"), { tag: "Q3", count: 1 });
    assert.equal((await listTags(ana)).find((t) => t.tag === "Q3")!.count, 2);
    assert.deepEqual((await filesWithTag(ben, "Q3")).map((i) => i.name), ["tagged.txt"]);
  });
});

describe("smart folders", () => {
  it("are saved Spotlight queries that belong to one person", async () => {
    const s = await saveSmartFolder(ana, { name: "Invoices this year", query: "invoice 2026", filters: { kind: "file" } });
    assert.deepEqual((await listSmartFolders(ana)).map((x) => [x.name, x.query, x.filters]), [["Invoices this year", "invoice 2026", { kind: "file" }]]);
    assert.deepEqual(await listSmartFolders(ben), []);
    await assert.rejects(() => deleteSmartFolder(ben, s.id), (e) => status(e) === 404);
    await deleteSmartFolder(ana, s.id);
    assert.deepEqual(await listSmartFolders(ana), []);
    await assert.rejects(() => saveSmartFolder(ana, { name: "", query: "x" }), /needs a name/);
  });
});
