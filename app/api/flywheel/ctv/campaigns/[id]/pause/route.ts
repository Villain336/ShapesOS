// Marketr — POST /api/flywheel/ctv/campaigns/:id/pause
//
// Two honest paths:
// - Vibe API campaigns: REAL pause via POST /campaigns/{id}/actions
//   { action: PAUSE } (requires the approval object id). Test-mode default.
// - Concierge campaigns (MNTN/Roku/Tatari/tvScientific): ALERT ONLY.
//   "Marketr cannot pause this buy — alerts only." No state change, no
//   fake pause — the function says exactly that.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ctvGuard, badRequest, safetyError, readJson } from "../../../_lib";
import { resolveCtvStore } from "@/lib/flywheel/ctv/store";
import { createVibeAdapter } from "@/lib/flywheel/ctv/vibe";
import {
  requestConciergePause,
  CONCIERGE_ALERT_ONLY_COPY,
  type ConciergeVendor,
} from "@/lib/flywheel/ctv/concierge";
import { createSeatAdapter, type SeatDsp } from "@/lib/flywheel/ctv/seats";

export const dynamic = "force-dynamic";

const PauseSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await ctvGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  const parsed = PauseSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const store = await resolveCtvStore();
    const campaign = await store.getCampaign(gate.workspaceId, id);
    if (!campaign) return safetyError(new Error("CTV campaign not found in workspace"));

    // --- Vibe API path: real pause ---
    if (campaign.mode === "api" && campaign.platform === "vibe") {
      if (!campaign.vibeCampaignId) {
        return badRequest("No Vibe campaign is linked to this ShapesOS campaign yet.");
      }
      if (!campaign.approvalObjectId) {
        return badRequest("An approval object id is required to pause a Vibe buy.");
      }
      const adapter = createVibeAdapter();
      const paused = await adapter.pauseCampaign(campaign.vibeCampaignId, campaign.approvalObjectId);
      await store.updateCampaign(gate.workspaceId, id, { status: "paused" });
      await store.audit({
        workspaceId: gate.workspaceId, actor: gate.userId, action: "campaign_paused",
        subjectType: "campaign", subjectId: id,
        detail: { via: "vibe_api", testMode: paused.testMode, reason: parsed.data.reason },
      });
      return Response.json({ paused: true, via: "vibe_api", testMode: paused.testMode, vibe: paused });
    }

    // --- BYO-seat path: real pause only with a connected seat (fail closed) ---
    if (campaign.mode === "api" && campaign.platform.startsWith("seat:")) {
      const dsp = campaign.platform.slice(5) as SeatDsp;
      const adapter = createSeatAdapter(dsp, store);
      try {
        const res = await adapter.pauseCampaign({
          workspaceId: gate.workspaceId, actor: gate.userId,
          externalCampaignId: campaign.id, approvalObjectId: campaign.approvalObjectId ?? "",
        });
        await store.updateCampaign(gate.workspaceId, id, { status: "paused" });
        return Response.json({ paused: res.paused, via: `seat:${dsp}` });
      } catch (err) {
        // Fail-closed: surface the setup guidance, perform nothing.
        return Response.json(
          { paused: false, via: "seat", alertOnly: true, guidance: (err as Error).message },
          { status: 422 },
        );
      }
    }

    // --- Concierge path: ALERT ONLY. No pause exists to call. ---
    const alert = await requestConciergePause(
      store, gate.workspaceId, id, campaign.platform as ConciergeVendor,
      gate.userId, parsed.data.reason,
    );
    return Response.json({
      paused: false,
      via: "concierge",
      alertOnly: true,
      copy: CONCIERGE_ALERT_ONLY_COPY,
      alert,
    });
  } catch (err) {
    return safetyError(err);
  }
}
