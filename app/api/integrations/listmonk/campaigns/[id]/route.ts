// Marketr — Listmonk sidecar: one campaign (Phase 12).
// GET /api/integrations/listmonk/campaigns/[id] → { campaign, stats }

import { guardWorkspace, sidecarError } from "../../../_lib";
import { getListmonkCampaign, listmonkCampaignStats } from "@/lib/integrations/listmonk";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
