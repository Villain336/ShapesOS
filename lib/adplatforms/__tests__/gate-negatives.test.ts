// Marketr — Phase 18 slice 1 tests: spend-gate bypass negatives.
// Run: npx tsx --test lib/adplatforms/__tests__/gate-negatives.test.ts
//
// Proves the ad-spend gate fails CLOSED: there is NO execution path that
// launches, pauses, or changes budget without an approved, unexpired,
// scope-hash-matching SpendApproval. Every bypass attempt throws
// AdsGateError and the executor callback never runs.
//
// Pure: in-memory stub stores. No live database.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  AdsGateError,
  approveSpendAction,
  executeSpendAction,
  proposeBudgetChange,
  proposeSpendAction,
  rejectSpendAction,
  type SpendApproval,
  type SpendApprovalStore,
  type SpendProposal,
  type SpendProposalStatus,
  type SpendProposalStore,
} from "../gate";

const WS = "ws_neg";
const ACTOR = "user_neg";
const PAYLOAD: Record<string, unknown> = {
  campaignId: "camp_1",
  budgetCents: 50000,
  flightStart: "2026-10-15",
  flightEnd: "2026-11-15",
};

type Ctx = ReturnType<typeof stubStores>;

function stubStores() {
  const proposals = new Map<string, SpendProposal>();
  const approvals = new Map<string, SpendApproval>();
  let n = 0;
  const proposalStore: SpendProposalStore = {
    async create(input) {
      const p: SpendProposal = {
        id: `prop_${++n}`,
        workspaceId: input.workspaceId,
        kind: input.kind,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        payload: input.payload,
        scopeHash: input.scopeHash,
        status: "pending",
        proposedBy: input.proposedBy,
        proposedAt: new Date(),
        decidedBy: null,
        decidedAt: null,
        expiresAt: input.expiresAt,
      };
      proposals.set(p.id, p);
      return p;
    },
    async get(id, ws) {
      const p = proposals.get(id);
      return p && p.workspaceId === ws ? p : null;
    },
    async setStatus(id, _ws: string, status: SpendProposalStatus, decidedBy?: string) {
      const p = proposals.get(id);
      if (!p) throw new Error("missing proposal");
      const next = {
        ...p,
        status,
        decidedBy: decidedBy ?? null,
        decidedAt: decidedBy ? new Date() : null,
      };
      proposals.set(id, next);
      return next;
    },
  };
  const approvalStore: SpendApprovalStore = {
    async create(input) {
      const a: SpendApproval = {
        id: `appr_${++n}`,
        workspaceId: input.workspaceId,
        proposalId: input.proposalId,
        approver: input.approver,
        decidedAt: new Date(),
        scopeHash: input.scopeHash,
      };
      approvals.set(input.proposalId, a);
      return a;
    },
    async getByProposalId(proposalId, ws) {
      const a = approvals.get(proposalId);
      return a && a.workspaceId === ws ? a : null;
    },
  };
  return { proposals, approvals, proposalStore, approvalStore };
}

async function pendingLaunch(ctx: Ctx, payload: Record<string, unknown> = PAYLOAD) {
  return proposeSpendAction(ctx.proposalStore, {
    workspaceId: WS,
    kind: "launch",
    action: "launch",
    targetType: "campaign",
    targetId: "camp_1",
    payload,
    proposedBy: ACTOR,
  });
}

async function tryExecute(
  ctx: Ctx,
  proposalId: string,
  payload: Record<string, unknown>,
): Promise<{ executed: boolean; error: unknown }> {
  let executed = false;
  try {
    await executeSpendAction(
      ctx.proposalStore,
      ctx.approvalStore,
      { workspaceId: WS, proposalId, payload },
      async () => {
        executed = true;
      },
    );
    return { executed, error: null };
  } catch (error) {
    return { executed, error };
  }
}

function gateCode(error: unknown): string {
  assert.ok(error instanceof AdsGateError, "expected AdsGateError");
  return error.code;
}

