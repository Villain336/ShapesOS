// Marketr — Wave 2 ChatGPT Ads slice 3: approval → launch/pause.
//
// Launch is the guarded path: the ChatGPT campaign must be `approved` (synced
// from the proposal inbox on SpendApproval), the approval token must be fresh
// (<24h), and a human must confirm the launch checklist (tiers, geo, daily
// cap). Execution runs inside the Phase 18 spend gate (executeSpendAction),
// whose executor translates the scope-verified ChatGPT payload into the
// StackAdapt rail shape — ChatGPT inventory is bought as StackAdapt native
// placements; there is no public OpenAI ads API.
//
// Pause is protective, not spend: reversible and instant for a human or an
// agent with pause capability. The auto-pause rule fires when today's spend
// exceeds the daily cap by >10%.

import { prisma } from "@/lib/prisma";
import {
  executeSpendAction,
  type SpendApproval,
  type SpendApprovalStore,
  type SpendProposal,
  type SpendProposalStore,
} from "../gate";
import { prismaApprovalStore, prismaProposalStore } from "../store";
import { createStackAdaptExecutor, type StackAdaptExecutorDeps } from "../stackadapt/executor";
import { assertStatusTransition, ChatGPTAdsError, type ChatGPTCampaignStatus } from "./types";

/** Approval-token freshness window: a launch needs a decision made within this. */
export const LAUNCH_APPROVAL_FRESHNESS_MS = 24 * 60 * 60 * 1000;
/** Auto-pause fires when today's spend exceeds the daily cap by more than this ratio. */
export const AUTO_PAUSE_BREACH_RATIO = 0.1;
/** ChatGPT inventory is bought through StackAdapt as native placements. */
export const CHATGPT_STACKADAPT_CHANNEL = "native";

export interface LaunchChecklist {
  /** Human confirmed the Free/Go tier targeting. */
  tiersConfirmed: boolean;
  /** Human confirmed the launch geo (ChatGPT ads beta: US only). */
  geoConfirmed: boolean;
  /** Human re-entered the daily cap — must match the campaign's budgetDailyCents. */
  dailyCapCents: number;
}

export interface ChatGPTLaunchableCampaign {
  id: string;
  campaignId: string;
  status: ChatGPTCampaignStatus;
  targetTiers: string[];
  budgetDailyCents: number | null;
  stackAdaptExternalId: string | null;
  paidCampaign: { id: string; name: string; accountId: string };
}

export interface ChatGPTLifecycleStore {
  getForLaunch(chatGPTCampaignId: string, workspaceId: string): Promise<ChatGPTLaunchableCampaign | null>;
  markLive(input: { chatGPTCampaignId: string; stackAdaptExternalId: string }): Promise<void>;
  markPaused(input: { chatGPTCampaignId: string; reason: string }): Promise<void>;
  markApproved(chatGPTCampaignId: string): Promise<void>;
  getTodaySpendCents(paidCampaignId: string): Promise<number>;
}

export function prismaChatGPTLifecycleStore(): ChatGPTLifecycleStore {
  return {
    async getForLaunch(chatGPTCampaignId, workspaceId) {
      const c = await prisma.chatGPTCampaign.findFirst({
        where: { id: chatGPTCampaignId, workspaceId },
        include: { campaign: { select: { id: true, name: true, accountId: true } } },
      });
      if (!c) return null;
      return {
        id: c.id,
        campaignId: c.campaignId,
        status: c.status as ChatGPTCampaignStatus,
        targetTiers: [...c.targetTiers],
        budgetDailyCents: c.budgetDailyCents,
        stackAdaptExternalId: c.stackAdaptExternalId,
        paidCampaign: c.campaign,
      };
    },
    async markLive({ chatGPTCampaignId, stackAdaptExternalId }) {
      await prisma.chatGPTCampaign.update({
        where: { id: chatGPTCampaignId },
        data: { status: "live", stackAdaptExternalId },
      });
      await prisma.paidAdCampaign.updateMany({
        where: { chatGPTExtension: { id: chatGPTCampaignId } },
        data: { status: "live" },
      });
    },
    async markPaused({ chatGPTCampaignId }) {
      await prisma.chatGPTCampaign.update({
        where: { id: chatGPTCampaignId },
        data: { status: "paused" },
      });
      await prisma.paidAdCampaign.updateMany({
        where: { chatGPTExtension: { id: chatGPTCampaignId } },
        data: { status: "paused" },
      });
    },
    async markApproved(chatGPTCampaignId) {
      await prisma.chatGPTCampaign.update({
        where: { id: chatGPTCampaignId },
        data: { status: "approved" },
      });
    },
    async getTodaySpendCents(paidCampaignId) {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const rows = await prisma.adReport.findMany({
        where: { campaignId: paidCampaignId, date: { gte: start } },
        select: { spendCents: true },
      });
      return rows.reduce((sum, r) => sum + r.spendCents, 0);
    },
  };
}

