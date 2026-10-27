// ShapesOS — Phase 18.2 (WS=content): Files against real Postgres + the real
// storage adapter.
//   - versions: an overwrite keeps the previous bytes; list / read / restore
//     (= a new version); quota counts every version; retention purges the
//     oldest (bytes and quota freed); a purge frees every version; Spotlight
//     re-indexes the new version's text
//   - per-file access: overrides narrow editors and never widen a viewer;
//     admins are never narrowed; only the file's owner / an admin manages it
//   - share links through the PUBLIC route handler (no session): view-only
//     can't download; password → 401 until the unlock cookie; wrong password
//     is refused; revoked / expired / trashed all 404; FORCE RLS fail-closed
//   - PDF annotations per version: editors add, viewers read, authors own
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/files/__tests__/files-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = mkdtempSync(join(tmpdir(), "p182-files-"));
process.env.AUTH_SECRET ??= "p182-files-db-test-secret-0123456789";

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { deleteFile, getQuota, trashFile, writeFile } from "@/lib/filesystem/service";
import { getStorageAdapter } from "@/lib/filesystem/storage";
import { listFileVersions, overwriteFile, readFileVersion, restoreFileVersion, setVersionRetention } from "@/lib/filesystem/versions";
import { listFileAccess, requireFileAction, setFileAccess, type FileActor } from "../access";
import { createShareLink, listShareLinks, revokeShareLink } from "../shares";
import { createAnnotation, exportAnnotations, listAnnotations, removeAnnotation } from "../annotations";
import { spotlight } from "@/lib/search/records";
import { indexFileText } from "@/lib/search/text-index";
import { GET as rawGET, POST as rawPOST } from "@/app/r/file/[token]/raw/route";

const RUN = randomUUID().slice(0, 8);
const WS = `p182f-${RUN}`;
const ANA = `p182f-ana-${RUN}`; // editor, uploads the file (its owner)
const BEN = `p182f-ben-${RUN}`; // editor
const VIC = `p182f-vic-${RUN}`; // viewer
const ADM = `p182f-adm-${RUN}`; // admin
const ana: FileActor = { workspaceId: WS, userId: ANA, role: "editor" };
const ben: FileActor = { workspaceId: WS, userId: BEN, role: "editor" };
const vic: FileActor = { workspaceId: WS, userId: VIC, role: "viewer" };
const adm: FileActor = { workspaceId: WS, userId: ADM, role: "admin" };

function makePdf(lines: string[]): Buffer {
  const ops = lines.map((l) => `BT (${l}) Tj ET`).join("\n") + "\n";
  const deflated = deflateSync(Buffer.from(ops, "latin1"));
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  return Buffer.concat([head, deflated, tail]);
}

const V1 = makePdf(["Quarterly plan, first draft. Codeword vellichor."]);
const V2 = makePdf(["Quarterly plan, second draft. Codeword pyrrhic."]);
let fileId = "";

