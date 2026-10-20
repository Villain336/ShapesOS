// ShapesOS — Phase 21B (WS=drive): a person whose id is not a plain slug — the self-host admin login is
// "admin:<email>" — still gets a working private home (found by the first browser smoke, which signs in
// as that admin): the folder name is the reversible encoding of the id, the file is owned by the person,
// nobody else sees it, and the journal shows it only to them.
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/home-ids-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = mkdtempSync(join(tmpdir(), "p21b-homeid-"));
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { homePathOf } from "@/lib/filesystem/paths";
import { listChildren, listRoots } from "@/lib/drive/tree";
import { createFolderAs, writeFileAs } from "@/lib/drive/ops";
import { listChanges } from "@/lib/drive/changes";

const RUN = randomUUID().slice(0, 8);
const WS = `p21hi-${RUN}`;
const ADMIN = `admin:Boss-${RUN}@Example.com`;
const BEN = `p21hi-ben-${RUN}`;
const admin = { workspaceId: WS, userId: ADMIN, role: "owner" as const };
const ben = { workspaceId: WS, userId: BEN, role: "editor" as const };

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ADMIN } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ADMIN, role: "owner", email: `boss-${RUN}@example.com`, name: "Boss" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `ben-${RUN}@example.com`, name: "Ben" },
    ],
  });
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("a home for an id like admin:<email>", () => {
  it("lists the roots and creates the home", async () => {
    const roots = await listRoots(admin);
    assert.equal(roots.find((r) => r.key === "home")?.path, homePathOf(ADMIN));
    assert.match(homePathOf(ADMIN), /^\/home\/[a-z0-9_-]+$/);
  });

  it("stores a file in the home, owned by the person, and lists it", async () => {
    await createFolderAs(admin, `${homePathOf(ADMIN)}/Taxes`);
    const { file } = await writeFileAs(admin, { dir: `${homePathOf(ADMIN)}/Taxes`, filename: "return.txt", bytes: Buffer.from("mine"), mimeType: "text/plain" });
    assert.equal(file.ownerUserId, ADMIN);
    const listing = await listChildren({ actor: admin, path: `${homePathOf(ADMIN)}/Taxes`, sort: "name", dir: "asc" });
    assert.deepEqual(listing.items.map((i) => i.name), ["return.txt"]);
  });

  it("is invisible to another member, in the listing and in the journal", async () => {
    await assert.rejects(() => listChildren({ actor: ben, path: `${homePathOf(ADMIN)}/Taxes`, sort: "name", dir: "asc" }), (e: unknown) => (e as { status?: number }).status === 404);
    const mine = await listChanges({ workspaceId: WS, viewerUserId: ADMIN, cursor: null, limit: 100 });
    const theirs = await listChanges({ workspaceId: WS, viewerUserId: BEN, cursor: null, limit: 100 });
    assert.ok(mine.changes.some((c) => c.path?.endsWith("/return.txt")));
    assert.ok(!theirs.changes.some((c) => c.path?.includes("return.txt") || c.path?.startsWith(homePathOf(ADMIN))));
  });
});
