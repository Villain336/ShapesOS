// Marketr — Attribution API: per-channel performance under all three models.
// GET /api/attribution/channels?from=&to=&pipelineId=
// Leads/CPL/spend are model-independent; customers/CAC/revenue/ROAS are
// reported per model in `perModel`.
// Phase 4b: the social_organic row carries `engagement` (impressions, likes,
// comments, shares, clicks from social_post_metrics in the window), and is
// present even before any social lead arrives.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getAttributionReport, resolveWindow } from "@/lib/attribution/report";
import { ATTRIBUTION_MODELS, type AttributionModel } from "@/lib/attribution/models";
import { SOCIAL_CHANNEL } from "@/lib/attribution/social";
import { getSocialEngagement, type EngagementNumbers } from "@/lib/social/engagement";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const win = await resolveWindow(workspace.id, sp);
  if (!win.ok) return Response.json({ error: win.error }, { status: 400 });

  const [{ report }, social] = await Promise.all([
    getAttributionReport(workspace.id, win.window),
    getSocialEngagement(workspace.id, win.window).catch(() => null),
  ]);
  const base = report.linear.channels;
  const byChannel = new Map(base.map((c) => [c.channel, c]));

  const channels = [...byChannel.entries()].map(([channel, b]) => {
    const perModel = {} as Record<AttributionModel, { customers: number; cacCents: number | null; revenueCents: number; roas: number | null }>;
    for (const m of ATTRIBUTION_MODELS) {
      const c = report[m].channels.find((x) => x.channel === channel)!;
      perModel[m] = { customers: c.customers, cacCents: c.cacCents, revenueCents: c.revenueCents, roas: c.roas };
    }
    return {
      channel,
      leads: b.leads,
      spendCents: b.spendCents,
      cplCents: b.cplCents,
      perModel,
      ...(channel === SOCIAL_CHANNEL && social ? { engagement: social.totals as EngagementNumbers } : {}),
    };
  });

  if (social && social.totals.impressions + social.totals.engagements > 0 && !byChannel.has(SOCIAL_CHANNEL)) {
    const none = { customers: 0, cacCents: null, revenueCents: 0, roas: null };
    channels.push({
      channel: SOCIAL_CHANNEL,
      leads: 0,
      spendCents: 0,
      cplCents: null,
      perModel: { first_touch: none, last_touch: none, linear: none },
      engagement: social.totals,
    });
  }

  return Response.json({ channels });
}
