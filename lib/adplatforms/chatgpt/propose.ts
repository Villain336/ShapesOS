// Marketr — Wave 2 ChatGPT Ads slice 2: the propose flow.
//
// proposeChatGPTCampaign is the ONLY way a ChatGPT campaign comes into
// existence: it validates the draft (fail closed without a budget cap),
// persists PaidAdCampaign (draft, stackadapt platform key) + ChatGPTCampaign
// + CreativeVariants in one transaction, and emits a Phase 18 SpendProposal
// (kind=launch) through the spend gate. It never touches media spend —
// execution waits for a human SpendApproval in slice 3.
//
// Persistence is behind ports (Prisma default, stubs in tests).

import { prisma } from "@/lib/prisma";
import {
  proposeSpendAction,
  type SpendApprovalStore,
  type SpendProposal,
  type SpendProposalStore,
} from "../gate";
import { prismaApprovalStore, prismaProposalStore } from "../store";
import {
  ChatGPTAdsError,
  validateCampaignDraft,
  validateCreativeVariant,
  type ChatGPTCampaignDraftInput,
  type ChatGPTTier,
  type CreativeVariantInput,
} from "./types";

export interface ChatGPTCampaignRecord {
  id: string;
  campaignId: string;
  status: string;
}

export interface ProposeChatGPTCampaignInput extends ChatGPTCampaignDraftInput {
  workspaceId: string;
  proposedBy: string;
  creatives: CreativeVariantInput[];
}

export interface ProposeChatGPTCampaignResult {
  chatGPTCampaign: ChatGPTCampaignRecord;
  paidCampaignId: string;
  proposal: SpendProposal;
}

/** Persistence port: creates the paid campaign + extension + variants. */
export interface ChatGPTCampaignStore {
  createDraft(input: {
    workspaceId: string;
    accountId: string;
    name: string;
    objective?: string;
    targetTiers: ChatGPTTier[];
    topicIntentTags: string[];
    budgetDailyCents: number | null;
    budgetTotalCents: number | null;
    bidStrategy: "cpc" | "cpm";
    creatives: CreativeVariantInput[];
  }): Promise<{ chatGPTCampaignId: string; paidCampaignId: string }>;
  markProposed(chatGPTCampaignId: string): Promise<void>;
  /** The account must be a CONNECTED StackAdapt account — else fail closed. */
  assertStackAdaptAccount(input: { workspaceId: string; accountId: string }): Promise<void>;
}

export function prismaChatGPTCampaignStore(): ChatGPTCampaignStore {
  return {
    async assertStackAdaptAccount({ workspaceId, accountId }) {
      const account = await prisma.adAccount.findFirst({
        where: { id: accountId, workspaceId },
        include: { platform: { select: { key: true } } },
      });
      if (!account || account.platform.key !== "stackadapt" || account.status !== "connected") {
        throw new ChatGPTAdsError(
          "ACCOUNT_NOT_READY",
          "ChatGPT campaigns launch through a connected StackAdapt ad account.",
        );
      }
    },
    async createDraft(input) {
      return prisma.$transaction(async (tx) => {
        const paid = await tx.paidAdCampaign.create({
          data: {
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            platformKey: "stackadapt",
            name: input.name,
            objective: input.objective ?? null,
            status: "draft",
            budgetCents: input.budgetTotalCents ?? input.budgetDailyCents ?? null,
          },
        });
        const ext = await tx.chatGPTCampaign.create({
          data: {
            workspaceId: input.workspaceId,
            campaignId: paid.id,
            objective: input.objective ?? null,
            targetTiers: input.targetTiers,
            topicIntentTags: input.topicIntentTags,
            budgetDailyCents: input.budgetDailyCents,
            budgetTotalCents: input.budgetTotalCents,
            bidStrategy: input.bidStrategy,
            status: "draft",
            creatives: {
              create: input.creatives.map((c) => ({
                workspaceId: input.workspaceId,
                headline: c.headline,
                body: c.body,
                ctaLabel: c.ctaLabel ?? null,
                locale: c.locale ?? "en-US",
                source: c.source,
                aiProviderUsed: c.aiProviderUsed ?? null,
                aiModelUsed: c.aiModelUsed ?? null,
                approvalStatus: "pending",
                parentVariantId: c.parentVariantId ?? null,
              })),
            },
          },
        });
        return { chatGPTCampaignId: ext.id, paidCampaignId: paid.id };
      });
    },
    async markProposed(chatGPTCampaignId) {
      await prisma.chatGPTCampaign.update({
        where: { id: chatGPTCampaignId },
        data: { status: "proposed" },
      });
    },
  };
}

export interface ProposeContext {
  workspaceId: string;
  actor: string;
  campaigns?: ChatGPTCampaignStore;
  proposals?: SpendProposalStore;
  approvals?: SpendApprovalStore;
}

export async function proposeChatGPTCampaign(
  ctx: ProposeContext,
  input: Omit<ProposeChatGPTCampaignInput, "workspaceId" | "proposedBy">,
): Promise<ProposeChatGPTCampaignResult> {
  const campaigns = ctx.campaigns ?? prismaChatGPTCampaignStore();
  const proposals = ctx.proposals ?? prismaProposalStore();

  // Pure validation first — fail closed before any persistence.
  validateCampaignDraft({ ...input, accountId: input.accountId });
  for (const c of input.creatives) validateCreativeVariant(c);

  await campaigns.assertStackAdaptAccount({ workspaceId: ctx.workspaceId, accountId: input.accountId });

  const { chatGPTCampaignId, paidCampaignId } = await campaigns.createDraft({
    workspaceId: ctx.workspaceId,
    accountId: input.accountId,
    name: input.name,
    objective: input.objective,
    targetTiers: input.targetTiers,
    topicIntentTags: input.topicIntentTags,
    budgetDailyCents: input.budgetDailyCents ?? null,
    budgetTotalCents: input.budgetTotalCents ?? null,
    bidStrategy: input.bidStrategy ?? "cpc",
    creatives: input.creatives,
  });

  // Emit the spend proposal through the Phase 18 gate. Scope hash binds
  // approval → execution; the payload is the exact execution intent.
  const proposal = await proposeSpendAction(proposals, {
    workspaceId: ctx.workspaceId,
    kind: "launch",
    action: "launch",
    targetType: "campaign",
    targetId: paidCampaignId,
    payload: {
      chatGPTCampaignId,
      name: input.name,
      accountId: input.accountId,
      platformKey: "stackadapt",
      channel: "chatgpt",
      targetTiers: input.targetTiers,
      topicIntentTags: input.topicIntentTags,
      budgetDailyCents: input.budgetDailyCents ?? null,
      budgetTotalCents: input.budgetTotalCents ?? null,
      bidStrategy: input.bidStrategy ?? "cpc",
      creativeCount: input.creatives.length,
    },
    proposedBy: ctx.actor,
    platformKey: "stackadapt",
  });

  await campaigns.markProposed(chatGPTCampaignId);

  return {
    chatGPTCampaign: { id: chatGPTCampaignId, campaignId: paidCampaignId, status: "proposed" },
    paidCampaignId,
    proposal,
  };
}
