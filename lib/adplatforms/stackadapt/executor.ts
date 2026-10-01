// Marketr — Phase 18 slice 3: StackAdapt spend executor.
//
// The ONLY code path that touches the StackAdapt GraphQL API for spend
// mutations. It is invoked exclusively from inside executeSpendAction() (the
// slice-1 gate) via runAdsAction("launch" | "pause" | "adjust_budget") —
// there is no other way to reach it, and without a matching SpendApproval
// the gate throws before this executor ever runs.
//
// Proposal payload shapes (scope-hashed at proposal time — the executor
// reads exactly these fields):
//   launch:        { workspaceId, accountId, platformKey, channel
//                    (native|display|video|ctv|audio|dooh), name,
//                    dailyBudgetCents, startDate (YYYY-MM-DD), endDate?,
//                    state? ("enabled"|"paused"), campaignGroupName?,
//                    advertiserId?, inventory? }
//   pause:         { workspaceId, accountId, platformKey, externalCampaignId }
//   adjust_budget: { workspaceId, accountId, platformKey, externalCampaignId,
//                    dailyBudgetCents }
//
// inventory: the piggyback surfaces (spec §2b) — cinemaPmp, newspaperDigital,
// podcastAudio — declared as flags on the proposal and validated against the
// campaign channel. They are not separate integrations.
//
// The budget lives on the campaign GROUP, so adjust_budget resolves the
// campaign → its group, then sets the group budget. The updateCampaignGroup
// input shape is unverified against the live schema: a platform rejection
// throws UNVERIFIED_BUDGET_MUTATION (fail closed) rather than silently
// mis-setting a budget.

import { prisma } from "@/lib/prisma";
import { registerAdsExecutor, type AdsPlatformExecutor } from "../actions";
import {
  StackAdaptClient,
  StackAdaptError,
  isStackAdaptChannel,
  parseInventoryOptions,
  type StackAdaptChannel,
} from "./client";
import { resolveStackAdaptKey, type ResolvedStackAdaptAccount } from "./keys";

/** PaidAdCampaign persistence port. Default implementation uses Prisma. */
export interface StackAdaptCampaignStore {
  upsertLaunchedCampaign(input: {
    workspaceId: string;
    accountId: string;
    name: string;
    externalId: string;
    status: "live" | "paused";
    budgetCents: number;
    flightStart?: Date;
    flightEnd?: Date;
  }): Promise<void>;
  markPaused(input: { workspaceId: string; accountId: string; externalId: string }): Promise<void>;
  setBudget(input: {
    workspaceId: string;
    accountId: string;
    externalId: string;
    budgetCents: number;
  }): Promise<void>;
}

export function prismaStackAdaptCampaignStore(): StackAdaptCampaignStore {
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
          flightEnd: input.flightEnd ?? null,
        },
        create: {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          platformKey: "stackadapt",
          name: input.name,
          externalId: input.externalId,
          status: input.status,
          budgetCents: input.budgetCents,
          flightStart: input.flightStart ?? null,
          flightEnd: input.flightEnd ?? null,
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

export interface StackAdaptExecutorDeps {
  resolveKey?: (accountId: string) => Promise<{ apiKey: string; account: ResolvedStackAdaptAccount }>;
  fetchImpl?: typeof fetch;
  campaigns?: StackAdaptCampaignStore;
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const v = payload[field];
  if (typeof v !== "string" || !v.trim()) {
    throw new StackAdaptError("INVALID_PAYLOAD", `Proposal payload is missing required field: ${field}`);
  }
  return v;
}

function requireChannel(payload: Record<string, unknown>): StackAdaptChannel {
  const v = payload.channel;
  if (!isStackAdaptChannel(v)) {
    throw new StackAdaptError(
      "UNSUPPORTED_CHANNEL",
      `Channel "${String(v)}" is not executable — one of: native, display, video, ctv, audio, dooh`,
    );
  }
  return v;
}

function requirePositiveCents(payload: Record<string, unknown>, field: string): number {
  const v = payload[field];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new StackAdaptError("INVALID_PAYLOAD", `${field} must be a positive number`);
  }
  return v;
}

