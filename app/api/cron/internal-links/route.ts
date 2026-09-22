// Marketr — weekly internal-link suggestion refresh (milestone 15).
// POST /api/cron/internal-links
//
// Auth (either), same pattern as /api/cron/decay (milestone 14):
//   1. Signed-in session — refreshes the user's workspace projects.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — every project.
//      Schedule weekly (see DEPLOY.md).
//
// Pure compute + suggestion rows; never edits pages. Applying a suggestion
// stays a supervised UI action (creates a fix-agent inbox issue).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { refreshInternalLinkSuggestions } from "@/lib/seo/internal-links-sync";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Day-1 hardening (M1): shared cron gate (lib/cron/gate.ts) — CRON_SECRET
  // service call, or signed-in session with editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const projects = await prisma.project.findMany({
    where: isCron ? {} : { workspaceId: sessionWorkspaceId! },
    select: { id: true, workspaceId: true, domain: true },
  });

  const results: Array<{ projectId: string; domain: string } & Record<string, unknown>> = [];
  for (const p of projects) {
    try {
      const summary = await refreshInternalLinkSuggestions(p.id, p.workspaceId);
      results.push({ projectId: p.id, domain: p.domain, ...summary });
    } catch (err) {
      results.push({
        projectId: p.id,
        domain: p.domain,
        error: err instanceof Error ? err.message.slice(0, 200) : "internal-link refresh failed",
      });
    }
  }

  return Response.json({ ok: true, projects: results });
}
