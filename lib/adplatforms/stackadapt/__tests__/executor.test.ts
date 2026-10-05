// Marketr — Phase 18 slice 3 tests: StackAdapt spend executor + reporting.
// Run: npx tsx --test lib/adplatforms/stackadapt/__tests__/executor.test.ts
//
// The full propose → approve → execute lifecycle against a mocked
// StackAdapt GraphQL API, the fail-closed negatives (no approval, scope
// tamper, unknown channel, unknown inventory flag, workspace mismatch —
// none may touch the API), and the delivery pull → normalize → ingest
// flow. Pure: stub stores, mocked fetch, no DB.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  approveSpendAction,
  executeSpendAction,
  proposeBudgetChange,
  proposeSpendAction,
  AdsGateError,
  type SpendApproval,
  type SpendApprovalStore,
  type SpendProposal,
  type SpendProposalStatus,
  type SpendProposalStore,
} from "../../gate";
import { runAdsAction, type AdsActionContext } from "../../actions";
import { registerStackAdaptConnectors } from "../index";
import { pullStackAdaptReport, normalizeStackAdaptReportRows } from "../reporting";
import type { IngestAdReportInput } from "../../reporting";
import { StackAdaptError } from "../client";
import type { StackAdaptCampaignStore } from "../executor";

const WS = "ws_1";
const ACTOR = "user_1";

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
      approvals.set(a.proposalId, a);
      return a;
    },
    async getByProposalId(proposalId, ws) {
      const a = approvals.get(proposalId);
      return a && a.workspaceId === ws ? a : null;
    },
  };
  return { proposalStore, approvalStore };
}

function stubCampaignStore() {
  const campaigns = new Map<string, { name: string; externalId: string; status: string; budgetCents: number }>();
  const store: StackAdaptCampaignStore = {
    async upsertLaunchedCampaign(input) {
      campaigns.set(input.externalId, {
        name: input.name,
        externalId: input.externalId,
        status: input.status,
        budgetCents: input.budgetCents,
      });
    },
    async markPaused(input) {
      const c = campaigns.get(input.externalId);
      if (c) c.status = "paused";
    },
    async setBudget(input) {
      const c = campaigns.get(input.externalId);
      if (c) c.budgetCents = input.budgetCents;
    },
  };
  return { store, campaigns };
}

interface RecordedCall {
  body: { query: string; variables: Record<string, unknown> };
}

function mockGraphql(handler: (body: RecordedCall["body"]) => { status?: number; json: unknown }) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as RecordedCall["body"];
    calls.push({ body });
    const route = handler(body);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.json,
      text: async () => JSON.stringify(route.json),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const LAUNCH_PAYLOAD = {
  workspaceId: WS,
  accountId: "acct_1",
  platformKey: "stackadapt",
  channel: "audio",
  name: "Podcast Launch",
  dailyBudgetCents: 30000,
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  state: "enabled",
  inventory: { podcastAudio: true },
};

