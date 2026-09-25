// Marketr — studio creative format registry API (Phase 4, T2).
// GET /api/studio/creatives/formats
// The wizard and filters read channel templates + format tracks from here so
// future channels (email/social) appear automatically when defined in
// lib/studio/formats.ts — no UI rework.

import { CHANNEL_TEMPLATES } from "@/lib/studio/formats";
import { creativeErrorResponse, guardWorkspace } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace();
    return Response.json({ channelTemplates: CHANNEL_TEMPLATES });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