function req(url: string, init?: { method?: string; body?: BodyInit; headers?: Record<string, string> }) {
  return new NextRequest(new URL(url, "http://localhost:3000"), init as never);
}
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ADM } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `ana-${RUN}@example.test`, name: "Ana" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `ben-${RUN}@example.test`, name: "Ben" },
      { workspaceId: WS, userId: VIC, role: "viewer", email: `vic-${RUN}@example.test`, name: "Vic" },
      { workspaceId: WS, userId: ADM, role: "admin", email: `adm-${RUN}@example.test`, name: "Adm" },
    ],
  });
  const f = await writeFile({ workspaceId: WS, logicalPath: "/files/plan.pdf", kind: "file", bytes: V1, mimeType: "application/pdf", createdBy: ANA });
  fileId = f.id;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("Files (DB)", () => {
  it("an overwrite keeps the previous bytes as a version; quota counts both; Spotlight re-indexes", async () => {
    const res = await overwriteFile({ workspaceId: WS, fileId, bytes: V2, mimeType: "application/pdf", userId: BEN });
    assert.equal(res.version, 2);
    // Two writers for the current version must both settle without a unique-key race.
    const indexed = await Promise.all([
      indexFileText(WS, fileId, { embed: false }),
      indexFileText(WS, fileId, { embed: false }),
    ]);
    assert.ok(indexed.every((r) => r.status === "indexed" || r.status === "unchanged"));
    const versions = await listFileVersions(WS, fileId);
    assert.deepEqual(versions!.map((v) => [v.version, v.current]), [[2, true], [1, false]]);
    assert.equal(versions![0]!.createdBy, BEN, "the current version is Ben's");
    assert.equal(versions![1]!.createdBy, ANA, "version 1 is Ana's");
    assert.deepEqual((await readFileVersion(WS, fileId, 1))!.bytes, V1);
    assert.deepEqual((await readFileVersion(WS, fileId, 2))!.bytes, V2);
    assert.equal((await getQuota({ workspaceId: WS })).usedBytes, V1.length + V2.length);
    const file = await prisma.workspaceFile.findFirst({ where: { id: fileId, workspaceId: WS } });
    assert.equal(file?.createdBy, ANA, "the file keeps its maker (its owner)");
    // The new version's text is searchable, the old one's no longer is.
    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      found = (await spotlight(WS, "viewer", "pyrrhic", { userId: ANA })).hits.some((h) => h.id === fileId);
      if (!found) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(found, "re-indexed after the new version");
    assert.ok(!(await spotlight(WS, "viewer", "vellichor", { userId: ANA })).hits.some((h) => h.id === fileId));
  });

  it("restore makes the old bytes a NEW version; history only grows", async () => {
    const res = await restoreFileVersion(WS, fileId, 1, ANA);
    assert.equal(res.version, 3);
    assert.deepEqual((await readFileVersion(WS, fileId, 3))!.bytes, V1);
    const versions = await listFileVersions(WS, fileId);
    assert.deepEqual(versions!.map((v) => v.version), [3, 2, 1]);
    await assert.rejects(restoreFileVersion(WS, fileId, 3, ANA), /already the current version/);
    await assert.rejects(restoreFileVersion(WS, fileId, 99, ANA), /not found/i);
    assert.equal(await readFileVersion("p182f-nope", fileId, 1), null, "another workspace reads nothing");
  });

  it("retention purges the oldest versions and frees their bytes and quota", async () => {
    const before = await withWorkspaceScope(WS, (tx) => tx.workspaceFileVersion.findMany({ where: { workspaceId: WS, fileId }, orderBy: { version: "asc" } }));
    assert.equal(before.length, 2);
    const res = await setVersionRetention(WS, 1);
    assert.equal(res.purged, 1);
    const after = await withWorkspaceScope(WS, (tx) => tx.workspaceFileVersion.findMany({ where: { workspaceId: WS, fileId } }));
    assert.deepEqual(after.map((v) => v.version), [2]);
    assert.equal(await getStorageAdapter().get(before[0]!.storageKey), null, "the purged version's bytes are gone");
    assert.equal((await getQuota({ workspaceId: WS })).usedBytes, V1.length + V2.length, "v3 (=V1 bytes) + v2 remain");
    await overwriteFile({ workspaceId: WS, fileId, bytes: V2, mimeType: "application/pdf", userId: ANA });
    assert.deepEqual((await listFileVersions(WS, fileId))!.map((v) => v.version), [4, 3], "an overwrite also applies the setting");
    await setVersionRetention(WS, 20);
  });

  it("per-file access: never wider than the workspace role; admins never narrowed; only owners manage", async () => {
    assert.equal((await requireFileAction(ana, fileId, "manageAccess")).role, "owner", "the editor who made it owns it");
    await assert.rejects(requireFileAction(ben, fileId, "manageAccess"), /owner or an admin/);
    await assert.rejects(setFileAccess(ben, fileId, VIC, "viewer"), /owner or an admin/);
    await setFileAccess(ana, fileId, BEN, "viewer");
    await assert.rejects(requireFileAction(ben, fileId, "version"), /doesn't allow/);
    assert.equal((await requireFileAction(ben, fileId, "download")).role, "viewer", "narrowed, still reads");
    await assert.rejects(setFileAccess(ana, fileId, VIC, "editor"), /more access than their workspace role/);
    await assert.rejects(setFileAccess(ana, fileId, ADM, "viewer"), /Admins and owners/);
    assert.equal((await requireFileAction(adm, fileId, "manageAccess")).role, "owner");
    await setFileAccess(ana, fileId, BEN, "owner");
    assert.equal((await requireFileAction(ben, fileId, "manageAccess")).role, "owner", "an editor can be made the file's owner");
    await setFileAccess(adm, fileId, BEN, null);
    const list = await listFileAccess(vic, fileId);
    assert.equal(list.canManage, false);
    assert.equal(list.entries.find((e) => e.userId === BEN)?.effective, "editor");
    assert.equal(await countWithoutScope("workspace_file_acls"), 0);
  });

  it("share links: view-only, password, revoke, expiry, trash — through the public route", async () => {
    await assert.rejects(createShareLink(vic, fileId, {}), /doesn't allow/, "a viewer can't share");
    const view = await createShareLink(ana, fileId, { access: "view", expiresInDays: 7, password: "open sesame" });
    assert.match(view.token, /^fsh_[0-9a-f]{32}$/);
    const stored = await withWorkspaceScope(WS, (tx) => tx.workspaceFileShare.findFirst({ where: { workspaceId: WS, id: view.link.id } }));
    assert.ok(stored && stored.tokenHash !== view.token && !JSON.stringify(stored).includes(view.token), "only the hash is stored");
    const tok = view.token;

    assert.equal((await rawGET(req(`/r/file/${tok}/raw`), ctx(tok))).status, 401, "password first");
    const wrong = await rawPOST(req(`/r/file/${tok}/raw`, { method: "POST", body: new URLSearchParams({ password: "nope" }), headers: { "content-type": "application/x-www-form-urlencoded" } }), ctx(tok));
    assert.equal(wrong.status, 303);
    assert.match(wrong.headers.get("location") ?? "", /\?e=1$/);
    assert.equal(wrong.headers.get("set-cookie"), null);
    const right = await rawPOST(req(`/r/file/${tok}/raw`, { method: "POST", body: new URLSearchParams({ password: "open sesame" }), headers: { "content-type": "application/x-www-form-urlencoded" } }), ctx(tok));
    assert.equal(right.status, 303);
    const cookie = (right.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(right.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Lax/);
    assert.match(right.headers.get("set-cookie") ?? "", new RegExp(`Path=/r/file/${tok}`));
    const ok = await rawGET(req(`/r/file/${tok}/raw`, { headers: { cookie } }), ctx(tok));
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-disposition") ?? "", /^inline/);
    assert.match(ok.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), V2, "the current version");
    assert.equal((await rawGET(req(`/r/file/${tok}/raw?save=1`, { headers: { cookie } }), ctx(tok))).status, 403, "view-only can't download");

    const dl = await createShareLink(ben, fileId, { access: "download", expiresInDays: 1 });
    const saved = await rawGET(req(`/r/file/${dl.token}/raw?save=1`), ctx(dl.token));
    assert.equal(saved.status, 200);
    assert.match(saved.headers.get("content-disposition") ?? "", /^attachment/);

    // Ana (the file's owner) revokes Ben's link; Vic can't.
    await assert.rejects(revokeShareLink(vic, fileId, dl.link.id), /maker|owner/);
    await revokeShareLink(ana, fileId, dl.link.id);
    assert.equal((await rawGET(req(`/r/file/${dl.token}/raw?save=1`), ctx(dl.token))).status, 404, "revoked looks gone");
    // Expired.
    await withWorkspaceScope(WS, (tx) => tx.workspaceFileShare.update({ where: { id: view.link.id, workspaceId: WS }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    assert.equal((await rawGET(req(`/r/file/${tok}/raw`, { headers: { cookie } }), ctx(tok))).status, 404, "expired looks gone");
    // Unknown / malformed.
    assert.equal((await rawGET(req(`/r/file/fsh_${"0".repeat(32)}/raw`), ctx(`fsh_${"0".repeat(32)}`))).status, 404);
    assert.equal((await rawGET(req("/r/file/nope/raw"), ctx("nope"))).status, 404);
    // Trashed file.
    const third = await createShareLink(ana, fileId, { access: "download" });
    assert.equal((await rawGET(req(`/r/file/${third.token}/raw`), ctx(third.token))).status, 200);
    await trashFile({ workspaceId: WS, fileId });
    assert.equal((await rawGET(req(`/r/file/${third.token}/raw`), ctx(third.token))).status, 404, "a trashed file's link 404s");
    await prisma.workspaceFile.update({ where: { id: fileId }, data: { trashedAt: null } });

    const listed = await listShareLinks(ana, fileId);
    assert.deepEqual(listed.links.map((l) => l.state).sort(), ["expired", "live", "revoked"]);
    assert.equal((await listShareLinks(vic, fileId)).canShare, false);
    assert.equal(await countWithoutScope("workspace_file_shares"), 0, "FORCE RLS: nothing without the GUC");
    const stats = await withWorkspaceScope(WS, (tx) => tx.workspaceFileShare.findFirst({ where: { workspaceId: WS, id: view.link.id } }));
    assert.equal(stats?.openCount, 0, "byte requests aren't counted as opens (the viewer page counts)");
  });

  it("PDF annotations per version: editors add, viewers read, authors own; exported as JSON", async () => {
    const current = (await listFileVersions(WS, fileId))![0]!.version;
    const a = await createAnnotation(ana, fileId, { page: 1, kind: "highlight", rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.03 }], quote: "Quarterly plan" });
    const c = await createAnnotation(ana, fileId, { version: current - 1, page: 1, kind: "comment", rects: [{ x: 0.1, y: 0.2, w: 0.2, h: 0.03 }], body: "Check this on the old draft" });
    await assert.rejects(createAnnotation(vic, fileId, { page: 1, kind: "highlight", rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] }), /doesn't allow/);
    await assert.rejects(createAnnotation(ana, fileId, { page: 1, kind: "comment", rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }], body: " " }), /needs text/);
    assert.deepEqual((await listAnnotations(vic, fileId)).map((x) => x.id), [a.id], "the current version's only");
    assert.deepEqual((await listAnnotations(vic, fileId, current - 1)).map((x) => x.id), [c.id]);
    await assert.rejects(removeAnnotation(ben, fileId, a.id), /author or the file's owner/);
    const doc = await exportAnnotations(vic, fileId);
    assert.equal(doc.annotations.length, 2);
    await removeAnnotation(adm, fileId, c.id);
    assert.equal((await exportAnnotations(vic, fileId)).annotations.length, 1);
    assert.equal(await countWithoutScope("workspace_file_annotations"), 0);
    assert.equal(await countWithoutScope("workspace_file_versions"), 0);
  });

  it("a purge frees the file and every version", async () => {
    await trashFile({ workspaceId: WS, fileId });
    await deleteFile({ workspaceId: WS, fileId });
    assert.equal((await getQuota({ workspaceId: WS })).usedBytes, 0);
    assert.equal(await withWorkspaceScope(WS, (tx) => tx.workspaceFileVersion.count({ where: { workspaceId: WS } })), 0);
  });
});
