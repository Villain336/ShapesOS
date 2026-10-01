// Marketr — Phase 18 slice 2: execute an approved spend proposal.
//
// Shared by the API route (POST /api/ads/proposals/[id]/execute) and the
// proposals-inbox server action. Registers the Amazon connector (idempotent),
// then runs the proposal's action through runAdsAction() — which funnels
// launch/pause/adjust_budget through the spend gate (executeSpendAction).
// The gate throws on missing approval, replay, or scope-hash mismatch, so
// this function can never spend without a human approval.

import { prisma } from "@/lib/prisma";
import { runAdsAction, AdsActionError, type AdsActionContext } from "./actions";
import { prismaApprovalStore, prismaProposalStore } from "./store";
import { registerAmazonConnectors } from "./amazon";
import { registerStackAdaptConnectors } from "./stackadapt";
import { isAdsPlatformKey } from "./types";

export async function executeSpendProposal(
  workspaceId: string,
  actor: string,
  proposalId: string,
): Promise<unknown> {
  const proposal = await prisma.spendProposal.findFirst({
    where: { id: proposalId, workspaceId },
  });
  if (!proposal) {
    throw new AdsActionError("PROPOSAL_NOT_FOUND", `Spend proposal ${proposalId} not found`);
  }

  registerAmazonConnectors();
  registerStackAdaptConnectors();

  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  const platformKey =
    typeof payload.platformKey === "string" && isAdsPlatformKey(payload.platformKey)
      ? payload.platformKey
      : "amazon";

  const ctx: AdsActionContext = {
    workspaceId,
    actor,
    proposals: prismaProposalStore(),
    approvals: prismaApprovalStore(),
  };
  return runAdsAction(ctx, proposal.action, {
    platformKey,
    proposalId: proposal.id,
    payload,
  });
}
