// Marketr — Phase 18 slice 2: Amazon Ads spend executor.
//
// The ONLY code path that touches the Amazon Ads API for spend mutations.
// It is invoked exclusively from inside executeSpendAction() (the slice-1
// gate) via runAdsAction("launch" | "pause" | "adjust_budget") — there is no
// other way to reach it, and without a matching SpendApproval the gate
// throws before this executor ever runs.
//
// Proposal payload shapes (scope-hashed at proposal time — the executor
// reads exactly these fields):
//   launch:        { workspaceId, accountId, platformKey, adProduct, name,
//                    targetingType?, dailyBudgetCents, startDate, endDate?,
//                    state?, brandEntityId? }
//   pause:         { workspaceId, accountId, platformKey, adProduct,
//                    externalCampaignId }
//   adjust_budget: { workspaceId, accountId, platformKey, adProduct,
//                    externalCampaignId, dailyBudgetCents }
//
// Sponsored TV fails closed: the STV REST surface is unverified, so STV
// proposals throw STV_NOT_VERIFIED instead of guessing an endpoint.

import { prisma } from "@/lib/prisma";
import { registerAdsExecutor, type AdsPlatformExecutor } from "../actions";
import { AmazonAdsClient, AmazonAdsError, type AmazonAdProduct } from "./client";
import { resolveAmazonAuth, type ResolvedAmazonAccount } from "./tokens";
import type { AmazonAdsAuth } from "./client";

/** PaidAdCampaign persistence port. Default implementation uses Prisma. */
export interface AmazonCampaignStore {
  upsertLaunchedCampaign(input: {
    workspaceId: string;
    accountId: string;
    name: string;
    externalId: string;
    status: "live" | "paused";
    budgetCents: number;
    flightStart?: Date;
  }): Promise<void>;
  markPaused(input: { workspaceId: string; accountId: string; externalId: string }): Promise<void>;
  setBudget(input: {
    workspaceId: string;
    accountId: string;
    externalId: string;
    budgetCents: number;
  }): Promise<void>;
}

export function prismaAmazonCampaignStore(): AmazonCampaignStore {
  return {
    async upsertLaunchedCampaign(input) {
      await prisma.paidAdCampaign.upsert({
        where: {
          workspaceId_accountId_externalId: {
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            externalId: input.externalId,
          },
        },
        update: {
          name: input.name,
          status: input.status,
          budgetCents: input.budgetCents,
          flightStart: input.flightStart ?? null,
        },
        create: {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          platformKey: "amazon",
          name: input.name,
          externalId: input.externalId,
          status: input.status,
          budgetCents: input.budgetCents,
          flightStart: input.flightStart ?? null,
        },
      });
    },
    async markPaused(input) {
      await prisma.paidAdCampaign.updateMany({
        where: { workspaceId: input.workspaceId, accountId: input.accountId, externalId: input.externalId },
        data: { status: "paused" },
      });
    },
    async setBudget(input) {
      await prisma.paidAdCampaign.updateMany({
        where: { workspaceId: input.workspaceId, accountId: input.accountId, externalId: input.externalId },
        data: { budgetCents: input.budgetCents },
      });
    },
  };
}

export interface AmazonExecutorDeps {
  resolveAuth?: (accountId: string) => Promise<{ auth: AmazonAdsAuth; account: ResolvedAmazonAccount }>;
  fetchImpl?: typeof fetch;
  campaigns?: AmazonCampaignStore;
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const v = payload[field];
  if (typeof v !== "string" || !v.trim()) {
    throw new AmazonAdsError("INVALID_PAYLOAD", `Launch payload is missing required field: ${field}`);
  }
  return v;
}

function requireAdProduct(payload: Record<string, unknown>): AmazonAdProduct {
  const v = payload.adProduct;
  if (v !== "sp" && v !== "sb") {
    throw new AmazonAdsError(
      "UNSUPPORTED_AD_PRODUCT",
      `Ad product "${String(v)}" is not executable — sp/sb only (stv fails closed until its REST surface is verified)`,
    );
  }
  return v;
}

