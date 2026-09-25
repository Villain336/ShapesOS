// Marketr — POST /api/flywheel/ctv/spots
//
// Per-spot dynamic QR/pURL minting (Phase 5 engine extension). Requires a
// PASSING creative validation — non-compliant creative BLOCKS kit minting.
// Body: { campaignId, destinationUrl, spots: [{ placementLabel, showGenre?,
// daypart?, demo?, creativeId?, flightFrom?, flightTo? }], domain? }

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ctvGuard, badRequest, safetyError, readJson } from "../_lib";
import { resolveCtvStore } from "@/lib/flywheel/ctv/store";
import {
  mintSpotKit,
  checkLandingTaps,
  CTV_QR_GUIDANCE,
} from "@/lib/flywheel/ctv/spot-kit";

export const dynamic = "force-dynamic";

const SpotSchema = z.object({
  placementLabel: z.string().trim().min(1).max(120),
  showGenre: z.string().trim().max(64).optional(),
  daypart: z.string().trim().max(64).optional(),
  demo: z.string().trim().max(64).optional(),
  creativeId: z.string().trim().max(128).optional(),
  flightFrom: z.string().trim().optional(),
  flightTo: z.string().trim().optional(),
});

const MintSchema = z.object({
  campaignId: z.string().trim().min(1).max(64),
  destinationUrl: z.string().trim().url().max(2048),
  spots: z.array(SpotSchema).min(1).max(200),
  domain: z.string().trim().min(3).max(128).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await ctvGuard("editor");
  if (gate instanceof Response) return gate;
  const parsed = MintSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const d = parsed.data;

  try {
    const store = await resolveCtvStore();
    const campaign = await store.getCampaign(gate.workspaceId, d.campaignId);
    if (!campaign) return safetyError(new Error("CTV campaign not found in workspace"));

    // Fail-closed: need a passing validation for the campaign's creative.
    const validations = await store.listValidations(gate.workspaceId);
    const passing = validations.find(
      (v) => v.pass && (v.campaignId === d.campaignId || campaign.creativeIds.includes(v.creativeId)),
    );
    if (!passing) {
      return safetyError(new Error(
        "Spot kit BLOCKED: no passing creative validation for this campaign. " +
        "Validate creative at POST /api/flywheel/ctv/creative/validate first.",
      ));
    }

    const landing = await checkLandingTaps(d.destinationUrl);
    const kit = await mintSpotKit({
      workspaceId: gate.workspaceId,
      campaignId: d.campaignId,
      campaignName: campaign.name,
      validation: {
        pass: passing.pass,
        checks: passing.checks,
        durationSeconds: passing.durationSeconds,
        publisherRulesVersion: passing.publisherRulesVersion,
        probe: passing.ffprobeJson,
      },
      destinationUrl: d.destinationUrl,
      spots: d.spots,
      domain: d.domain,
    });

    for (const s of kit.spots) {
      await store.createSpot({
        workspaceId: gate.workspaceId,
        campaignId: d.campaignId,
        placementLabel: s.placementLabel,
        showGenre: s.showGenre,
        daypart: s.daypart,
        demo: s.demo,
        creativeId: d.spots.find((x) => x.placementLabel === s.placementLabel)?.creativeId ?? null,
        qrId: s.link.id,
        purlId: s.link.id,
        qrSvg: s.qrSvg,
        flightFrom: null,
        flightTo: null,
        status: "active",
      });
    }
    await store.audit({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "spot_kit_minted",
      subjectType: "campaign", subjectId: d.campaignId,
      detail: { spots: kit.spots.length, landingTaps: landing.taps, landingOk: landing.ok },
    });

    return Response.json({
      spots: kit.spots.map((s) => ({
        placementLabel: s.placementLabel,
        showGenre: s.showGenre,
        daypart: s.daypart,
        demo: s.demo,
        publicUrl: s.publicUrl,
        qrSvg: s.qrSvg,
        qrWidthCm: s.qrWidthCm,
      })),
      landing,
      guidance: CTV_QR_GUIDANCE,
    });
  } catch (err) {
    return safetyError(err);
  }
}
