// Marketr — revert a fix-agent run (milestone 10).
// POST /api/websites/[id]/fix-runs/[runId]/revert { projectId }
// Restores every file from the run's pre-change snapshot and re-opens the issues.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { getSiteIdeProvider, ownedSite } from "@/lib/connectors/source";
import { revertFixRun } from "@/lib/audit/runner";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, runId } = await params;
  const body = await readJsonBody<{ projectId?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  try {
    const provider = await getSiteIdeProvider(site);
    const result = await revertFixRun({
      siteId: site.id,
      projectId: site.projectId,
      runId,
      provider,
      approvedBy: user.id,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Revert failed" },
      { status: 502 },
    );
  }
}
