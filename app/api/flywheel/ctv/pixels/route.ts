// Marketr — POST /api/flywheel/ctv/pixels
//
// Mint an impression pixel for a CTV campaign. Body: { campaignId,
// viewThroughWindowDays? (1|7|14|30) } → { pixel, pixelUrl }

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ctvGuard, badRequest, safetyError, readJson } from "../_lib";
import { resolveCtvStore } from "@/lib/flywheel/ctv/store";
import { signPixelToken, pixelUrl, pixelSigningSecret } from "@/lib/flywheel/ctv/attribution";

export const dynamic = "force-dynamic";

const MintPixelSchema = z.object({
  campaignId: z.string().trim().min(1).max(64),
  viewThroughWindowDays: z.union([z.literal(1), z.literal(7), z.literal(14), z.literal(30)]).optional(),
});

function pixelSecret(): string {
  // Production must set PIXEL_SIGNING_SECRET (throws otherwise — fail closed).
  return pixelSigningSecret();
}

export async function POST(req: NextRequest) {
  const gate = await ctvGuard("editor");
  if (gate instanceof Response) return gate;
  const parsed = MintPixelSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const store = await resolveCtvStore();
    const campaign = await store.getCampaign(gate.workspaceId, parsed.data.campaignId);
    if (!campaign) return safetyError(new Error("CTV campaign not found in workspace"));

    // Token is campaign-scoped (HMAC over campaign id), minted before the row.
    const token = signPixelToken(campaign.id, pixelSecret());
    const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const pixel = await store.createPixel({
      workspaceId: gate.workspaceId,
      campaignId: campaign.id,
      pixelUrl: "", // filled with the real id below
      pixelToken: token,
      viewThroughWindowDays: parsed.data.viewThroughWindowDays ?? 14,
      impressionsCount: 0,
    });
    const url = pixelUrl(base, pixel.id, token);
    return Response.json({ pixel: { ...pixel, pixelUrl: url }, pixelUrl: url });
  } catch (err) {
    return safetyError(err);
  }
}
