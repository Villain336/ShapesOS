// Marketr — Physical attribution kit API: bundle stats.
// GET /api/attribution/bundles/[id]/stats?from=&to= → scans, calls,
// redemptions, leads touched, attributed revenue per model (C2 report,
// summed across channels for the bundle's campaign).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getBundle, bundleStats } from "@/lib/physical/bundles";
import { resolveWindow } from "@/lib/attribution/report";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const { id } = await ctx.params;
  const bundle = await getBundle(workspace.id, id);
  if (!bundle) return Response.json({ error: "Not found" }, { status: 404 });

  const sp = new URL(req.url).searchParams;
  const win = await resolveWindow(workspace.id, sp);
  const stats = await bundleStats(bundle, win.ok ? win.window : undefined);
  return Response.json({ stats, campaignName: bundle.campaignName });
}
