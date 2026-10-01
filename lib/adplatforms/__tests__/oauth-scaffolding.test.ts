// Marketr — Phase 18 slice 1 tests: OAuth scaffolding + action surface.
// Run: npx tsx --test lib/adplatforms/__tests__/oauth-scaffolding.test.ts
//
// connect_account fails closed for every platform that cannot start OAuth in
// slice 1, and the bounded action surface rejects unknown slugs and
// unconnected platform executors. Pure: stub stores, no live database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AdsOAuthError,
  startAdsOAuth,
  vaultTokenRef,
} from "../oauth";
import {
  AdsActionError,
  registerAdsExecutor,
  runAdsAction,
  type AdsActionContext,
} from "../actions";
import type {
  SpendApproval,
  SpendApprovalStore,
  SpendProposal,
  SpendProposalStatus,
  SpendProposalStore,
} from "../gate";

function stubCtx(): AdsActionContext {
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
    async get(id) {
      return proposals.get(id) ?? null;
    },
    async setStatus(id, status: SpendProposalStatus, decidedBy?: string) {
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
    async getByProposalId(proposalId) {
      return approvals.get(proposalId) ?? null;
    },
  };
  return { workspaceId: "ws_oauth", actor: "user_oauth", proposals: proposalStore, approvals: approvalStore };
}

describe("connect_account OAuth scaffolding", () => {
  it("fails closed for unknown platforms", () => {
    assert.throws(
      () => startAdsOAuth("myspace", "u", "w", "https://app.example.com"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "UNKNOWN_PLATFORM",
    );
  });

  it("fails closed for guided-only Spotify (no OAuth exists)", () => {
    assert.throws(
      () => startAdsOAuth("spotify", "u", "w", "https://app.example.com"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "GUIDED_ONLY",
    );
  });

  it("fails closed for API-key-based StackAdapt", () => {
    assert.throws(
      () => startAdsOAuth("stackadapt", "u", "w", "https://app.example.com"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "NOT_OAUTH",
    );
  });

  it("fails closed for Walmart until the partner authorize URL is pinned (slice 4)", () => {
    assert.throws(
      () => startAdsOAuth("walmart", "u", "w", "https://app.example.com"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "NOT_CONFIGURED",
    );
  });

  it("fails closed for Amazon when the client id env var is missing", () => {
    const saved = process.env.AMAZON_ADS_CLIENT_ID;
    delete process.env.AMAZON_ADS_CLIENT_ID;
    try {
      assert.throws(
        () => startAdsOAuth("amazon", "u", "w", "https://app.example.com"),
        (e: unknown) => e instanceof AdsOAuthError && e.code === "OAUTH_NOT_CONFIGURED",
      );
    } finally {
      if (saved !== undefined) process.env.AMAZON_ADS_CLIENT_ID = saved;
    }
  });

  it("builds a real Amazon consent URL when configured", () => {
    const saved = process.env.AMAZON_ADS_CLIENT_ID;
    const savedKey = process.env.MARKETR_CREDENTIALS_KEY;
    process.env.AMAZON_ADS_CLIENT_ID = "test-client-id";
    // Test-only envelope key (never a real credential).
    process.env.MARKETR_CREDENTIALS_KEY = "0".repeat(64);
    try {
      const { url, state } = startAdsOAuth("amazon", "u1", "w1", "https://app.example.com");
      assert.ok(url.startsWith("https://www.amazon.com/ap/oa?"), "must hit Login with Amazon");
      assert.ok(url.includes("scope=advertising%3A%3Acampaign_management"), "must request the campaign-management scope");
      assert.ok(url.includes("client_id=test-client-id"));
      assert.ok(state.length > 0, "state envelope must be non-empty");
      assert.ok(!url.includes("secret"), "no secret material in the URL");
    } finally {
      if (saved !== undefined) process.env.AMAZON_ADS_CLIENT_ID = saved;
      else delete process.env.AMAZON_ADS_CLIENT_ID;
      if (savedKey !== undefined) process.env.MARKETR_CREDENTIALS_KEY = savedKey;
      else delete process.env.MARKETR_CREDENTIALS_KEY;
    }
  });

  it("vaultTokenRef is opaque and namespaced (never the credential)", () => {
    const ref = vaultTokenRef("amazon", "conn_123");
    assert.equal(ref, "vault:oauth:amazon:conn_123");
  });
});

describe("bounded action surface", () => {
  it("rejects unknown slugs", async () => {
    const ctx = stubCtx();
    await assert.rejects(
      () => runAdsAction(ctx, "buy_everything"),
      /Unknown ads governed action/,
    );
  });

  it("propose_campaign drafts a pending proposal without spending", async () => {
    const ctx = stubCtx();
    const proposal = (await runAdsAction(ctx, "propose_campaign", {
      kind: "launch",
      targetType: "campaign",
      targetId: "camp_1",
      payload: { budgetCents: 50000 },
      platformKey: "amazon",
    })) as SpendProposal;
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.action, "launch");
  });

  it("launch fails closed when no platform executor is registered", async () => {
    const ctx = stubCtx();
    await assert.rejects(
      () =>
        runAdsAction(ctx, "launch", {
          platformKey: "amazon",
          proposalId: "prop_1",
          payload: {},
        }),
      (e: unknown) => e instanceof AdsActionError && e.code === "PLATFORM_NOT_CONNECTED",
    );
  });

  it("launch executes through the gate once an executor registers", async () => {
    const ctx = stubCtx();
    registerAdsExecutor("amazon", async ({ approvalId }) => ({
      platformReceiptId: `receipt-${approvalId}`,
      externalId: "ext-camp-1",
    }));
    const proposal = (await runAdsAction(ctx, "propose_campaign", {
      kind: "launch",
      targetType: "campaign",
      targetId: "camp_1",
      payload: { budgetCents: 50000 },
      platformKey: "amazon",
    })) as SpendProposal;
    const { proposal: approved } = (await runAdsAction(ctx, "approve_spend", {
      proposalId: proposal.id,
    })) as { proposal: SpendProposal };
    assert.equal(approved.status, "approved");
    const result = (await runAdsAction(ctx, "launch", {
      platformKey: "amazon",
      proposalId: proposal.id,
      payload: { budgetCents: 50000 },
    })) as { platformReceiptId: string };
    assert.match(result.platformReceiptId, /^receipt-appr_/);
  });
});
