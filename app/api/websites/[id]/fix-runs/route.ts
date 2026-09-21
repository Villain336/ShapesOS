// Marketr — fix run history + one-click revert (milestone 10).
// GET  /api/websites/[id]/fix-runs?projectId=… → recent runs
// POST /api/websites/[id]/fix-runs/[runId]/revert { projectId } → restore pre-change snapshot

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { getSiteIdeProvider, ownedSite } from "@/lib/connectors/source";
import { revertFixRun } from "@/lib/audit/runner";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const site = await ownedSite(user.id, projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const runs = await prisma.fixRun.findMany({
    where: { siteId: site.id },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return Response.json({ ok: true, runs });
}