function parseStartDate(yyyymmdd: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (!m) throw new AmazonAdsError("INVALID_PAYLOAD", "startDate must be YYYYMMDD");
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

async function launchCampaign(
  client: AmazonAdsClient,
  store: AmazonCampaignStore,
  payload: Record<string, unknown>,
  workspaceId: string,
  accountId: string,
): Promise<{ platformReceiptId: string; externalId: string }> {
  // STV fails closed before any network call — never guess the endpoint.
  if (payload.adProduct === "stv") {
    await client.createStvCampaign();
  }
  const adProduct = requireAdProduct(payload);
  const name = requireString(payload, "name");
  const dailyBudgetCents = payload.dailyBudgetCents;
  if (typeof dailyBudgetCents !== "number" || !Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) {
    throw new AmazonAdsError("INVALID_PAYLOAD", "dailyBudgetCents must be a positive number");
  }
  const startDate = requireString(payload, "startDate");
  const state = payload.state === "paused" ? "paused" : "enabled";
  const endDate = typeof payload.endDate === "string" ? payload.endDate : undefined;

  let externalId: string;
  if (adProduct === "sp") {
    const created = await client.createSpCampaign({
      name,
      targetingType: payload.targetingType === "auto" ? "auto" : "manual",
      dailyBudgetCents,
      startDate,
      endDate,
      state,
    });
    externalId = created.campaignId!;
  } else {
    const created = await client.createSbCampaign({
      name,
      dailyBudgetCents,
      startDate,
      endDate,
      state,
      brandEntityId: typeof payload.brandEntityId === "string" ? payload.brandEntityId : undefined,
    });
    externalId = created.campaignId!;
  }

  await store.upsertLaunchedCampaign({
    workspaceId,
    accountId,
    name,
    externalId,
    status: state === "enabled" ? "live" : "paused",
    budgetCents: Math.round(dailyBudgetCents),
    flightStart: parseStartDate(startDate),
  });
  return { platformReceiptId: `amazon:campaign:${externalId}`, externalId };
}

async function pauseCampaign(
  client: AmazonAdsClient,
  store: AmazonCampaignStore,
  payload: Record<string, unknown>,
  workspaceId: string,
  accountId: string,
): Promise<{ platformReceiptId: string }> {
  const adProduct = requireAdProduct(payload);
  const externalCampaignId = requireString(payload, "externalCampaignId");
  await client.pauseCampaign(adProduct, externalCampaignId);
  await store.markPaused({ workspaceId, accountId, externalId: externalCampaignId });
  return { platformReceiptId: `amazon:pause:${externalCampaignId}` };
}

async function adjustBudget(
  client: AmazonAdsClient,
  store: AmazonCampaignStore,
  payload: Record<string, unknown>,
  workspaceId: string,
  accountId: string,
): Promise<{ platformReceiptId: string }> {
  const adProduct = requireAdProduct(payload);
  const externalCampaignId = requireString(payload, "externalCampaignId");
  const dailyBudgetCents = payload.dailyBudgetCents;
  if (typeof dailyBudgetCents !== "number" || !Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) {
    throw new AmazonAdsError("INVALID_PAYLOAD", "dailyBudgetCents must be a positive number");
  }
  await client.setCampaignBudget(adProduct, externalCampaignId, dailyBudgetCents);
  await store.setBudget({
    workspaceId,
    accountId,
    externalId: externalCampaignId,
    budgetCents: Math.round(dailyBudgetCents),
  });
  return { platformReceiptId: `amazon:budget:${externalCampaignId}` };
}

/**
 * Build the Amazon AdsPlatformExecutor. Only reachable through the spend
 * gate — runAdsAction() invokes it from inside executeSpendAction() after
 * the approval checks pass.
 */
export function createAmazonExecutor(deps: AmazonExecutorDeps = {}): AdsPlatformExecutor {
  const resolve = deps.resolveAuth ?? resolveAmazonAuth;
  const store = deps.campaigns ?? prismaAmazonCampaignStore();
  return async ({ action, payload, approvalId }) => {
    const accountId = requireString(payload, "accountId");
    const workspaceId = requireString(payload, "workspaceId");
    const { auth, account } = await resolve(accountId);
    if (account.workspaceId !== workspaceId) {
      throw new AmazonAdsError("WORKSPACE_MISMATCH", "Execution refused: account workspace mismatch");
    }
    const client = new AmazonAdsClient({ auth, fetchImpl: deps.fetchImpl });
    switch (action) {
      case "launch":
        return launchCampaign(client, store, payload, workspaceId, accountId);
      case "pause":
        return pauseCampaign(client, store, payload, workspaceId, accountId);
      case "adjust_budget":
        return adjustBudget(client, store, payload, workspaceId, accountId);
      default:
        throw new AmazonAdsError("UNKNOWN_ACTION", `Unsupported ads action: ${action}`);
    }
  };
}

/** Register the Amazon executor in the governed-action registry (idempotent). */
export function registerAmazonAdsExecutor(deps: AmazonExecutorDeps = {}): void {
  registerAdsExecutor("amazon", createAmazonExecutor(deps));
}