describe("spend gate negatives — no execution path without SpendApproval", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = stubStores();
  });

  it("refuses a merely-pending proposal (no approval exists)", async () => {
    const p = await pendingLaunch(ctx);
    const { executed, error } = await tryExecute(ctx, p.id, PAYLOAD);
    assert.equal(executed, false, "executor must never run without approval");
    assert.equal(gateCode(error), "NOT_APPROVED");
  });

  it("refuses a rejected proposal", async () => {
    const p = await pendingLaunch(ctx);
    await rejectSpendAction(ctx.proposalStore, WS, p.id, ACTOR);
    const { executed, error } = await tryExecute(ctx, p.id, PAYLOAD);
    assert.equal(executed, false);
    assert.equal(gateCode(error), "NOT_APPROVED");
  });

  it("refuses when the execution payload differs from the approved scope (TOCTOU)", async () => {
    const p = await pendingLaunch(ctx);
    await approveSpendAction(ctx.proposalStore, ctx.approvalStore, WS, p.id, ACTOR);
    // "Approve $500, execute $50,000" — different payload, different hash.
    const tampered = { ...PAYLOAD, budgetCents: 5_000_000 };
    const { executed, error } = await tryExecute(ctx, p.id, tampered);
    assert.equal(executed, false);
    assert.equal(gateCode(error), "SCOPE_HASH_MISMATCH");
  });

  it("refuses when the approval row is missing even though the proposal reads approved", async () => {
    // Simulates a corrupted/rolled-back approval store: proposal flipped to
    // approved without a SpendApproval row ever being minted.
    const p = await pendingLaunch(ctx);
    await ctx.proposalStore.setStatus(p.id, WS, "approved", ACTOR);
    const { executed, error } = await tryExecute(ctx, p.id, PAYLOAD);
    assert.equal(executed, false);
    assert.equal(gateCode(error), "APPROVAL_MISSING");
  });

  it("refuses replay: an already-executed proposal cannot execute twice", async () => {
    const p = await pendingLaunch(ctx);
    await approveSpendAction(ctx.proposalStore, ctx.approvalStore, WS, p.id, ACTOR);
    const first = await tryExecute(ctx, p.id, PAYLOAD);
    assert.equal(first.executed, true, "first execution runs");
    assert.equal(first.error, null);
    const second = await tryExecute(ctx, p.id, PAYLOAD);
    assert.equal(second.executed, false, "replay must not run the executor again");
    assert.equal(gateCode(second.error), "ALREADY_EXECUTED");
  });

  it("refuses an expired proposal even with a valid approval", async () => {
    const p = await pendingLaunch(ctx);
    await approveSpendAction(ctx.proposalStore, ctx.approvalStore, WS, p.id, ACTOR);
    // Age the proposal past expiry.
    const stored = ctx.proposals.get(p.id)!;
    ctx.proposals.set(p.id, { ...stored, expiresAt: new Date(Date.now() - 1000) });
    const { executed, error } = await tryExecute(ctx, p.id, PAYLOAD);
    assert.equal(executed, false);
    assert.equal(gateCode(error), "PROPOSAL_EXPIRED");
  });

  it("refuses a workspace-mismatched execution", async () => {
    const p = await pendingLaunch(ctx);
    await approveSpendAction(ctx.proposalStore, ctx.approvalStore, WS, p.id, ACTOR);
    let executed = false;
    await assert.rejects(
      () =>
        executeSpendAction(
          ctx.proposalStore,
          ctx.approvalStore,
          { workspaceId: "ws_attacker", proposalId: p.id, payload: PAYLOAD },
          async () => {
            executed = true;
          },
        ),
      // The workspace-scoped store hides the foreign proposal entirely.
      (e: unknown) =>
        e instanceof AdsGateError && (e.code === "PROPOSAL_NOT_FOUND" || e.code === "WORKSPACE_MISMATCH"),
    );
    assert.equal(executed, false);
  });

  it("refuses to approve or reject another workspace's proposal (H2)", async () => {
    const p = await pendingLaunch(ctx);
    await assert.rejects(
      () => approveSpendAction(ctx.proposalStore, ctx.approvalStore, "ws_attacker", p.id, "user_attacker"),
      (e: unknown) => e instanceof AdsGateError && e.code === "PROPOSAL_NOT_FOUND",
    );
    await assert.rejects(
      () => rejectSpendAction(ctx.proposalStore, "ws_attacker", p.id, "user_attacker"),
      (e: unknown) => e instanceof AdsGateError && e.code === "PROPOSAL_NOT_FOUND",
    );
    const stored = ctx.proposals.get(p.id)!;
    assert.equal(stored.status, "pending", "victim proposal untouched");
    assert.equal(stored.decidedBy, null);
  });

  it("refuses a foreign proposal even when a store ignores workspaceId (defense in depth)", async () => {
    const p = await pendingLaunch(ctx);
    const leaky: SpendProposalStore = {
      ...ctx.proposalStore,
      get: async (id) => ctx.proposals.get(id) ?? null,
    };
    await assert.rejects(
      () => approveSpendAction(leaky, ctx.approvalStore, "ws_attacker", p.id, "user_attacker"),
      (e: unknown) => e instanceof AdsGateError && e.code === "PROPOSAL_NOT_FOUND",
    );
    await assert.rejects(
      () => rejectSpendAction(leaky, "ws_attacker", p.id, "user_attacker"),
      (e: unknown) => e instanceof AdsGateError && e.code === "PROPOSAL_NOT_FOUND",
    );
    assert.equal(ctx.proposals.get(p.id)!.status, "pending");
  });

  it("refuses to approve an already-approved proposal (no double approvals)", async () => {
    const p = await pendingLaunch(ctx);
    await approveSpendAction(ctx.proposalStore, ctx.approvalStore, WS, p.id, ACTOR);
    await assert.rejects(
      () => approveSpendAction(ctx.proposalStore, ctx.approvalStore, WS, p.id, "user_other"),
      (e: unknown) => e instanceof AdsGateError && e.code === "ALREADY_DECIDED",
    );
  });

  it("budget changes always mint a NEW proposal — never mutate in place", async () => {
    const p = await pendingLaunch(ctx);
    await approveSpendAction(ctx.proposalStore, ctx.approvalStore, WS, p.id, ACTOR);
    const budgetProposal = await proposeBudgetChange(ctx.proposalStore, {
      workspaceId: WS,
      targetType: "campaign",
      targetId: "camp_1",
      payload: { campaignId: "camp_1", budgetCents: 75000 },
      proposedBy: ACTOR,
    });
    assert.notEqual(budgetProposal.id, p.id, "budget change must be a new proposal");
    assert.equal(budgetProposal.kind, "budget_change");
    assert.equal(budgetProposal.action, "adjust_budget");
    assert.equal(budgetProposal.status, "pending");
    // The new proposal cannot execute until IT is approved too.
    const { executed, error } = await tryExecute(ctx, budgetProposal.id, {
      campaignId: "camp_1",
      budgetCents: 75000,
    });
    assert.equal(executed, false);
    assert.equal(gateCode(error), "NOT_APPROVED");
  });

  it("refuses execution of a nonexistent proposal", async () => {
    const { executed, error } = await tryExecute(ctx, "prop_nope", PAYLOAD);
    assert.equal(executed, false);
    assert.equal(gateCode(error), "PROPOSAL_NOT_FOUND");
  });
});