export interface LifecycleContext {
  workspaceId: string;
  actor: string;
  lifecycle?: ChatGPTLifecycleStore;
  proposals?: SpendProposalStore;
  approvals?: SpendApprovalStore;
  stackAdapt?: StackAdaptExecutorDeps;
}

function todayYYYYMMDD(): string {
  return new Date().toISOString().slice(0, 10);
}

function requireFreshApproval(approval: SpendApproval | null): SpendApproval {
  if (!approval) {
    throw new ChatGPTAdsError("APPROVAL_MISSING", "Launch refused: no SpendApproval for this proposal.");
  }
  const age = Date.now() - approval.decidedAt.getTime();
  if (age > LAUNCH_APPROVAL_FRESHNESS_MS) {
    throw new ChatGPTAdsError(
      "APPROVAL_STALE",
      "Launch refused: the approval is older than 24h. Re-approve the proposal to launch.",
    );
  }
  return approval;
}

function checkChecklist(campaign: ChatGPTLaunchableCampaign, checklist: LaunchChecklist): void {
  if (!checklist.tiersConfirmed || campaign.targetTiers.length === 0) {
    throw new ChatGPTAdsError("CHECKLIST_INCOMPLETE", "Launch refused: confirm the tier targeting.");
  }
  if (!checklist.geoConfirmed) {
    throw new ChatGPTAdsError("CHECKLIST_INCOMPLETE", "Launch refused: confirm the launch geo (US only).");
  }
  if (checklist.dailyCapCents !== campaign.budgetDailyCents) {
    throw new ChatGPTAdsError(
      "CHECKLIST_CAP_MISMATCH",
      "Launch refused: the confirmed daily cap does not match the campaign's daily cap.",
    );
  }
}

/**
 * Sync hook: call after a launch SpendProposal for a ChatGPT campaign is
 * approved in the proposal inbox — moves the campaign proposed → approved.
 */
export async function onChatGPTProposalApproved(
  ctx: Pick<LifecycleContext, "lifecycle">,
  proposal: SpendProposal,
): Promise<boolean> {
  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  if (payload.channel !== "chatgpt") return false;
  const chatGPTCampaignId = payload.chatGPTCampaignId;
  if (typeof chatGPTCampaignId !== "string" || !chatGPTCampaignId) return false;
  const lifecycle = ctx.lifecycle ?? prismaChatGPTLifecycleStore();
  await lifecycle.markApproved(chatGPTCampaignId);
  return true;
}

export interface LaunchResult {
  chatGPTCampaignId: string;
  stackAdaptExternalId: string;
  platformReceiptId: string;
}

/**
 * Launch a ChatGPT campaign. The campaign must be approved, the approval
 * fresh (<24h), and the human launch checklist complete. Execution goes
 * through the Phase 18 spend gate; the executor translates the
 * scope-verified payload onto the StackAdapt rail.
 */
export async function launchChatGPTCampaign(
  ctx: LifecycleContext,
  input: { chatGPTCampaignId: string; proposalId: string; checklist: LaunchChecklist },
): Promise<LaunchResult> {
  const lifecycle = ctx.lifecycle ?? prismaChatGPTLifecycleStore();
  const proposals = ctx.proposals ?? prismaProposalStore();
  const approvals = ctx.approvals ?? prismaApprovalStore();

  const campaign = await lifecycle.getForLaunch(input.chatGPTCampaignId, ctx.workspaceId);
  if (!campaign) {
    throw new ChatGPTAdsError("NOT_FOUND", `ChatGPT campaign ${input.chatGPTCampaignId} not found.`);
  }
  assertStatusTransition(campaign.status, "live");

  const proposal = await proposals.get(input.proposalId);
  if (!proposal || proposal.workspaceId !== ctx.workspaceId) {
    throw new ChatGPTAdsError("PROPOSAL_NOT_FOUND", "Launch refused: proposal not found.");
  }
  if (proposal.status !== "approved") {
    throw new ChatGPTAdsError(
      "NOT_APPROVED",
      `Launch refused: proposal is ${proposal.status}, not approved.`,
    );
  }
  const approval = await approvals.getByProposalId(proposal.id);
  requireFreshApproval(approval);

  checkChecklist(campaign, input.checklist);

  const dailyBudgetCents = campaign.budgetDailyCents;
  if (dailyBudgetCents == null || dailyBudgetCents <= 0) {
    throw new ChatGPTAdsError(
      "LAUNCH_NEEDS_DAILY_CAP",
      "Launch refused: the StackAdapt budget group needs a daily cap.",
    );
  }

  const stackAdaptExecutor = createStackAdaptExecutor(ctx.stackAdapt);

  // payload is the proposal's stored payload — byte-identical to what the
  // scope hash was computed over. The executor translates it onto the
  // StackAdapt rail AFTER the gate verifies the hash.
  const receipt = await executeSpendAction<{ platformReceiptId: string; externalId: string }>(
    proposals,
    approvals,
    {
      workspaceId: ctx.workspaceId,
      proposalId: proposal.id,
      payload: (proposal.payload ?? {}) as Record<string, unknown>,
    },
    async ({ payload, approval: verifiedApproval }) => {
      const translated: Record<string, unknown> = {
        workspaceId: ctx.workspaceId,
        accountId: campaign.paidCampaign.accountId,
        platformKey: "stackadapt",
        channel: CHATGPT_STACKADAPT_CHANNEL,
        name: campaign.paidCampaign.name,
        dailyBudgetCents,
        startDate: todayYYYYMMDD(),
        campaignGroupName: `${campaign.paidCampaign.name} — ChatGPT`,
        state: "enabled",
      };
      const result = (await stackAdaptExecutor({
        platformKey: "stackadapt",
        action: "launch",
        payload: translated,
        approvalId: verifiedApproval.id,
      })) as { platformReceiptId: string; externalId: string };
      void payload;
      return result;
    },
  );

  await lifecycle.markLive({
    chatGPTCampaignId: campaign.id,
    stackAdaptExternalId: receipt.externalId,
  });

  return {
    chatGPTCampaignId: campaign.id,
    stackAdaptExternalId: receipt.externalId,
    platformReceiptId: receipt.platformReceiptId,
  };
}

