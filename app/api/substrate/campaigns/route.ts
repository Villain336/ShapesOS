// Marketr — Phase 8 G2: campaign collection routes.
// POST /api/substrate/campaigns (create) · GET /api/substrate/campaigns (list)

import type { NextRequest } from "next/server";
import {
  substrateGuard, badRequest, campaignError, campaignTablesReady, tablesNotReady, readJson,
} from "../_lib";
import { createCampaign, listCampaigns } from "@/lib/substrate/campaigns/store";
import { auditEvent } from "@/lib/auditlog";
import type { GrowthCampaignObjective, GrowthCampaignStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const OBJECTIVES: GrowthCampaignObjective[] = ["lead_gen", "sale", "awareness", "retention", "launch"];
const STATUSES: GrowthCampaignStatus[] = ["draft", "active", "paused", "complete", "archived"];

export async function GET(req: NextRequest) {
  const gate = await substrateGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  try {
    const campaigns = await listCampaigns(gate.workspaceId, {
      status: status && (STATUSES as string[]).includes(status) ? (status as GrowthCampaignStatus) : undefined,
      q: sp.get("q") ?? undefined,
    });
    return Response.json({ campaigns });
  } catch (err) {
    return campaignError(err);
  }
}

export async function POST(req: NextRequest) {
  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
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
  const parentCampaignId =
    body.parentCampaignId === null || body.parentCampaignId === undefined
      ? null
      : typeof body.parentCampaignId === "string"
        ? body.parentCampaignId
        : undefined;
  if (parentCampaignId === undefined) return badRequest("parentCampaignId must be a string or null");

  try {
    const campaign = await createCampaign(gate.workspaceId, {
      name,
      objective,
      status,
      parentCampaignId,
      reportingConfig: (body.reportingConfig as Record<string, unknown>) ?? {},
      createdBy: gate.userId,
    });
    await auditEvent({
      projectId: null,
      workspaceId: gate.workspaceId,
      action: "campaign_created",
      summary: `Growth campaign "${campaign.name}" created (objective ${campaign.objective})`,
      actorUserId: gate.userId,
    });
    return Response.json({ campaign }, { status: 201 });
  } catch (err) {
    return campaignError(err);
  }
}
