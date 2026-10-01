// Marketr — Wave 2 ChatGPT Ads slice 3 tests: launch checklist, approval
// freshness, pause, and the auto-pause rule.
// Run: npx tsx --test lib/adplatforms/chatgpt/__tests__/launch.test.ts
//
// All persistence and the StackAdapt network layer are stubbed. Proves:
// launch is blocked without an approved proposal, without a fresh (<24h)
// approval, and without a completed checklist; pause flips status and calls
// the StackAdapt rail; auto-pause fires only past the 10% breach line.

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
import { scopeHashFor } from "../../gate";
import {
  autoPauseOnSpendBreach,
  launchChatGPTCampaign,
  onChatGPTProposalApproved,
  pauseChatGPTCampaign,
  type ChatGPTLaunchableCampaign,
  type ChatGPTLifecycleStore,
  type LaunchChecklist,
  type LifecycleContext,
} from "../launch";
import { ChatGPTAdsError } from "../types";

const WS = "ws_launch";
const ACTOR = "user_launch";

const PAYLOAD = {
  chatGPTCampaignId: "cgpt_1",
  name: "Fall launch",
  accountId: "acct_1",
  platformKey: "stackadapt",
  channel: "chatgpt",
  targetTiers: ["free"],
  topicIntentTags: ["crm"],
  budgetDailyCents: 5000,
  budgetTotalCents: null,
  bidStrategy: "cpc",
  creativeCount: 1,
};