export interface PauseResult {
  chatGPTCampaignId: string;
  reason: string;
}

/**
 * Pause a live ChatGPT campaign — protective, reversible, instant. Pause is
 * not spend, so it goes straight to the StackAdapt rail (no SpendProposal).
 */
export async function pauseChatGPTCampaign(
  ctx: LifecycleContext,
  input: { chatGPTCampaignId: string; reason: string },
): Promise<PauseResult> {
  const lifecycle = ctx.lifecycle ?? prismaChatGPTLifecycleStore();

  const campaign = await lifecycle.getForLaunch(input.chatGPTCampaignId, ctx.workspaceId);
  if (!campaign) {
    throw new ChatGPTAdsError("NOT_FOUND", `ChatGPT campaign ${input.chatGPTCampaignId} not found.`);
  }
  assertStatusTransition(campaign.status, "paused");
  if (!campaign.stackAdaptExternalId) {
    throw new ChatGPTAdsError(
      "NOT_LAUNCHED",
      "Pause refused: the campaign has no StackAdapt external id (never launched).",
    );
  }

  const stackAdaptExecutor = createStackAdaptExecutor(ctx.stackAdapt);
  await stackAdaptExecutor({
    platformKey: "stackadapt",
    action: "pause",
    payload: {
      workspaceId: ctx.workspaceId,
      accountId: campaign.paidCampaign.accountId,
      platformKey: "stackadapt",
      externalCampaignId: campaign.stackAdaptExternalId,
    },
    approvalId: "pause-protective-no-approval",
  });

  await lifecycle.markPaused({ chatGPTCampaignId: campaign.id, reason: input.reason });

  return { chatGPTCampaignId: campaign.id, reason: input.reason };
}

export interface AutoPauseCheckResult {
  chatGPTCampaignId: string;
  spendCents: number;
  dailyCapCents: number | null;
  paused: boolean;
  reason: string | null;
}

/**
 * The auto-pause rule: when today's spend exceeds the daily cap by more than
 * AUTO_PAUSE_BREACH_RATIO (10%), pause immediately. Safe to run on a
 * schedule — it only acts on a live campaign over the breach line.
 */
export async function autoPauseOnSpendBreach(
  ctx: LifecycleContext,
  input: { chatGPTCampaignId: string },
): Promise<AutoPauseCheckResult> {
  const lifecycle = ctx.lifecycle ?? prismaChatGPTLifecycleStore();

  const campaign = await lifecycle.getForLaunch(input.chatGPTCampaignId, ctx.workspaceId);
  if (!campaign) {
    throw new ChatGPTAdsError("NOT_FOUND", `ChatGPT campaign ${input.chatGPTCampaignId} not found.`);
  }
  const spendCents = await lifecycle.getTodaySpendCents(campaign.paidCampaign.id);
  const cap = campaign.budgetDailyCents;

  if (campaign.status !== "live" || cap == null || cap <= 0) {
    return { chatGPTCampaignId: campaign.id, spendCents, dailyCapCents: cap, paused: false, reason: null };
  }
  if (spendCents <= cap * (1 + AUTO_PAUSE_BREACH_RATIO)) {
    return { chatGPTCampaignId: campaign.id, spendCents, dailyCapCents: cap, paused: false, reason: null };
  }

  const reason = `auto-pause: daily spend $${(spendCents / 100).toFixed(2)} exceeded the $${(cap / 100).toFixed(2)} cap by more than 10%`;
  await pauseChatGPTCampaign(ctx, { chatGPTCampaignId: campaign.id, reason });
  return { chatGPTCampaignId: campaign.id, spendCents, dailyCapCents: cap, paused: true, reason };
}
