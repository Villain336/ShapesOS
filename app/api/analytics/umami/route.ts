// Marketr — GET /api/analytics/umami
// Umami stats + pageview time-series for the dashboard analytics panel.
// Workspace-guarded; all Umami credentials stay server-side. Without a
// configured Umami sidecar this returns 503 with an honest message — the
// client renders the "connect Umami" empty state.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import {
  UmamiApiError,
  fetchUmamiPageviews,
  fetchUmamiStats,
} from "@/lib/integrations/umami";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export async function GET(req: Request) {
  try {
    await guardWorkspace();
    const url = new URL(req.url);
    const days = Math.min(
      Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1),
      365,
    );
    const endAt = Date.now();
    const startAt = endAt - days * DAY_MS;
    const unit = days <= 2 ? "hour" : days <= 62 ? "day" : "month";

    const [stats, series] = await Promise.all([
      fetchUmamiStats(startAt, endAt),
      fetchUmamiPageviews(startAt, endAt, unit),
    ]);
    return Response.json({ stats, series, days, unit });
  } catch (e) {
    if (e instanceof UmamiApiError && e.status === 0) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    return httpErrorResponse(e);
  }
}
