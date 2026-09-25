// Marketr — GET /api/flywheel/ctv/campaigns/:id

import { ctvGuard, safetyError } from "../../_lib";
import { getCtvStore } from "@/lib/flywheel/ctv/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await ctvGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  try {
    const store = getCtvStore();
    const campaign = await store.getCampaign(gate.workspaceId, id);
    if (!campaign) return safetyError(new Error("CTV campaign not found in workspace"));
    const spots = await store.listSpots(gate.workspaceId, id);
    return Response.json({ campaign, spots });
  } catch (err) {
    return safetyError(err);
  }
}
