// Marketr — GET /api/flywheel/ctv/attribution/:id
//
// Layered, probabilistic CTV attribution (invariant 11): impression pixel,
// view-through windows (modeled), QR/pURL scans (the deterministic slice,
// labeled as such), branded-search-lift template, geo-holdout plan.
// Deterministic CTV ROAS is NEVER presented — asserted structurally on
// every render.

import { ctvGuard, safetyError } from "../../_lib";
import { getCtvStore } from "@/lib/flywheel/ctv/store";
import {
  buildAttributionView,
  assertNoDeterministicRoas,
} from "@/lib/flywheel/ctv/attribution";
import { getMediaStore } from "@/lib/media/store";
import { MarketrLinkEngine } from "@/lib/media/links";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await ctvGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;

  try {
    const store = getCtvStore();
    const campaign = await store.getCampaign(gate.workspaceId, id);
    if (!campaign) return safetyError(new Error("CTV campaign not found in workspace"));

    const spots = await store.listSpots(gate.workspaceId, id);
    const engine = new MarketrLinkEngine(getMediaStore());
    let qrScans = 0;
    for (const spot of spots) {
      if (!spot.qrId) continue;
      try {
        const links = await getMediaStore().listTrackingLinks(gate.workspaceId);
        const link = links.find((l) => l.id === spot.qrId);
        if (link) {
          const a = await engine.getAnalytics(gate.workspaceId, link.slug);
          qrScans += a.scansCount;
        }
      } catch {
        // A single unreadable link must not sink the whole view.
      }
    }

    // Pixel impressions: sum the campaign's pixel rows (pixel route logs
    // impressions to the store; scan/click data never leaves Marketr).
    const pixelRows = await store.listPixels(gate.workspaceId, id);
    const pixelImpressions = pixelRows.reduce((s, p) => s + p.impressionsCount, 0);
    const firstPixel = pixelRows[0] ?? null;
    const view = buildAttributionView({
      campaignId: id,
      pixelUrl: firstPixel?.pixelUrl ?? "no pixel minted yet — POST /api/flywheel/ctv/pixels",
      pixelImpressions,
      viewThroughWindowDays: firstPixel?.viewThroughWindowDays ?? 14,
      conversionsInViewThroughWindow: 0,
      qrScans,
      searchLift: null,
      geoHoldout: null,
    });
    assertNoDeterministicRoas(view);

    await store.audit({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "attribution_viewed",
      subjectType: "campaign", subjectId: id,
      detail: { qrScans },
    });
    return Response.json({ attribution: view, spots: spots.length });
  } catch (err) {
    return safetyError(err);
  }
}