function graphqlHandler(body: RecordedCall["body"]) {
  const q = body.query;
  if (q.includes("mutation CreateCampaignGroup")) {
    return { json: { data: { createCampaignGroup: { campaignGroup: { id: "grp_1", name: "Podcast Launch — budget group" }, userErrors: [] } } } };
  }
  if (q.includes("mutation UpsertCampaign")) {
    return {
      json: {
        data: {
          upsertCampaign: {
            campaign: { __typename: "AudioCampaign", id: "cmp_1", campaignStatus: "ENABLED", channelType: "audio" },
            userErrors: [],
          },
        },
      },
    };
  }
  if (q.includes("mutation PauseCampaigns")) {
    return { json: { data: { pauseCampaigns: { userErrors: [] } } } };
  }
  if (q.includes("query Campaign(") || q.includes("query Campaign$")) {
    return { json: { data: { campaign: { id: "cmp_1", campaignGroup: { id: "grp_1", name: "G" } } } } };
  }
  if (q.includes("mutation UpdateCampaignGroupBudget")) {
    return { json: { data: { updateCampaignGroup: { campaignGroup: { id: "grp_1" }, userErrors: [] } } } };
  }
  if (q.includes("query CampaignDelivery")) {
    return {
      json: {
        data: {
          campaignDelivery: {
            records: [
              { date: "2026-09-28", campaign: { id: "cmp_1" }, impressions: 2000, clicks: 40, cost: "60.00", conversions: 5, revenue: "210.00" },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  }
  throw new Error(`unexpected GraphQL call: ${q.slice(0, 80)}`);
}

function registerTestConnector(fetchImpl: typeof fetch, campaigns: StackAdaptCampaignStore) {
  registerStackAdaptConnectors({
    resolveKey: async (accountId: string) => ({
      apiKey: "test-key",
      account: { id: accountId, workspaceId: WS, externalAccountId: "adv_9" },
    }),
    fetchImpl,
    campaigns,
  });
}

describe("stackadapt executor: propose → approve → execute", () => {
  let calls: RecordedCall[];
  let campaigns: Map<string, { name: string; externalId: string; status: string; budgetCents: number }>;

  beforeEach(() => {
    const { store, campaigns: campMap } = stubCampaignStore();
    campaigns = campMap;
    const mocked = mockGraphql(graphqlHandler);
    calls = mocked.calls;
    registerTestConnector(mocked.fetchImpl, store);
  });

  it("launches an approved campaign: group first, then the channel campaign", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };

    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-camp-1",
      payload: LAUNCH_PAYLOAD,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);

    const result = (await runAdsAction(ctx, "launch", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload: LAUNCH_PAYLOAD,
    })) as { platformReceiptId: string; externalId: string; proposalId: string; approvalId: string };

    assert.equal(result.externalId, "cmp_1");
    assert.equal(result.platformReceiptId, "stackadapt:campaign:cmp_1");
    assert.equal(result.proposalId, proposal.id);
    assert.ok(result.approvalId, "approval id must be linked");

    assert.equal(calls.length, 2, "group create, then campaign upsert");
    const groupInput = calls[0].body.variables.input as Record<string, unknown>;
    assert.equal(groupInput.advertiserId, "adv_9");
    assert.equal(groupInput.budgetType, "DAILY");
    assert.equal(groupInput.budgetAllocation, "300.00");
    const campaignInput = calls[1].body.variables.input as Record<string, unknown>;
    assert.equal(campaignInput.channelType, "AUDIO");
    assert.equal(campaignInput.campaignGroupId, "grp_1");
    assert.equal(campaignInput.name, "Podcast Launch");

    const stored = campaigns.get("cmp_1")!;
    assert.equal(stored.status, "live");
    assert.equal(stored.budgetCents, 30000);

    const executed = await proposalStore.get(proposal.id, WS);
    assert.equal(executed!.status, "executed");
  });

  it("refuses execution without approval — the API is never touched", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-camp-1",
      payload: LAUNCH_PAYLOAD,
      proposedBy: ACTOR,
    });
    const err = await runAdsAction(ctx, "launch", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload: LAUNCH_PAYLOAD,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AdsGateError && err.code === "NOT_APPROVED");
    assert.equal(calls.length, 0, "no API call without approval");
  });

  it("refuses execution when the payload differs from the approved scope", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-camp-1",
      payload: LAUNCH_PAYLOAD,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const tampered = { ...LAUNCH_PAYLOAD, dailyBudgetCents: 99999 };
    const err = await runAdsAction(ctx, "launch", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload: tampered,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AdsGateError && err.code === "SCOPE_HASH_MISMATCH");
    assert.equal(calls.length, 0, "no API call on scope tamper");
  });

  it("fails closed on an unknown channel before any network call", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = { ...LAUNCH_PAYLOAD, channel: "billboard" };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-camp-1",
      payload,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const err = await runAdsAction(ctx, "launch", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof StackAdaptError && err.code === "UNSUPPORTED_CHANNEL");
    assert.equal(calls.length, 0);
  });

  it("fails closed on an unknown inventory flag before any network call", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = { ...LAUNCH_PAYLOAD, inventory: { podcastAudio: true, mysteryFlag: true } };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-camp-1",
      payload,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const err = await runAdsAction(ctx, "launch", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof StackAdaptError && err.code === "INVALID_PAYLOAD");
    assert.equal(calls.length, 0);
  });

  it("pauses an approved campaign", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = {
      workspaceId: WS,
      accountId: "acct_1",
      platformKey: "stackadapt",
      externalCampaignId: "cmp_1",
    };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "pause",
      action: "pause",
      targetType: "campaign",
      targetId: "cmp_1",
      payload,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const result = (await runAdsAction(ctx, "pause", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload,
    })) as { platformReceiptId: string };
    assert.equal(result.platformReceiptId, "stackadapt:pause:cmp_1");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].body.query.includes("pauseCampaigns"));
    assert.deepEqual(calls[0].body.variables.ids, ["cmp_1"]);
  });

  it("adjusts the budget on the campaign group via a new approved proposal", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = {
      workspaceId: WS,
      accountId: "acct_1",
      platformKey: "stackadapt",
      externalCampaignId: "cmp_1",
      dailyBudgetCents: 45000,
    };
    const proposal = await proposeBudgetChange(proposalStore, {
      workspaceId: WS,
      targetType: "campaign",
      targetId: "cmp_1",
      payload,
      proposedBy: ACTOR,
    });
    assert.equal(proposal.action, "adjust_budget");
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const result = (await runAdsAction(ctx, "adjust_budget", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload,
    })) as { platformReceiptId: string };
    assert.equal(result.platformReceiptId, "stackadapt:budget:cmp_1");
    // First call resolves campaign → group; second sets the group budget.
    assert.equal(calls.length, 2);
    const budgetInput = calls[1].body.variables.input as Record<string, unknown>;
    assert.equal(budgetInput.id, "grp_1");
    assert.equal(budgetInput.budgetAllocation, "450.00");
  });

  it("fails closed on budget adjust when the campaign has no resolvable group", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const { fetchImpl } = mockGraphql((body) => {
      if (body.query.includes("query Campaign")) {
        return { json: { data: { campaign: { id: "cmp_x", campaignGroup: null } } } };
      }
      throw new Error("should not be called");
    });
    const { store } = stubCampaignStore();
    registerStackAdaptConnectors({
      resolveKey: async (accountId: string) => ({
        apiKey: "test-key",
        account: { id: accountId, workspaceId: WS, externalAccountId: "adv_9" },
      }),
      fetchImpl,
      campaigns: store,
    });
    const payload = {
      workspaceId: WS,
      accountId: "acct_1",
      platformKey: "stackadapt",
      externalCampaignId: "cmp_x",
      dailyBudgetCents: 45000,
    };
    const proposal = await proposeBudgetChange(proposalStore, {
      workspaceId: WS,
      targetType: "campaign",
      targetId: "cmp_x",
      payload,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const err = await runAdsAction(ctx, "adjust_budget", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof StackAdaptError && err.code === "NO_BUDGET_GROUP");
  });

  it("refuses when the payload workspace does not match the account workspace", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = { ...LAUNCH_PAYLOAD, workspaceId: "ws_evil" };
    const evilCtx: AdsActionContext = { ...ctx, workspaceId: "ws_evil" };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: "ws_evil",
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-camp-1",
      payload,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, "ws_evil", proposal.id, ACTOR);
    const err = await runAdsAction(evilCtx, "launch", {
      platformKey: "stackadapt",
      proposalId: proposal.id,
      payload,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof StackAdaptError && err.code === "WORKSPACE_MISMATCH");
    assert.equal(calls.length, 0);
  });

  it("the raw gate still refuses execution with no executor result path", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-camp-1",
      payload: LAUNCH_PAYLOAD,
      proposedBy: ACTOR,
    });
    let ran = false;
    const err = await executeSpendAction(
      proposalStore,
      approvalStore,
      { workspaceId: WS, proposalId: proposal.id, payload: LAUNCH_PAYLOAD },
      async () => {
        ran = true;
        return "should-never-run";
      },
    ).catch((e: unknown) => e);
    assert.ok(err instanceof AdsGateError);
    assert.equal(ran, false);
  });
});

