// Marketr — Wave 2 ChatGPT Ads slice 2 tests: propose flow.
// Run: npx tsx --test lib/adplatforms/chatgpt/__tests__/propose.test.ts
//
// Stub stores throughout: no database, no network. Proves the propose flow
// fails closed without a budget cap, without a connected StackAdapt account,
// validates every creative, and emits a scope-hashed launch SpendProposal.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  AdsGateError,
  type SpendApproval,
  type SpendApprovalStore,
  type SpendProposal,
  type SpendProposalStatus,
  type SpendProposalStore,
} from "../../gate";
import {
  proposeChatGPTCampaign,
  type ChatGPTCampaignStore,
  type ProposeContext,
} from "../propose";
import { ChatGPTAdsError, type ChatGPTTier } from "../types";

const WS = "ws_chatgpt";
const ACTOR = "user_chatgpt";

function stubProposalStore() {
  const proposals = new Map<string, SpendProposal>();
  let n = 0;
  const store: SpendProposalStore = {
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
        status: "pending" as SpendProposalStatus,
        proposedBy: input.proposedBy,
        proposedAt: new Date(),
        decidedBy: null,
        decidedAt: null,
        expiresAt: input.expiresAt,
      };
      proposals.set(p.id, p);
      return p;
    },
    async get(id) {
      return proposals.get(id) ?? null;
    },
    async setStatus(id, status, decidedBy) {
      const p = proposals.get(id);
      if (!p) throw new AdsGateError("NOT_FOUND", id);
      p.status = status;
      p.decidedBy = decidedBy ?? null;
      return p;
    },
  };
  return { store, proposals };
}

function stubApprovalStore(): SpendApprovalStore {
  const approvals = new Map<string, SpendApproval>();
  return {
    async create(input) {
      const a: SpendApproval = {
        id: `appr_${approvals.size + 1}`,
        workspaceId: input.workspaceId,
        proposalId: input.proposalId,
        approver: input.approver,
        decidedAt: new Date(),
        scopeHash: input.scopeHash,
      };
      approvals.set(a.proposalId, a);
      return a;
    },
    async getByProposalId(proposalId) {
      return approvals.get(proposalId) ?? null;
    },
  };
}

function stubCampaignStore(opts: { accountReady?: boolean } = {}) {
  const created: Array<{ name: string; creatives: number }> = [];
  let proposed: string[] = [];
  const store: ChatGPTCampaignStore = {
    async assertStackAdaptAccount() {
      if (opts.accountReady === false) {
        throw new ChatGPTAdsError("ACCOUNT_NOT_READY", "not connected");
      }
    },
    async createDraft(input) {
      created.push({ name: input.name, creatives: input.creatives.length });
      return { chatGPTCampaignId: `cgpt_${created.length}`, paidCampaignId: `paid_${created.length}` };
    },
    async markProposed(id) {
      proposed.push(id);
    },
  };
  return { store, created, get proposed() { return proposed; } };
}

function ctx(overrides: Partial<ProposeContext> = {}): ProposeContext & {
  proposals: SpendProposalStore;
} {
  const { store } = stubProposalStore();
  const { store: campaigns } = stubCampaignStore();
  return {
    workspaceId: WS,
    actor: ACTOR,
    campaigns,
    proposals: store,
    approvals: stubApprovalStore(),
    ...overrides,
  };
}

const BASE_INPUT = {
  name: "Fall launch",
  accountId: "acct_stack_1",
  targetTiers: ["free", "go"] as ChatGPTTier[],
  topicIntentTags: ["crm software"],
  budgetDailyCents: 5000,
  creatives: [
    { headline: "Close more deals", body: "The CRM your team will actually use.", source: "human" as const },
  ],
};

describe("proposeChatGPTCampaign", () => {
  it("creates the draft, emits a launch SpendProposal, and marks proposed", async () => {
    const c = ctx();
    const result = await proposeChatGPTCampaign(c, { ...BASE_INPUT });

    assert.equal(result.chatGPTCampaign.status, "proposed");
    assert.equal(result.proposal.kind, "launch");
    assert.equal(result.proposal.action, "launch");
    assert.equal(result.proposal.targetType, "campaign");
    assert.equal(result.proposal.targetId, result.paidCampaignId);
    assert.equal(result.proposal.status, "pending");
    assert.ok(result.proposal.scopeHash.length >= 32, "proposal is scope-hashed");
    assert.equal(
      (result.proposal.payload as Record<string, unknown>).channel,
      "chatgpt",
    );
  });

  it("fails closed without a budget cap — nothing is persisted", async () => {
    const { store: campaigns, created } = stubCampaignStore();
    const c = ctx({ campaigns });
    await assert.rejects(
      () =>
        proposeChatGPTCampaign(c, {
          ...BASE_INPUT,
          budgetDailyCents: null,
          budgetTotalCents: null,
        } as never),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "BUDGET_CAP_REQUIRED",
    );
    assert.equal(created.length, 0);
  });

  it("fails closed when the StackAdapt account is not connected", async () => {
    const { store: campaigns, created } = stubCampaignStore({ accountReady: false });
    const c = ctx({ campaigns });
    await assert.rejects(
      () => proposeChatGPTCampaign(c, { ...BASE_INPUT }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "ACCOUNT_NOT_READY",
    );
    assert.equal(created.length, 0);
  });

  it("validates every creative before persisting", async () => {
    const { store: campaigns, created } = stubCampaignStore();
    const c = ctx({ campaigns });
    await assert.rejects(
      () =>
        proposeChatGPTCampaign(c, {
          ...BASE_INPUT,
          creatives: [{ headline: "", body: "x", source: "human" as const }],
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "HEADLINE_REQUIRED",
    );
    assert.equal(created.length, 0);
  });

  it("requires AI provenance on AI-generated creatives", async () => {
    const c = ctx();
    await assert.rejects(
      () =>
        proposeChatGPTCampaign(c, {
          ...BASE_INPUT,
          creatives: [{ headline: "h", body: "b", source: "ai_generated" as const }],
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "AI_PROVENANCE_REQUIRED",
    );
  });
});
