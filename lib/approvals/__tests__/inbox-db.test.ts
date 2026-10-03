// ShapesOS — Phase 3 (J) DB test: the unified inbox against real Postgres.
// Run as the least-privilege app role (FORCE RLS applies), it proves the
// RLS-protected queues (mission, report send, tool action) are read inside
// the tenant scope, that nothing from another workspace leaks, and that the
// role gates hold end to end (resolveInboxViewer → loadInbox → countInbox).
// Run: npx tsx --test lib/approvals/__tests__/inbox-db.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { countInbox, loadInbox, resolveInboxViewer } from "../inbox";

const A = "p3j-inbox-a";
const B = "p3j-inbox-b";
const OWNER = "p3j-inbox-owner";
const EDITOR = "p3j-inbox-editor";
const VIEWER = "p3j-inbox-viewer";
const B_OWNER = "p3j-inbox-b-owner";
const LATER = () => new Date(Date.now() + 86_400_000);

async function seed(ws: string, tag: string) {
  await withWorkspaceScope(ws, async (tx) => {
    await tx.missionApproval.create({
      data: { id: `${tag}-mission`, workspaceId: ws, action: "send_email", tier: 2, bindingJson: {}, bindingHash: "h", expiresAt: LATER(), createdBy: EDITOR },
    });
    await tx.reportSendApproval.create({
      data: { id: `${tag}-report`, workspaceId: ws, templateName: "monthly", templateVersion: "1.0.0", clientName: "Acme", period: "Sep", payload: {}, createdBy: EDITOR },
    });
    await tx.composioActionApproval.create({
      data: {
        id: `${tag}-tool`,
        workspaceId: ws,
        appKey: "slack",
        toolName: "SLACK_SEND_MESSAGE",
        riskTier: "high",
        proposedArgs: {},
        plainSummary: "Post to #general",
        expiresAt: LATER(),
        auditTrail: [{ at: new Date().toISOString(), actor: EDITOR, event: "proposed" }],
      },
    });
  });
  await prisma.approvalItem.createMany({
    data: [
      { id: `${tag}-msg`, workspaceId: ws, kind: "sequence_send", payload: { subject: "Hi" }, requestedBy: EDITOR },
      { id: `${tag}-ins`, workspaceId: ws, kind: "insurance_bind_policy", payload: {}, requestedBy: EDITOR },
      { id: `${tag}-msg-done`, workspaceId: ws, kind: "sequence_send", payload: {}, status: "approved" },
    ],
  });
  await prisma.spendProposal.create({
    data: { id: `${tag}-spend`, workspaceId: ws, kind: "launch", action: "launch", targetType: "campaign", targetId: "c1", payload: {}, scopeHash: "s", proposedBy: "agent:ads", expiresAt: LATER() },
  });
  await prisma.mediaApproval.create({
    data: { id: `${tag}-media`, workspaceId: ws, type: "buy", status: "pending", bindingJson: { platform: "meta" }, bindingHash: "b", maxSpendCents: 5000, createdBy: EDITOR },
  });
}

before(async () => {
  for (const id of [A, B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: A, name: A, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: B, name: B, ownerUserId: B_OWNER } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: A, userId: OWNER, role: "owner", name: "Olive Owner" },
      { workspaceId: A, userId: EDITOR, role: "editor", name: "Eddie Editor" },
      { workspaceId: A, userId: VIEWER, role: "viewer" },
      { workspaceId: B, userId: B_OWNER, role: "owner" },
    ],
  });
  await seed(A, "a");
  await seed(B, "b");
});

after(async () => {
  for (const id of [A, B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("approvals inbox (DB): scoping + role rules", () => {
  it("an owner sees every pending queue of their workspace, none of the other's", async () => {
    const viewer = await resolveInboxViewer(OWNER, A);
    assert.ok(viewer);
    assert.equal(viewer.role, "owner");
    const res = await loadInbox(viewer);
    assert.deepEqual(res.errors, []);
    const ids = res.items.map((i) => i.id).sort();
    assert.deepEqual(ids, ["a-ins", "a-media", "a-mission", "a-msg", "a-report", "a-spend", "a-tool"]);
    // RLS-protected queues came back => they were read inside the tenant scope.
    for (const source of ["mission", "report", "integration"]) {
      assert.ok(res.items.some((i) => i.source === source), `${source} visible through RLS`);
    }
    assert.equal(res.items.find((i) => i.id === "a-msg")!.requester, "Eddie Editor");
  });

  it("the other workspace's owner sees only theirs", async () => {
    const res = await loadInbox((await resolveInboxViewer(B_OWNER, B))!);
    assert.ok(res.items.length > 0);
    assert.ok(res.items.every((i) => i.id.startsWith("b-")));
  });

  it("a viewer sees viewer-readable queues only and can decide nothing", async () => {
    const viewer = (await resolveInboxViewer(VIEWER, A))!;
    const res = await loadInbox(viewer);
    const sources = new Set(res.items.map((i) => i.source));
    assert.ok(!sources.has("spend"));
    assert.ok(!sources.has("insurance"));
    assert.ok(sources.has("mission"));
    assert.equal(res.actionable, 0);
    const counts = await countInbox(viewer);
    assert.equal(counts.actionable, 0);
    assert.equal(counts.total, res.total);
  });

  it("the requester of a tool action can't decide it (another approver exists); media buys need admin", async () => {
    const viewer = (await resolveInboxViewer(EDITOR, A))!;
    assert.equal(viewer.hasOtherApprover, true);
    const res = await loadInbox(viewer);
    const by = (id: string) => res.items.find((i) => i.id === id)!;
    assert.equal(by("a-tool").canDecide, false);
    assert.equal(by("a-media").canDecide, false);
    assert.equal(by("a-msg").canDecide, true);
    assert.equal(by("a-spend").canDecide, true);
  });

  it("non-members get no viewer at all", async () => {
    assert.equal(await resolveInboxViewer(B_OWNER, A), null);
  });
});
