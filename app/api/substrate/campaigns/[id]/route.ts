// Marketr — Phase 8 G2: single campaign routes.
// GET /api/substrate/campaigns/:id (object + stages + links + ancestors)
// PATCH /api/substrate/campaigns/:id (update; archive via status=archived)

import {
  substrateGuard, badRequest, campaignError, campaignTablesReady, tablesNotReady, readJson,
} from "../../_lib";
import {
  getCampaign, updateCampaign, ancestorChain, normalizeStages,
} from "@/lib/substrate/campaigns/store";
import { CAMPAIGN_STAGE_STATUSES, type CampaignStageState } from "@/lib/substrate/campaigns/types";
import { auditEvent } from "@/lib/auditlog";
import type { GrowthCampaignObjective, GrowthCampaignStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const OBJECTIVES: GrowthCampaignObjective[] = ["lead_gen", "sale", "awareness", "retention", "launch"];
const STATUSES: GrowthCampaignStatus[] = ["draft", "active", "paused", "complete", "archived"];

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  try {
    const [campaign, ancestors] = await Promise.all([
      getCampaign(gate.workspaceId, id),
      ancestorChain(gate.workspaceId, id),
    ]);
    return Response.json({ campaign, ancestors });
  } catch (err) {
    return campaignError(err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  const body = await readJson(req);

  const patch: Parameters<typeof updateCampaign>[2] = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return badRequest("name cannot be empty");
    patch.name = body.name.trim();
  }
  if (body.objective !== undefined) {
    if (!OBJECTIVES.includes(body.objective as GrowthCampaignObjective)) {
      return badRequest(`objective must be one of: ${OBJECTIVES.join(", ")}`);
    }
    patch.objective = body.objective as GrowthCampaignObjective;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as GrowthCampaignStatus)) {
      return badRequest(`status must be one of: ${STATUSES.join(", ")}`);
    }
    patch.status = body.status as GrowthCampaignStatus;
  }
  if (body.reportingConfig !== undefined) {
    if (typeof body.reportingConfig !== "object" || body.reportingConfig === null) {
      return badRequest("reportingConfig must be an object");
    }
    patch.reportingConfig = body.reportingConfig as Record<string, unknown>;
  }
  if (body.parentCampaignId !== undefined) {
    if (body.parentCampaignId !== null && typeof body.parentCampaignId !== "string") {
      return badRequest("parentCampaignId must be a string or null");
    }
    patch.parentCampaignId = body.parentCampaignId as string | null;
  }
  if (body.stages !== undefined) {
    if (!Array.isArray(body.stages)) return badRequest("stages must be an array");
    for (const s of body.stages as Array<{ key?: unknown; status?: unknown }>) {
      if (s.status !== undefined && !(CAMPAIGN_STAGE_STATUSES as string[]).includes(String(s.status))) {
        return badRequest(`invalid stage status: ${String(s.status)}`);
      }
    }
    patch.stages = normalizeStages(body.stages) as CampaignStageState[];
  }

  try {
    const campaign = await updateCampaign(gate.workspaceId, id, patch);
    const action = patch.status === "archived" ? "campaign_archived" : "campaign_updated";
    await auditEvent({
      projectId: null,
      workspaceId: gate.workspaceId,
      action,
      summary: `Growth campaign "${campaign.name}" updated (${Object.keys(patch).join(", ") || "no-op"})`,
      actorUserId: gate.userId,
    });
    return Response.json({ campaign });
  } catch (err) {
    return campaignError(err);
  }
}
