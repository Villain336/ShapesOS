// Marketr — GET /api/media/links/[slug]/analytics (scan analytics).
//
// Computed locally from Marketr's scan ledger — scan data never leaves the DB.

import type { NextRequest } from "next/server";
import { mediaGuard } from "../../../_lib";
import { getMediaStore } from "@/lib/media/store";
import { resolveLinkEngine } from "@/lib/media/links";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const { slug } = await params;

  try {
    const engine = resolveLinkEngine(getMediaStore());
    const analytics = await engine.getAnalytics(gate.workspaceId, decodeURIComponent(slug));
    return Response.json({ analytics, publicUrl: engine.publicUrl(analytics.link) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Analytics failed";
    return Response.json({ error: msg }, { status: msg.includes("not found") ? 404 : 400 });
  }
}
