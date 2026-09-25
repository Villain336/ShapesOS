// Marketr — POST /api/mail/campaigns/[id]/send
//
// Execute the campaign. The money gate lives in lib/mail/service.ts
// executeCampaign(): approved approval + hash/count/spend binding, and
// live mode ONLY when the provider row is in mode "live". Test mode
// (default) renders via the fake provider — nothing is physically mailed.

import type { NextRequest } from "next/server";
import { mailGuard, badRequest } from "../../../_lib";
import { executeCampaign } from "@/lib/mail/service";

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
    const msg = e instanceof Error ? e.message : "Send failed";
    // Refusals are 422 (the request is valid, the money gate said no);
    // unexpected failures are 500.
    const status = msg.startsWith("Refusing to send") ? 422 : 500;
    return Response.json({ error: msg }, { status });
  }
}
