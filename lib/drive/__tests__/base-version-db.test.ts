// ShapesOS — Phase 21B (WS=drive): the sync precondition. A write that names the version it started
// from is refused (stale_version, with the server's current version) when someone else got there first,
// and when the file was moved or trashed meanwhile; nothing is written and no blob is left behind.
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/base-version-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "p21b-base-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = STORE;
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { FsError } from "@/lib/filesystem/core";
import { writeFileAs } from "@/lib/drive/ops";
import { trashFile } from "@/lib/filesystem/service";
import type { FileActor } from "@/lib/files/access";

const RUN = randomUUID().slice(0, 8);
const WS = `p21bv-${RUN}`;
const ANA = `p21bv-ana-${RUN}`;
const ana: FileActor = { workspaceId: WS, userId: ANA, role: "editor" };
const text = (s: string) => Buffer.from(s, "utf8");
const count = () => readdirSync(STORE, { recursive: true }).length;

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: ANA, role: "editor", email: `ana-${RUN}@example.test`, name: "Ana" } });
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("baseVersion", () => {
  const dir = `/shared/files`;
  it("replaces when the file is still at the version the client started from, without 'replace'", async () => {
    const a = await writeFileAs(ana, { dir, filename: "plan.txt", bytes: text("v1"), mimeType: "text/plain" });
    assert.equal(a.version, 1);
    const b = await writeFileAs(ana, { dir, filename: "plan.txt", bytes: text("v2"), mimeType: "text/plain", baseVersion: 1 });
    assert.equal(b.created, false);
    assert.equal(b.version, 2);
  });

  it("refuses a stale write with the current version, writes nothing and leaves no blob", async () => {
    const before = count();
    await assert.rejects(
      () => writeFileAs(ana, { dir, filename: "plan.txt", bytes: text("from an old copy"), mimeType: "text/plain", baseVersion: 1 }),
      (e: unknown) => e instanceof FsError && e.code === "stale_version" && e.meta?.currentVersion === 2,
    );
    assert.equal(count(), before, "the rejected blob was removed");
    const row = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: "/files/plan.txt" } });
    assert.equal(row.version, 2);
  });

  it("refuses when the file was trashed meanwhile (currentVersion null)", async () => {
    const f = await writeFileAs(ana, { dir, filename: "gone.txt", bytes: text("x"), mimeType: "text/plain" });
    await trashFile({ workspaceId: WS, fileId: f.file.id, actorUserId: ANA });
    await assert.rejects(
      () => writeFileAs(ana, { dir, filename: "gone.txt", bytes: text("y"), mimeType: "text/plain", baseVersion: 1 }),
      (e: unknown) => e instanceof FsError && e.code === "stale_version" && e.meta?.currentVersion === null,
    );
  });

  it("without baseVersion nothing changes: an existing file is still a conflict unless replace is set", async () => {
    await assert.rejects(() => writeFileAs(ana, { dir, filename: "plan.txt", bytes: text("z"), mimeType: "text/plain" }), (e: unknown) => e instanceof FsError && e.code === "conflict");
  });
});
