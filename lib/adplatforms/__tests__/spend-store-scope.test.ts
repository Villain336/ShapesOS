// ShapesOS — Phase 1 (H2) DB test: the Prisma spend-gate stores are
// workspace-scoped. spend_proposals / spend_approvals have NO RLS, so the
// store's own `where` is the only tenant boundary.
// Run: npx tsx --test lib/adplatforms/__tests__/spend-store-scope.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import {
  AdsGateError,
  approveSpendAction,
  proposeSpendAction,
  rejectSpendAction,
} from "../gate";
import { prismaApprovalStore, prismaProposalStore } from "../store";

const WS_A = "p1b-spend-a";
const WS_B = "p1b-spend-b";

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({ data: { id, name: `p1b ${id}`, ownerUserId: `${id}-owner` } });
  }
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

async function proposalInB() {
  return proposeSpendAction(prismaProposalStore(), {
    workspaceId: WS_B,
    kind: "launch",
    action: "launch",
    targetType: "campaign",
    targetId: "camp_b",
    payload: { campaignId: "camp_b", budgetCents: 1000 },
    proposedBy: "user_b",
  });
}

describe("spend proposal store — workspace scoping (H2)", () => {
  it("get() hides another workspace's proposal", async () => {
    const p = await proposalInB();
    assert.equal(await prismaProposalStore().get(p.id, WS_A), null);
    assert.equal((await prismaProposalStore().get(p.id, WS_B))?.id, p.id);
  });

  it("setStatus() cannot touch another workspace's proposal", async () => {
    const p = await proposalInB();
    await assert.rejects(
      () => prismaProposalStore().setStatus(p.id, WS_A, "rejected", "user_a"),
      (e: unknown) => e instanceof AdsGateError && e.code === "PROPOSAL_NOT_FOUND",
    );
    const row = await prisma.spendProposal.findUnique({ where: { id: p.id } });
    assert.equal(row?.status, "pending");
  });

  it("an editor in A cannot approve or reject B's proposal by id", async () => {
    const p = await proposalInB();
    await assert.rejects(
      () => approveSpendAction(prismaProposalStore(), prismaApprovalStore(), WS_A, p.id, "user_a"),
      (e: unknown) => e instanceof AdsGateError && e.code === "PROPOSAL_NOT_FOUND",
    );
    await assert.rejects(
      () => rejectSpendAction(prismaProposalStore(), WS_A, p.id, "user_a"),
      (e: unknown) => e instanceof AdsGateError && e.code === "PROPOSAL_NOT_FOUND",
    );
    const row = await prisma.spendProposal.findUnique({ where: { id: p.id } });
    assert.equal(row?.status, "pending");
    assert.equal(await prisma.spendApproval.count({ where: { proposalId: p.id } }), 0);
  });

  it("B's own editor can still approve, and the approval is invisible from A", async () => {
    const p = await proposalInB();
    const { proposal, approval } = await approveSpendAction(
      prismaProposalStore(),
      prismaApprovalStore(),
      WS_B,
      p.id,
      "user_b2",
    );
    assert.equal(proposal.status, "approved");
    assert.equal(approval.workspaceId, WS_B);
    assert.equal(await prismaApprovalStore().getByProposalId(p.id, WS_A), null);
    assert.equal((await prismaApprovalStore().getByProposalId(p.id, WS_B))?.id, approval.id);
  });
});
