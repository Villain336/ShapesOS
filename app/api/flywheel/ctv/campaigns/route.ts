// Marketr — POST /api/flywheel/ctv/campaigns
//
// Create a CTV campaign: mode "api" (Vibe adapter) or "concierge"
// (MNTN/Roku/Tatari/tvScientific). Vibe mutations require a Phase 5
// per-buy approval object id; test-mode is the default (never real spend).
// Autopilot drafts, never executes — creation is a human action.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ctvGuard, badRequest, safetyError, readJson } from "../_lib";
import {
  getCtvStore,
  type CtvPlatform,
  type CtvMode,
} from "@/lib/flywheel/ctv/store";
import { createVibeAdapter } from "@/lib/flywheel/ctv/vibe";

export const dynamic = "force-dynamic";

const PLATFORMS = ["vibe", "mntn", "roku", "tatari", "tvscientific", "seat:ttd", "seat:dv360", "seat:amazon", "seat:basis"] as const;

const CreateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  platform: z.enum(PLATFORMS),
  mode: z.enum(["api", "concierge"]),
  approvalObjectId: z.string().trim().min(1).max(64).optional(),
  budgetCents: z.number().int().positive().max(100_000_000_00).optional(),
  flightStart: z.string().trim().optional(),
  flightEnd: z.string().trim().optional(),
  targeting: z.record(z.string(), z.unknown()).optional(),
  creativeIds: z.array(z.string().trim().min(1)).max(20).optional(),
  creativeHashes: z.array(z.string().trim().length(64)).max(20).optional(),
  vibeAdvertiserId: z.string().trim().min(1).max(64).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await ctvGuard("editor");
  if (gate instanceof Response) return gate;
  const parsed = CreateCampaignSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const d = parsed.data;

  // Vibe (API mode) requires an approval object: every dollar human-signed.
  if (d.mode === "api" && d.platform === "vibe" && !d.approvalObjectId) {
    return badRequest("approvalObjectId is required for Vibe API campaigns (every spend action behind a Phase 5 per-buy approval object).");
  }

  const store = getCtvStore();
  try {
    const campaign = await store.createCampaign({
      workspaceId: gate.workspaceId,
      name: d.name,
      platform: d.platform as CtvPlatform,
      mode: d.mode as CtvMode,
      status: "draft",
      approvalObjectId: d.approvalObjectId ?? null,
      budgetCents: d.budgetCents ?? null,
      currency: "USD",
      flightStart: d.flightStart ? new Date(d.flightStart) : null,
      flightEnd: d.flightEnd ? new Date(d.flightEnd) : null,
      targetingJson: d.targeting ?? null,
      creativeIds: d.creativeIds ?? [],
      creativeHashes: d.creativeHashes ?? [],
      vibeAdvertiserId: d.vibeAdvertiserId ?? null,
      vibeCampaignId: null,
      vibeTestMode: true,
      vibeConfigRef: null,
      createdBy: gate.userId,
    });

    // API mode: create the campaign in Vibe (test-mode default; never real spend).
    let vibe: unknown = null;
    if (d.mode === "api" && d.platform === "vibe" && d.vibeAdvertiserId) {
      const adapter = createVibeAdapter();
      vibe = await adapter.createCampaign({
        advertiserId: d.vibeAdvertiserId,
        name: d.name,
        approvalObjectId: d.approvalObjectId!,
        ...(d.budgetCents !== undefined ? { strategyBudgetCents: d.budgetCents } : {}),
      });
      await store.updateCampaign(gate.workspaceId, campaign.id, {
        vibeCampaignId: (vibe as { id: string }).id,
        vibeTestMode: (vibe as { testMode: boolean }).testMode,
      });
      await store.audit({
        workspaceId: gate.workspaceId, actor: gate.userId, action: "vibe_call",
        subjectType: "campaign", subjectId: campaign.id,
        detail: { op: "createCampaign", testMode: (vibe as { testMode: boolean }).testMode, approvalObjectId: d.approvalObjectId },
      });
    }

    await store.audit({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "campaign_created",
      subjectType: "campaign", subjectId: campaign.id,
      detail: { platform: d.platform, mode: d.mode, approvalObjectId: d.approvalObjectId ?? null },
    });
    return Response.json({ campaign, vibe });
  } catch (err) {
    return safetyError(err);
  }
}
