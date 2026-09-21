// Marketr — trigger a scheduled-style fix run on demand (milestone 10).
// POST /api/websites/[id]/fix-run { projectId } → runs the same eligibility +
// apply pipeline the cron uses. Honest about dry-run mode.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { getSiteIdeProvider, ownedSite, siteIsMock } from "@/lib/connectors/source";
import { runScheduledFixes } from "@/lib/audit/runner";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  if (site.sourceType === "wordpress" || site.sourceType === "webflow") {
    return Response.json({ error: "Fix runs apply to file-based sites only." }, { status: 400 });
  }

  const settings = await prisma.fixAgentSettings.findUnique({ where: { siteId: site.id } });
  if (!settings?.enabled) {
    return Response.json(
      { error: "The fix agent is disabled for this site. Enable it in the fix-agent settings first." },
      { status: 400 },
    );
  }

  try {
    const provider = await getSiteIdeProvider(site);
    const result = await runScheduledFixes({
      siteId: site.id,
      projectId: site.projectId,
      approvedBy: user.id,
      provider,
    });
    return Response.json({ ok: true, mock: siteIsMock(site), ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Fix run failed" },
      { status: 502 },
    );
  }
}