function stubStores(opts: {
  campaign?: Partial<ChatGPTLaunchableCampaign>;
  proposalStatus?: SpendProposalStatus;
  approvalAgeMs?: number | null;
  todaySpendCents?: number;
} = {}) {
  const campaign: ChatGPTLaunchableCampaign = {
    id: "cgpt_1",
    campaignId: "paid_1",
    status: "approved",
    targetTiers: ["free"],
    budgetDailyCents: 5000,
    stackAdaptExternalId: "sa_camp_1",
    paidCampaign: { id: "paid_1", name: "Fall launch", accountId: "acct_1" },
    ...opts.campaign,
  };
  const marks: string[] = [];
  const lifecycle: ChatGPTLifecycleStore = {
    async getForLaunch() {
      return { ...campaign };
    },
    async markLive({ stackAdaptExternalId }) {
      campaign.status = "live";
      campaign.stackAdaptExternalId = stackAdaptExternalId;
      marks.push("live");
    },
    async markPaused() {
      campaign.status = "paused";
      marks.push("paused");
    },
    async markApproved() {
      campaign.status = "approved";
      marks.push("approved");
    },
    async getTodaySpendCents() {
      return opts.todaySpendCents ?? 0;
    },
  };

  const proposal: SpendProposal = {
    id: "prop_1",
    workspaceId: WS,
    kind: "launch",
    action: "launch",
    targetType: "campaign",
    targetId: "paid_1",
    payload: PAYLOAD,
    scopeHash: scopeHashFor(PAYLOAD),
    status: opts.proposalStatus ?? "approved",
    proposedBy: ACTOR,
    proposedAt: new Date(),
    decidedBy: null,
    decidedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const proposals: SpendProposalStore = {
    async create(input) {
      return { ...proposal, ...input, id: "prop_new" };
    },
    async get(id) {
      return id === proposal.id ? proposal : null;
    },
    async setStatus(id, status) {
      if (id === proposal.id) proposal.status = status;
      return proposal;
    },
  };

  const decidedAt =
    opts.approvalAgeMs === null ? null : new Date(Date.now() - (opts.approvalAgeMs ?? 60_000));
  const approval: SpendApproval | null = decidedAt
    ? {
        id: "appr_1",
        workspaceId: WS,
        proposalId: proposal.id,
        approver: ACTOR,
        decidedAt,
        scopeHash: proposal.scopeHash,
      }
    : null;
  const approvals: SpendApprovalStore = {
    async create(input) {
      return { id: "appr_new", workspaceId: input.workspaceId, proposalId: input.proposalId, approver: input.approver, decidedAt: new Date(), scopeHash: input.scopeHash };
    },
    async getByProposalId(id) {
      return id === proposal.id ? approval : null;
    },
  };

  const networkCalls: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    const q = body.query ?? "";
    networkCalls.push(
      q.includes("createCampaignGroup")
        ? "createCampaignGroup"
        : q.includes("upsertCampaign")
          ? "upsertCampaign"
          : q.includes("PauseCampaigns")
            ? "pauseCampaigns"
            : "unknown",
    );
    const data = q.includes("createCampaignGroup")
      ? { createCampaignGroup: { campaignGroup: { id: "grp_1", name: "g" }, userErrors: [] } }
      : q.includes("upsertCampaign")
        ? { upsertCampaign: { campaign: { __typename: "Campaign", id: "sa_camp_new", campaignStatus: "ENABLED", channelType: "NATIVE" }, userErrors: [] } }
        : { pauseCampaigns: { userErrors: [] } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;

  const ctx: LifecycleContext = {
    workspaceId: WS,
    actor: ACTOR,
    lifecycle,
    proposals,
    approvals,
    stackAdapt: {
      resolveKey: async () => ({
        apiKey: "test-key",
        account: { id: "acct_1", workspaceId: WS, externalAccountId: "adv_1" },
      }),
      fetchImpl,
      campaigns: {
        async upsertLaunchedCampaign() {},
        async markPaused() {},
        async setBudget() {},
      },
    },
  };
  return { ctx, campaign, proposal, networkCalls, marks };
}

const CHECKLIST: LaunchChecklist = { tiersConfirmed: true, geoConfirmed: true, dailyCapCents: 5000 };

describe("launchChatGPTCampaign", () => {
  it("launches through the gate when approved, fresh, and checklist-complete", async () => {
    const { ctx, networkCalls, marks } = stubStores();
    const result = await launchChatGPTCampaign(ctx, {
      chatGPTCampaignId: "cgpt_1",
      proposalId: "prop_1",
      checklist: CHECKLIST,
    });
    assert.equal(result.chatGPTCampaignId, "cgpt_1");
    assert.equal(result.stackAdaptExternalId, "sa_camp_new");
    assert.ok(result.platformReceiptId.startsWith("stackadapt:campaign:"));
    assert.deepEqual(networkCalls, ["createCampaignGroup", "upsertCampaign"]);
    assert.deepEqual(marks, ["live"]);
  });

  it("blocks launch when the proposal is not approved", async () => {
    const { ctx } = stubStores({ proposalStatus: "pending" });
    await assert.rejects(
      () =>
        launchChatGPTCampaign(ctx, {
          chatGPTCampaignId: "cgpt_1",
          proposalId: "prop_1",
          checklist: CHECKLIST,
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "NOT_APPROVED",
    );
  });

  it("blocks launch when the approval is older than 24h", async () => {
    const { ctx, networkCalls } = stubStores({ approvalAgeMs: 25 * 60 * 60 * 1000 });
    await assert.rejects(
      () =>
        launchChatGPTCampaign(ctx, {
          chatGPTCampaignId: "cgpt_1",
          proposalId: "prop_1",
          checklist: CHECKLIST,
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "APPROVAL_STALE",
    );
    assert.equal(networkCalls.length, 0, "no network call on stale approval");
  });

  it("blocks launch when the checklist is incomplete or the cap mismatches", async () => {
    const { ctx } = stubStores();
    await assert.rejects(
      () =>
        launchChatGPTCampaign(ctx, {
          chatGPTCampaignId: "cgpt_1",
          proposalId: "prop_1",
          checklist: { ...CHECKLIST, tiersConfirmed: false },
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "CHECKLIST_INCOMPLETE",
    );
    await assert.rejects(
      () =>
        launchChatGPTCampaign(ctx, {
          chatGPTCampaignId: "cgpt_1",
          proposalId: "prop_1",
          checklist: { ...CHECKLIST, dailyCapCents: 9999 },
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "CHECKLIST_CAP_MISMATCH",
    );
  });

  it("blocks launch when the campaign is not in approved status", async () => {
    const { ctx } = stubStores({ campaign: { status: "proposed" } });
    await assert.rejects(
      () =>
        launchChatGPTCampaign(ctx, {
          chatGPTCampaignId: "cgpt_1",
          proposalId: "prop_1",
          checklist: CHECKLIST,
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "INVALID_STATUS_TRANSITION",
    );
  });
});

describe("pauseChatGPTCampaign", () => {
  it("pauses a live campaign through the StackAdapt rail", async () => {
    const { ctx, networkCalls, marks } = stubStores({ campaign: { status: "live" } });
    const result = await pauseChatGPTCampaign(ctx, { chatGPTCampaignId: "cgpt_1", reason: "manual" });
    assert.equal(result.chatGPTCampaignId, "cgpt_1");
    assert.deepEqual(networkCalls, ["pauseCampaigns"]);
    assert.deepEqual(marks, ["paused"]);
  });

  it("refuses to pause a campaign that was never launched", async () => {
    const { ctx } = stubStores({ campaign: { status: "live", stackAdaptExternalId: null } });
    await assert.rejects(
      () => pauseChatGPTCampaign(ctx, { chatGPTCampaignId: "cgpt_1", reason: "manual" }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "NOT_LAUNCHED",
    );
  });
});

describe("autoPauseOnSpendBreach", () => {
  it("pauses when today's spend exceeds the daily cap by more than 10%", async () => {
    const { ctx, marks } = stubStores({
      campaign: { status: "live" },
      todaySpendCents: 5600, // cap 5000 → 12% over
    });
    const result = await autoPauseOnSpendBreach(ctx, { chatGPTCampaignId: "cgpt_1" });
    assert.equal(result.paused, true);
    assert.equal(result.spendCents, 5600);
    assert.deepEqual(marks, ["paused"]);
    assert.ok(result.reason?.includes("auto-pause"));
  });

  it("does not pause under the breach line", async () => {
    const { ctx, marks } = stubStores({
      campaign: { status: "live" },
      todaySpendCents: 5400, // 8% over — under the 10% line
    });
    const result = await autoPauseOnSpendBreach(ctx, { chatGPTCampaignId: "cgpt_1" });
    assert.equal(result.paused, false);
    assert.deepEqual(marks, []);
  });

  it("does nothing for a non-live campaign", async () => {
    const { ctx, marks } = stubStores({ campaign: { status: "paused" }, todaySpendCents: 99999 });
    const result = await autoPauseOnSpendBreach(ctx, { chatGPTCampaignId: "cgpt_1" });
    assert.equal(result.paused, false);
    assert.deepEqual(marks, []);
  });
});

describe("onChatGPTProposalApproved", () => {
  it("moves the ChatGPT campaign to approved on inbox approval", async () => {
    const { ctx, marks } = stubStores({ campaign: { status: "proposed" } });
    const synced = await onChatGPTProposalApproved(ctx, ctx.proposals ? await ctx.proposals.get("prop_1") as SpendProposal : null as never);
    assert.equal(synced, true);
    assert.deepEqual(marks, ["approved"]);
  });

  it("ignores proposals that are not ChatGPT launches", async () => {
    const { ctx, marks } = stubStores();
    const base = (await ctx.proposals!.get("prop_1")) as SpendProposal;
    const other: SpendProposal = { ...base, payload: { channel: "display" } };
    const synced = await onChatGPTProposalApproved(ctx, other);
    assert.equal(synced, false);
    assert.deepEqual(marks, []);
  });
});
