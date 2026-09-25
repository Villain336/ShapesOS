// Marketr — Phase 8 G2: link management.
// DELETE /api/substrate/campaigns/:id/links/:linkId — surgical unlink.
// PATCH  /api/substrate/campaigns/:id/links/:linkId — move the link's stage ref.

import {
  substrateGuard, campaignError, campaignTablesReady, tablesNotReady, readJson, badRequest,
} from "../../../../_lib";
import { detachLink, updateLinkStage } from "@/lib/substrate/campaigns/store";
import { CAMPAIGN_STAGES, type CampaignStageKey } from "@/lib/substrate/campaigns/types";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; linkId: string }> }) {  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id, linkId } = await ctx.params;
  try {
    const result = await detachLink(gate.workspaceId, id, linkId);
    await auditEvent({
      projectId: null,
      workspaceId: gate.workspaceId,
      action: "campaign_link_detached",
      summary: `Detached link ${linkId} from growth campaign ${id} (fragment row untouched)`,
      actorUserId: gate.userId,
    });
    return Response.json(result);
  } catch (err) {
    return campaignError(err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; linkId: string }> }) {
  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id, linkId } = await ctx.params;
  const body = await readJson(req);
  const stageKey = typeof body.stageKey === "string" ? body.stageKey : "";
  if (!(CAMPAIGN_STAGES as readonly string[]).includes(stageKey)) {
    return badRequest(`stageKey must be one of: ${CAMPAIGN_STAGES.join(", ")}`);
  }
  try {
    const result = await updateLinkStage(gate.workspaceId, id, linkId, { stageKey: stageKey as CampaignStageKey });
    await auditEvent({
      projectId: null,
      workspaceId: gate.workspaceId,
      action: "campaign_updated",
      summary: `Moved link ${linkId} to stage ${stageKey} on growth campaign ${id}`,
      actorUserId: gate.userId,
    });
    return Response.json(result);
  } catch (err) {
    return campaignError(err);
  }
}
