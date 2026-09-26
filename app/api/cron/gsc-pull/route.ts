// Marketr — Phase 10 M1: scheduled GSC snapshot pull.
// POST /api/cron/gsc-pull
//
// Auth: CRON_SECRET service call (all workspaces) or signed-in session with
// editor+ on their workspace (cronGate). Schedule hourly (see DEPLOY.md):
// pulls the last 3h of HOURLY_ALL data for every project with a GSC binding,
// so the delta engine and M2's radar always have fresh hourly coverage.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { pullSnapshots } from "@/lib/intelligence/gsc";
import { GSC_CONNECTOR_KEY } from "@/lib/intelligence/gsc";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const bindings = await prisma.projectDataSource.findMany({
    where: {
      connectorKey: GSC_CONNECTOR_KEY,
      ...(isCron ? {} : { project: { workspaceId: sessionWorkspaceId! } }),
    },
    include: {
      project: { select: { id: true, workspaceId: true, domain: true } },
      connection: { select: { status: true } },
    },
  });

  const end = new Date();
  const start = new Date(end.getTime() - 3 * 60 * 60 * 1000); // last 3h, hourly
  const results: Array<Record<string, unknown>> = [];

  for (const b of bindings) {
    if (b.connection.status !== "active") {
      results.push({ projectId: b.project.id, domain: b.project.domain, skipped: "connection not active" });
      continue;
    }
    try {
      const r = await pullSnapshots(b.project.workspaceId, b.project.id, { start, end }, "hourly");
      results.push({ projectId: b.project.id, domain: b.project.domain, ...r });
    } catch (err) {
      results.push({
        projectId: b.project.id,
        domain: b.project.domain,
        error: err instanceof Error ? err.message.slice(0, 200) : "pull failed",
      });
    }
  }

  return Response.json({ ok: true, projects: results });
}
