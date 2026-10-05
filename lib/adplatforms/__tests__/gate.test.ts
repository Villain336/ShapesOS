// Marketr — Phase 18 slice 1 tests: spend-gate happy path.
// Run: npx tsx --test lib/adplatforms/__tests__/gate.test.ts
//
// The full propose → approve → execute lifecycle, plus scope-hash binding
// and the governed-action catalog. Pure: in-memory stub stores.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  approveSpendAction,
  executeSpendAction,
  proposeBudgetChange,
  proposeSpendAction,
  rejectSpendAction,
  scopeHashFor,
  type SpendApproval,
  type SpendApprovalStore,
  type SpendProposal,
  type SpendProposalStatus,
  type SpendProposalStore,
} from "../gate";
import { ADS_GOVERNED_ACTIONS, ADS_PLATFORMS, adsActionDef } from "../types";

const WS = "ws_happy";
const ACTOR = "user_happy";
const PAYLOAD: Record<string, unknown> = {
  campaignId: "camp_9",
  platformKey: "amazon",
  budgetCents: 100000,
  flightStart: "2026-11-01",
  flightEnd: "2026-12-01",
};

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
      const p = proposals.get(id)!;
      const next = { ...p, status, decidedBy: decidedBy ?? null, decidedAt: new Date() };
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
  return { proposalStore, approvalStore };
}

describe("spend gate lifecycle", () => {
  it("propose → approve → execute runs the executor exactly once", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "camp_9",
      payload: PAYLOAD,
      proposedBy: ACTOR,
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.scopeHash, scopeHashFor(PAYLOAD));

    const { proposal: approved, approval } = await approveSpendAction(
      proposalStore,
      approvalStore,
      WS,
      proposal.id,
      "approver_1",
    );
    assert.equal(approved.status, "approved");
    assert.equal(approval.scopeHash, proposal.scopeHash);
    assert.equal(approval.proposalId, proposal.id);

    let runs = 0;
    const receipt = await executeSpendAction(
      proposalStore,
      approvalStore,
      { workspaceId: WS, proposalId: proposal.id, payload: PAYLOAD },
      async ({ proposal: p, approval: a }) => {
        runs++;
        return { platformReceiptId: `amz-${p.id}`, approvalId: a.id };
      },
    );
    assert.equal(runs, 1);
    assert.match(receipt.platformReceiptId, /^amz-prop_/);
    const done = await proposalStore.get(proposal.id, WS);
    assert.equal(done!.status, "executed");
  });

  it("reject ends the lifecycle — the proposal can never execute", async () => {
    const { proposalStore } = stubStores();
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "pause",
      action: "pause",
      targetType: "campaign",
      targetId: "camp_9",
      payload: PAYLOAD,
      proposedBy: ACTOR,
    });
    const rejected = await rejectSpendAction(proposalStore, WS, proposal.id, ACTOR);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decidedBy, ACTOR);
  });

  it("scope hash is deterministic and sensitive to any payload change", () => {
    const a = scopeHashFor(PAYLOAD);
    const b = scopeHashFor({ ...PAYLOAD });
    const c = scopeHashFor({ ...PAYLOAD, budgetCents: 100001 });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("proposeBudgetChange mints a pending budget_change proposal", async () => {
    const { proposalStore } = stubStores();
    const p = await proposeBudgetChange(proposalStore, {
      workspaceId: WS,
      targetType: "campaign",
      targetId: "camp_9",
      payload: { campaignId: "camp_9", budgetCents: 200000 },
      proposedBy: ACTOR,
    });
    assert.equal(p.kind, "budget_change");
    assert.equal(p.action, "adjust_budget");
    assert.equal(p.status, "pending");
  });
});

describe("governed action catalog", () => {
  it("exposes exactly the seven bounded actions", () => {
    const slugs = ADS_GOVERNED_ACTIONS.map((a) => a.slug);
    assert.deepEqual(slugs, [
      "connect_account",
      "propose_campaign",
      "approve_spend",
      "launch",
      "pause",
      "adjust_budget",
      "pull_report",
    ]);
  });

  it("marks exactly launch/pause/adjust_budget as spend actions", () => {
    const spend = ADS_GOVERNED_ACTIONS.filter((a) => a.spendAction).map((a) => a.slug);
    assert.deepEqual(spend, ["launch", "pause", "adjust_budget"]);
  });

  it("adsActionDef throws on unknown slugs (fail closed on typos)", () => {
    assert.equal(adsActionDef("launch").kind, "execute");
    assert.throws(() => adsActionDef("buy_everything"), /Unknown ads governed action/);
  });

  it("registers the four Phase 1 platforms with honest capability flags", () => {
    assert.equal(ADS_PLATFORMS.amazon.supportsApiLaunch, true);
    assert.equal(ADS_PLATFORMS.stackadapt.supportsApiLaunch, true);
    // Walmart: guided-only by slice-4 research verdict — no public OAuth
    // authorize URL exists; auth is partner-level after a business
    // application. No launch/reporting API is claimed.
    assert.equal(ADS_PLATFORMS.walmart.guidedOnly, true);
    assert.equal(ADS_PLATFORMS.walmart.supportsApiLaunch, false);
    assert.equal(ADS_PLATFORMS.walmart.supportsReportingApi, false);
    assert.equal(ADS_PLATFORMS.walmart.oauthConnectorKey, undefined);
    // Spotify: guided only — no launch API is ever claimed.
    assert.equal(ADS_PLATFORMS.spotify.guidedOnly, true);
    assert.equal(ADS_PLATFORMS.spotify.supportsApiLaunch, false);
    assert.equal(ADS_PLATFORMS.spotify.oauthConnectorKey, undefined);
  });
});
