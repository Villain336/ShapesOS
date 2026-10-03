// Marketr — /api/mail/campaigns/[id]/estimate
// GET → cost estimate: per-piece line items + verification fees + hosted
//        margin preview. The approval binds maxSpendCents from this.

import type { NextRequest } from "next/server";
import { mailGuard } from "../../../_lib";
import { estimateCampaign } from "@/lib/mail/service";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  try {
    const estimate = await estimateCampaign(gate.workspaceId, id);
    return Response.json({ ...estimate, campaignId: id });
  } catch (e) {
    return errorResponse(e);
  }
}
