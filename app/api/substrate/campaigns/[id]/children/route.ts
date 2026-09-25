// Marketr — Phase 8 G2: sub-campaign routes (HubSpot-style ≤3-level hierarchy).
// GET  /api/substrate/campaigns/:id/children (direct children)
// POST /api/substrate/campaigns/:id/children (create sub-campaign)

import type { NextRequest } from "next/server";
import {
  substrateGuard, badRequest, campaignError, campaignTablesReady, tablesNotReady, readJson,
} from "../../../_lib";
import { createChildCampaign, listChildren } from "@/lib/substrate/campaigns/store";
import { auditEvent } from "@/lib/auditlog";
import type { GrowthCampaignObjective, GrowthCampaignStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const OBJECTIVES: GrowthCampaignObjective[] = ["lead_gen", "sale", "awareness", "retention", "launch"];
const STATUSES: GrowthCampaignStatus[] = ["draft", "active", "paused", "complete", "archived"];

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  try {
    const children = await listChildren(gate.workspaceId, id);
    return Response.json({ children });
  } catch (err) {
    return campaignError(err);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  const body = await readJson(req);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return badRequest("name is required");
  const objective = body.objective as GrowthCampaignObjective;
  if (!OBJECTIVES.includes(objective)) {
    return badRequest(`objective must be one of: ${OBJECTIVES.join(", ")}`);
  }
  const status = body.status as GrowthCampaignStatus | undefined;
  if (status !== undefined && !STATUSES.includes(status)) {
    return badRequest(`status must be one of: ${STATUSES.join(", ")}`);
  }

  try {
    const child = await createChildCampaign(gate.workspaceId, id, {
      name,
      objective,
      status,
      createdBy: gate.userId,
    });
    await auditEvent({
      projectId: null,
      workspaceId: gate.workspaceId,
      action: "campaign_created",
      summary: `Sub-campaign "${child.name}" created under growth campaign ${id}`,
      actorUserId: gate.userId,
    });
    return Response.json({ child }, { status: 201 });
  } catch (err) {
    return campaignError(err);
  }
}
