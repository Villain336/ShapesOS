// Marketr — Phase 18 slice 2 tests: Amazon Ads spend executor + reporting.
// Run: npx tsx --test lib/adplatforms/amazon/__tests__/executor.test.ts
//
// The full propose → approve → execute lifecycle against a mocked Amazon
// API, the fail-closed negatives (no approval, scope tamper, STV,
// workspace mismatch — none may touch the API), and the report pull →
// normalize → ingest flow. Pure: stub stores, mocked fetch, no DB.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  approveSpendAction,
  executeSpendAction,
  proposeBudgetChange,
  proposeSpendAction,
  type SpendApproval,
  type SpendApprovalStore,
  type SpendProposal,
  type SpendProposalStatus,
  type SpendProposalStore,
} from "../../gate";
import { runAdsAction, registerAdsExecutor, type AdsActionContext } from "../../actions";
import { AdsGateError } from "../../gate";
import { registerAmazonConnectors } from "../index";
import { pullAmazonReport, normalizeAmazonReportRows } from "../reporting";
import type { IngestAdReportInput } from "../../reporting";
import { AmazonAdsError, type AmazonAdsAuth } from "../client";
import type { AmazonCampaignStore } from "../executor";

const WS = "ws_1";
const ACTOR = "user_1";
const AUTH: AmazonAdsAuth = {
  accessToken: "test-access-token",
  clientId: "test-lwa-client-id",
  profileId: "1234567890",
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
  const store: AmazonCampaignStore = {
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
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(handler: (url: string, method: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url: u, method: init?.method ?? "GET", body });
    const route = handler(u, init?.method ?? "GET", body);
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
  platformKey: "amazon",
  adProduct: "sp",
  name: "Launch Test",
  targetingType: "manual",
  dailyBudgetCents: 5000,
  startDate: "20261001",
  state: "enabled",
};

function registerTestConnector(fetchImpl: typeof fetch, campaigns: AmazonCampaignStore) {
  registerAmazonConnectors({
    resolveAuth: async (accountId: string) => ({
      auth: AUTH,
      account: { id: accountId, workspaceId: WS, externalAccountId: "1234567890" },
    }),
    fetchImpl,
    campaigns,
  });
}

describe("amazon executor: propose → approve → execute", () => {
  let calls: RecordedCall[];
  let campaigns: Map<string, { name: string; externalId: string; status: string; budgetCents: number }>;

  beforeEach(() => {
    const { store, campaigns: campMap } = stubCampaignStore();
    campaigns = campMap;
    const mocked = mockFetch((url, method) => {
      if (url.endsWith("/sp/campaigns") && method === "POST") {
        return { json: { campaigns: [{ campaignId: "camp_new", name: "Launch Test", state: "ENABLED" }] } };
      }
      if (url.endsWith("/sp/campaigns") && method === "PUT") {
        return { json: { campaigns: [{}] } };
      }
      throw new Error(`unexpected call ${method} ${url}`);
    });
    calls = mocked.calls;
    registerTestConnector(mocked.fetchImpl, store);
  });

  it("launches an approved campaign through the mocked Amazon API", async () => {
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
      platformKey: "amazon",
      proposalId: proposal.id,
      payload: LAUNCH_PAYLOAD,
    })) as { platformReceiptId: string; externalId: string; proposalId: string; approvalId: string };

    assert.equal(result.externalId, "camp_new");
    assert.equal(result.platformReceiptId, "amazon:campaign:camp_new");
    assert.equal(result.proposalId, proposal.id);
    assert.ok(result.approvalId, "approval id must be linked");

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/sp/campaigns"));
    assert.equal(calls[0].method, "POST");
    const body = calls[0].body as { campaigns: { name: string; dailyBudget: number }[] };
    assert.equal(body.campaigns[0].name, "Launch Test");
    assert.equal(body.campaigns[0].dailyBudget, 50);

    const stored = campaigns.get("camp_new")!;
    assert.equal(stored.status, "live");
    assert.equal(stored.budgetCents, 5000);

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
      platformKey: "amazon",
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
      platformKey: "amazon",
      proposalId: proposal.id,
      payload: tampered,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AdsGateError && err.code === "SCOPE_HASH_MISMATCH");
    assert.equal(calls.length, 0, "no API call on scope tamper");
  });

  it("pauses an approved campaign", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = {
      workspaceId: WS,
      accountId: "acct_1",
      platformKey: "amazon",
      adProduct: "sp",
      externalCampaignId: "camp_new",
    };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "pause",
      action: "pause",
      targetType: "campaign",
      targetId: "camp_new",
      payload,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const result = (await runAdsAction(ctx, "pause", {
      platformKey: "amazon",
      proposalId: proposal.id,
      payload,
    })) as { platformReceiptId: string };
    assert.equal(result.platformReceiptId, "amazon:pause:camp_new");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PUT");
    assert.deepEqual((calls[0].body as { campaigns: unknown[] }).campaigns, [
      { campaignId: "camp_new", state: "PAUSED" },
    ]);
  });

  it("adjusts the budget only via a new approved proposal", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = {
      workspaceId: WS,
      accountId: "acct_1",
      platformKey: "amazon",
      adProduct: "sp",
      externalCampaignId: "camp_new",
      dailyBudgetCents: 7500,
    };
    const proposal = await proposeBudgetChange(proposalStore, {
      workspaceId: WS,
      targetType: "campaign",
      targetId: "camp_new",
      payload,
      proposedBy: ACTOR,
    });
    assert.equal(proposal.action, "adjust_budget");
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const result = (await runAdsAction(ctx, "adjust_budget", {
      platformKey: "amazon",
      proposalId: proposal.id,
      payload,
    })) as { platformReceiptId: string };
    assert.equal(result.platformReceiptId, "amazon:budget:camp_new");
    assert.deepEqual((calls[0].body as { campaigns: unknown[] }).campaigns, [
      { campaignId: "camp_new", dailyBudget: 75 },
    ]);
  });

  it("fails closed on Sponsored TV (unverified REST surface)", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = { ...LAUNCH_PAYLOAD, adProduct: "stv" };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "local-stv-1",
      payload,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    const err = await runAdsAction(ctx, "launch", {
      platformKey: "amazon",
      proposalId: proposal.id,
      payload,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AmazonAdsError && err.code === "STV_NOT_VERIFIED");
    assert.equal(calls.length, 0, "no API call for STV");
  });

  it("refuses when the payload workspace does not match the account workspace", async () => {
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const payload = { ...LAUNCH_PAYLOAD, workspaceId: "ws_evil" };
    // The gate binds the proposal to ws_evil too, so it reaches the executor.
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
      platformKey: "amazon",
      proposalId: proposal.id,
      payload,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AmazonAdsError && err.code === "WORKSPACE_MISMATCH");
    assert.equal(calls.length, 0);
  });

  it("the raw gate still refuses execution with no executor result path", async () => {
    // Direct gate-level check: executeSpendAction without approval never
    // invokes the executor callback.
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

describe("amazon reporting: pull → normalize → ingest", () => {
  it("pulls the async report and normalizes rows with approval lineage", async () => {
    let statusCalls = 0;
    const { fetchImpl } = mockFetch((url) => {
      if (url.endsWith("/reporting/reports")) return { json: { reportId: "rpt_7" } };
      if (url.endsWith("/reporting/reports/rpt_7")) {
        statusCalls++;
        return statusCalls === 1
          ? { json: { reportId: "rpt_7", status: "PROCESSING" } }
          : { json: { reportId: "rpt_7", status: "COMPLETED", url: "https://signed.example/rpt_7.json" } };
      }
      if (url === "https://signed.example/rpt_7.json") {
        return {
          json: [
            {
              date: "2026-09-30",
              campaignId: "camp_new",
              campaignName: "Launch Test",
              impressions: 1000,
              clicks: 42,
              cost: 12.5,
              purchases7d: 3,
              sales7d: 40,
            },
          ],
        };
      }
      throw new Error(`unexpected call ${url}`);
    });

    const ingested: { workspaceId: string; platformKey: string; accountId: string; rows: unknown[] }[] = [];
    const result = await pullAmazonReport({
      workspaceId: WS,
      accountId: "acct_1",
      startDate: "2026-09-30",
      endDate: "2026-09-30",
      fetchImpl,
      resolveAuth: (async () => ({
        auth: AUTH,
        account: { id: "acct_1", workspaceId: WS, externalAccountId: "1234567890" },
      })) as never,
      findApprovalId: async () => "appr_1",
      ingest: (async (input: IngestAdReportInput) => {
        ingested.push({ ...input, rows: input.rows });
        return { upserted: input.rows.length, skippedNoCampaign: 0 };
      }) as never,
      pollIntervalMs: 1,
      maxPollAttempts: 5,
    });

    assert.equal(result.reportId, "rpt_7");
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.externalCampaignId, "camp_new");
    assert.equal(row.spendCents, 1250);
    assert.equal(row.revenueCents, 4000);
    assert.equal(row.impressions, 1000);
    assert.equal(row.clicks, 42);
    assert.equal(row.conversions, 3);
    assert.equal(row.approvalId, "appr_1");
    assert.equal(row.platformReceiptId, "rpt_7");
    assert.equal(row.date.toISOString(), "2026-09-30T00:00:00.000Z");

    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].workspaceId, WS);
    assert.equal(ingested[0].platformKey, "amazon");
    assert.equal(ingested[0].accountId, "acct_1");
    assert.equal(result.ingested.upserted, 1);
  });

  it("fails when the report job fails", async () => {
    const { fetchImpl } = mockFetch((url) => {
      if (url.endsWith("/reporting/reports")) return { json: { reportId: "rpt_bad" } };
      return { json: { reportId: "rpt_bad", status: "FAILURE" } };
    });
    const err = await pullAmazonReport({
      workspaceId: WS,
      accountId: "acct_1",
      startDate: "2026-09-30",
      endDate: "2026-09-30",
      fetchImpl,
      resolveAuth: (async () => ({
        auth: AUTH,
        account: { id: "acct_1", workspaceId: WS, externalAccountId: "1234567890" },
      })) as never,
      pollIntervalMs: 1,
      maxPollAttempts: 3,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AmazonAdsError && err.code === "REPORT_FAILED");
  });

  it("normalizer rejects unattributable rows", () => {
    assert.throws(
      () => normalizeAmazonReportRows([{ date: "09/30/2026", campaignId: "c1" }]),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "BAD_RESPONSE",
    );
    assert.throws(
      () => normalizeAmazonReportRows([{ date: "2026-09-30" }]),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "BAD_RESPONSE",
    );
    assert.throws(
      () => normalizeAmazonReportRows({ not: "an array" }),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "BAD_RESPONSE",
    );
  });

  it("normalizer handles zero impressions without NaN ctr", () => {
    const rows = normalizeAmazonReportRows([
      { date: "2026-09-30", campaignId: "c1", impressions: 0, clicks: 0, cost: 0 },
    ]);
    assert.equal(rows[0].ctr, null);
    assert.equal(rows[0].spendCents, 0);
  });
});

// Keep the registry honest: an unknown platform slug still fails closed.
describe("registry hygiene", () => {
  it("unregistered executors fail closed", async () => {
    registerAdsExecutor("stackadapt", async () => {
      throw new Error("stackadapt is slice 3 — must not run here");
    });
    const { proposalStore, approvalStore } = stubStores();
    const ctx: AdsActionContext = { workspaceId: WS, actor: ACTOR, proposals: proposalStore, approvals: approvalStore };
    const proposal = await proposeSpendAction(proposalStore, {
      workspaceId: WS,
      kind: "launch",
      action: "launch",
      targetType: "campaign",
      targetId: "x",
      payload: LAUNCH_PAYLOAD,
      proposedBy: ACTOR,
    });
    await approveSpendAction(proposalStore, approvalStore, WS, proposal.id, ACTOR);
    // spotify never registers an executor (guided-only) → PLATFORM_NOT_CONNECTED.
    const err = await runAdsAction(ctx, "launch", {
      platformKey: "spotify",
      proposalId: proposal.id,
      payload: LAUNCH_PAYLOAD,
    }).catch((e: unknown) => e);
    assert.match((err as Error).message, /No executor registered for spotify/);
  });
});
