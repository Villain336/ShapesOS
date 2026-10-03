// Marketr — POST /api/mail/campaigns/[id]/send
//
// Execute the campaign. The money gate lives in lib/mail/service.ts
// executeCampaign(): approved approval + hash/count/spend binding, and
// live mode ONLY when the provider row is in mode "live". Test mode
// (default) renders via the fake provider — nothing is physically mailed.

import type { NextRequest } from "next/server";
import { mailGuard } from "../../../_lib";
import { executeCampaign } from "@/lib/mail/service";
import { HttpError, errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  try {
    const result = await executeCampaign(gate.workspaceId, id);
    return Response.json({ ...result, campaignId: id });
  } catch (e) {
    // Money-gate refusals are 422 (the request is valid, the gate said no);
    // everything else maps through the shared helper (404/409, or a generic
    // 500 that never echoes the underlying error).
    if (e instanceof HttpError && e.message.startsWith("Refusing to send")) {
      return Response.json({ error: e.message }, { status: 422 });
    }
    return errorResponse(e, "POST /api/mail/campaigns/[id]/send");
  }
}
