// Marketr — Listmonk sidecar: one campaign (Phase 12).
// GET /api/integrations/listmonk/campaigns/[id] → { campaign, stats }

import { guardWorkspace, sidecarError } from "../../../_lib";
import { getListmonkCampaign, listmonkCampaignStats } from "@/lib/integrations/listmonk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWorkspace();
    const { id } = await ctx.params;
    const campaignId = Number(id);
    const [campaign, stats] = await Promise.all([
      getListmonkCampaign(campaignId),
      listmonkCampaignStats(campaignId).catch(() => null),
    ]);
    return Response.json({ campaign, stats });
  } catch (e) {
    return sidecarError(e);
  }
}