describe("stackadapt reporting: pull → normalize → ingest", () => {
  it("normalizes MoneyValue strings to cents with approval lineage", async () => {
    const rows = normalizeStackAdaptReportRows(
      [
        {
          date: "2026-09-28",
          campaignId: "cmp_1",
          impressions: 2000,
          clicks: 40,
          cost: "60.00",
          conversions: 5,
          revenue: "210.00",
        },
      ],
      { reportId: "stackadapt:2026-09-28:2026-09-29" },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].externalCampaignId, "cmp_1");
    assert.equal(rows[0].spendCents, 6000);
    assert.equal(rows[0].revenueCents, 21000);
    assert.equal(rows[0].conversions, 5);
    assert.equal(rows[0].ctr, 0.02);
    assert.equal(rows[0].platformReceiptId, "stackadapt:2026-09-28:2026-09-29");
    assert.equal(rows[0].approvalId, null);
  });

  it("fails closed on rows that cannot be attributed", () => {
    assert.throws(
      () =>
        normalizeStackAdaptReportRows([{ date: "2026-09-28", campaignId: "", impressions: 1, clicks: 1, cost: "1.00", conversions: 0, revenue: "0" }]),
      (e: Error) => e instanceof StackAdaptError && e.code === "BAD_RESPONSE",
    );
    assert.throws(
      () => normalizeStackAdaptReportRows([{ date: "bad", campaignId: "cmp_1", impressions: 1, clicks: 1, cost: "1.00", conversions: 0, revenue: "0" }]),
      (e: Error) => e instanceof StackAdaptError && e.code === "BAD_RESPONSE",
    );
  });

  it("pulls delivery and ingests rows with the approval lineage attached", async () => {
    const { fetchImpl } = mockGraphql(graphqlHandler);
    let ingestedInput: IngestAdReportInput | null = null;
    const result = await pullStackAdaptReport({
      workspaceId: WS,
      accountId: "acct_1",
      startDate: "2026-09-28",
      endDate: "2026-09-29",
      fetchImpl,
      resolveKey: (async () => ({
        apiKey: "test-key",
        account: { id: "acct_1", workspaceId: WS, externalAccountId: "adv_9" },
      })) as never,
      findApprovalId: async () => "appr_1",
      ingest: (async (input: IngestAdReportInput) => {
        ingestedInput = input;
        return { upserted: input.rows.length, skippedNoCampaign: 0 };
      }) as never,
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].spendCents, 6000);
    assert.equal(result.rows[0].approvalId, "appr_1");
    assert.ok(ingestedInput, "ingest must be called");
    assert.equal((ingestedInput as unknown as IngestAdReportInput).platformKey, "stackadapt");
    assert.equal((ingestedInput as unknown as IngestAdReportInput).rows[0].platformReceiptId, "stackadapt:2026-09-28:2026-09-29");
  });
});
