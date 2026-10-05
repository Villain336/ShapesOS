// ShapesOS — analytics home (Phase 4b).
// GET /api/analytics/overview?days=30 | ?from=&to= → AnalyticsOverview (viewer+)
// Traffic (GA4 + Search Console via the connector layer), social
// engagement, attribution by channel and spend for one window.

import { getAnalyticsOverview, parseAnalyticsWindow } from "@/lib/analytics/overview";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace();
    const win = parseAnalyticsWindow(new URL(req.url).searchParams);
    if ("error" in win) return Response.json({ error: win.error }, { status: 400 });
    return Response.json(await getAnalyticsOverview(workspace.id, user.id, win));
  } catch (e) {
    return httpErrorResponse(e);
  }
}
