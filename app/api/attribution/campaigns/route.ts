// Marketr — Attribution API: per-campaign performance under all three models.
// GET /api/attribution/campaigns?from=&to=&pipelineId=
// Campaigns are grouped by (channel, campaign); campaign-scoped spend rows
// match exactly, channel-level spend stays at the channel level.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getAttributionReport, resolveWindow } from "@/lib/attribution/report";
import { ATTRIBUTION_MODELS, type AttributionModel } from "@/lib/attribution/models";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const win = await resolveWindow(workspace.id, sp);
  if (!win.ok) return Response.json({ error: win.error }, { status: 400 });

  const { report } = await getAttributionReport(workspace.id, win.window);
  const base = report.linear.campaigns;
  const key = (c: string, cp: string | null) => `${c}\n${cp ?? ""}`;

  const campaigns = base.map((b) => {
    const perModel = {} as Record<AttributionModel, { customers: number; cacCents: number | null; revenueCents: number; roas: number | null }>;
    for (const m of ATTRIBUTION_MODELS) {
      const c = report[m].campaigns.find((x) => key(x.channel, x.campaign) === key(b.channel, b.campaign))!;
      perModel[m] = { customers: c.customers, cacCents: c.cacCents, revenueCents: c.revenueCents, roas: c.roas };
    }
    return {
      channel: b.channel,
      campaign: b.campaign,
      leads: b.leads,
      spendCents: b.spendCents,
      cplCents: b.cplCents,
      perModel,
    };
  });

  return Response.json({ campaigns });
}
