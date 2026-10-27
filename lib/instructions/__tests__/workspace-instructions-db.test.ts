// ShapesOS - Phase 25: shared workspace instructions against real Postgres
// (least-privilege app role; RLS meaningful).
//   - first save is revision 1; later saves append (history kept, never edited)
//   - a stale expectedRevision is rejected (no silent overwrite)
//   - two concurrent saves from the same revision: exactly one wins
//   - another workspace never sees these instructions or revisions
//   - the app role cannot UPDATE or DELETE a revision (append-only)
//   - loadInstructionsBlock returns "" when unset and the framed text when set
// This covers the data layer only; route-level admin/viewer checks are in the
// e2e spec (admin PUT/GET and signed-out 401) and not tested for a viewer.
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  InstructionsConflictError,
  getInstructions,
  listInstructionRevisions,
  loadInstructionsBlock,
  setInstructions,
} from "../workspace-instructions";

const RUN = randomUUID().slice(0, 8);
const WS_A = `p25a-${RUN}`;
const WS_B = `p25b-${RUN}`;
const USER = `p25-user-${RUN}`;

before(async () => {
  for (const ws of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id: ws } });
  for (const ws of [WS_A, WS_B]) await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: USER } });
});
after(async () => {
  for (const ws of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id: ws } });
  await prisma.$disconnect();
});

describe("workspace instructions (DB)", () => {
  it("is empty before any save", async () => {
    const cur = await getInstructions(WS_A);
    assert.equal(cur.revision, 0);
    assert.equal(cur.body, "");
    assert.equal(await loadInstructionsBlock(WS_A), "");
  });

  it("appends revisions and keeps history; stale saves are rejected", async () => {
    const r1 = await setInstructions({ workspaceId: WS_A, userId: USER, userLabel: "a@x.test", body: "Be concise.", expectedRevision: 0 });
    assert.equal(r1.revision, 1);
    const r2 = await setInstructions({ workspaceId: WS_A, userId: USER, userLabel: "a@x.test", body: "Be concise. Cite sources.", expectedRevision: 1 });
    assert.equal(r2.revision, 2);
    await assert.rejects(setInstructions({ workspaceId: WS_A, userId: USER, body: "stale", expectedRevision: 1 }), InstructionsConflictError);
    const revs = await listInstructionRevisions(WS_A);
    assert.deepEqual(revs.map((r) => r.revision), [2, 1]);
    assert.equal(revs[1].body, "Be concise.");
    assert.equal(revs[0].createdBy, "a@x.test");
    const block = await loadInstructionsBlock(WS_A);
    assert.ok(block.includes("Cite sources.") && block.startsWith("## SHARED WORKSPACE INSTRUCTIONS"));
  });

  it("two concurrent saves from the same revision: exactly one wins", async () => {
    const cur = await getInstructions(WS_A);
    const results = await Promise.allSettled([
      setInstructions({ workspaceId: WS_A, userId: USER, body: "writer one", expectedRevision: cur.revision }),
      setInstructions({ workspaceId: WS_A, userId: USER, body: "writer two", expectedRevision: cur.revision }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof InstructionsConflictError);
  });

  it("clearing the text is a revision; the block is then empty", async () => {
    const cur = await getInstructions(WS_A);
    await setInstructions({ workspaceId: WS_A, userId: USER, body: "  ", expectedRevision: cur.revision });
    assert.equal(await loadInstructionsBlock(WS_A), "");
  });

  it("another workspace sees nothing, and the over-length text is refused", async () => {
    assert.equal((await getInstructions(WS_B)).revision, 0);
    assert.equal((await listInstructionRevisions(WS_B)).length, 0);
    await assert.rejects(setInstructions({ workspaceId: WS_B, userId: USER, body: "x".repeat(4001), expectedRevision: 0 }), /INSTRUCTIONS_TOO_LONG/);
  });

  it("the app role cannot rewrite or delete history", async () => {
    const n = await withWorkspaceScope(WS_A, (tx) => tx.workspaceInstructionRevision.updateMany({ where: { workspaceId: WS_A }, data: { body: "tampered" } }));
    assert.equal(n.count, 0, "no UPDATE policy: zero rows affected");
    const d = await withWorkspaceScope(WS_A, (tx) => tx.workspaceInstructionRevision.deleteMany({ where: { workspaceId: WS_A } }));
    assert.equal(d.count, 0, "no DELETE policy: zero rows affected");
    assert.ok((await listInstructionRevisions(WS_A)).length >= 3);
  });
});