function parseDate(yyyymmdd: string, field: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!m) throw new StackAdaptError("INVALID_PAYLOAD", `${field} must be YYYY-MM-DD`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

async function launchCampaign(
  client: StackAdaptClient,
  store: StackAdaptCampaignStore,
  payload: Record<string, unknown>,
  workspaceId: string,
  accountId: string,
  externalAccountId: string,
): Promise<{ platformReceiptId: string; externalId: string }> {
  const channel = requireChannel(payload);
  const name = requireString(payload, "name");
  const dailyBudgetCents = requirePositiveCents(payload, "dailyBudgetCents");
  const startDate = requireString(payload, "startDate");
  parseDate(startDate, "startDate");
  const endDate = typeof payload.endDate === "string" && payload.endDate ? payload.endDate : undefined;
  if (endDate) parseDate(endDate, "endDate");
  const state = payload.state === "paused" ? "paused" : "enabled";
  // The piggyback inventory options ride the scope-hashed payload: unknown
  // flags or channel mismatches throw here, before any network call.
  parseInventoryOptions(payload.inventory, channel);
  const advertiserId =
    typeof payload.advertiserId === "string" && payload.advertiserId.trim()
      ? payload.advertiserId.trim()
      : externalAccountId;
  const groupName =
    typeof payload.campaignGroupName === "string" && payload.campaignGroupName.trim()
      ? payload.campaignGroupName.trim()
      : `${name} — budget group`;

  // The campaign group is the budgeting container: create it first, then the
  // channel campaign inside it. upsertCampaign is idempotent-safe on replay.
  const group = await client.createCampaignGroup({
    advertiserId,
    name: groupName,
    dailyBudgetCents,
    startDate,
    endDate,
    timezone: typeof payload.timezone === "string" ? payload.timezone : undefined,
  });
  const campaign = await client.upsertCampaign({
    campaignGroupId: group.id,
    channel,
    name,
    paused: state === "paused",
  });

  await store.upsertLaunchedCampaign({
    workspaceId,
    accountId,
    name,
    externalId: campaign.id,
    status: state === "enabled" ? "live" : "paused",
    budgetCents: Math.round(dailyBudgetCents),
    flightStart: parseDate(startDate, "startDate"),
    flightEnd: endDate ? parseDate(endDate, "endDate") : undefined,
  });
  return { platformReceiptId: `stackadapt:campaign:${campaign.id}`, externalId: campaign.id };
}

async function pauseCampaign(
  client: StackAdaptClient,
  store: StackAdaptCampaignStore,
  payload: Record<string, unknown>,
  workspaceId: string,
  accountId: string,
): Promise<{ platformReceiptId: string }> {
  const externalCampaignId = requireString(payload, "externalCampaignId");
  await client.pauseCampaigns([externalCampaignId]);
  await store.markPaused({ workspaceId, accountId, externalId: externalCampaignId });
  return { platformReceiptId: `stackadapt:pause:${externalCampaignId}` };
}

async function adjustBudget(
  client: StackAdaptClient,
  store: StackAdaptCampaignStore,
  payload: Record<string, unknown>,
  workspaceId: string,
  accountId: string,
): Promise<{ platformReceiptId: string }> {
  const externalCampaignId = requireString(payload, "externalCampaignId");
  const dailyBudgetCents = requirePositiveCents(payload, "dailyBudgetCents");
  // The budget lives on the campaign group, not the campaign.
  const campaign = await client.getCampaign(externalCampaignId);
  const groupId = campaign?.campaignGroup?.id;
  if (!groupId) {
    throw new StackAdaptError(
      "NO_BUDGET_GROUP",
      `Campaign ${externalCampaignId} has no resolvable campaign group — budget adjust refused`,
    );
  }
  // UNVERIFIED shape: a platform rejection throws UNVERIFIED_BUDGET_MUTATION
  // (fail closed) rather than silently mis-setting the budget.
  await client.setCampaignGroupBudget(groupId, dailyBudgetCents);
  await store.setBudget({
    workspaceId,
    accountId,
    externalId: externalCampaignId,
    budgetCents: Math.round(dailyBudgetCents),
  });
  return { platformReceiptId: `stackadapt:budget:${externalCampaignId}` };
}

/**
 * Build the StackAdapt AdsPlatformExecutor. Only reachable through the
 * spend gate — runAdsAction() invokes it from inside executeSpendAction()
 * after the approval checks pass.
 */
export function createStackAdaptExecutor(deps: StackAdaptExecutorDeps = {}): AdsPlatformExecutor {
  const resolve = deps.resolveKey ?? resolveStackAdaptKey;
  const store = deps.campaigns ?? prismaStackAdaptCampaignStore();
  return async ({ action, payload, approvalId: _approvalId }) => {
    void _approvalId;
    const accountId = requireString(payload, "accountId");
    const workspaceId = requireString(payload, "workspaceId");
    const { apiKey, account } = await resolve(accountId);
    if (account.workspaceId !== workspaceId) {
      throw new StackAdaptError("WORKSPACE_MISMATCH", "Execution refused: account workspace mismatch");
    }
    const client = new StackAdaptClient({ auth: { apiKey }, fetchImpl: deps.fetchImpl });
    switch (action) {
      case "launch":
        return launchCampaign(client, store, payload, workspaceId, accountId, account.externalAccountId);
      case "pause":
        return pauseCampaign(client, store, payload, workspaceId, accountId);
      case "adjust_budget":
        return adjustBudget(client, store, payload, workspaceId, accountId);
      default:
        throw new StackAdaptError("UNKNOWN_ACTION", `Unsupported ads action: ${action}`);
    }
  };
}

/** Register the StackAdapt executor in the governed-action registry (idempotent). */
export function registerStackAdaptAdsExecutor(deps: StackAdaptExecutorDeps = {}): void {
  registerAdsExecutor("stackadapt", createStackAdaptExecutor(deps));
}
