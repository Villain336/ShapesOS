// Marketr — weekly local-competitor refresh (milestone 16).
// POST /api/cron/local-competitors
//
// Auth: signed-in session (own workspace) or CRON_SECRET bearer.
// Schedule weekly (see DEPLOY.md). Competitors refresh only when enabled.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { refreshLocalCompetitors } from "@/lib/local/service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Day-1 hardening (M1): shared cron gate (lib/cron/gate.ts) — CRON_SECRET
  // service call, or signed-in session with editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const projects = await prisma.project.findMany({
    where: {
      ...(isCron ? {} : { workspaceId: sessionWorkspaceId! }),
      localCompetitors: { some: { enabled: true } },
    },
    select: { id: true, domain: true },
  });

  const results: Array<{ projectId: string; domain: string } & Record<string, unknown>> = [];
  for (const p of projects) {
    try {
      const r = await refreshLocalCompetitors(p.id, isCron ? "cron" : `user:${gate.userId}`);
      results.push({ projectId: p.id, domain: p.domain, ...r });
    } catch (err) {
      results.push({
        projectId: p.id,
        domain: p.domain,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown error",
      });
    }
  }
  return Response.json({ ran: results.length, results });
}
