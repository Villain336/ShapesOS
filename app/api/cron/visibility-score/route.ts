// Marketr — daily composite visibility score (milestone 14).
// POST /api/cron/visibility-score
//
// Auth (either), same pattern as the other crons:
//   1. Signed-in session — computes for the user's workspace projects.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — computes for every project.
//      Schedule daily (see DEPLOY.md).
//
// Stores one VisibilityScore row per project per day and emits
// visibility_delta on week-over-week movement (milestone 13 hub).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { providerStatus } from "@/lib/providers";
import { emitAlert } from "@/lib/alerts/evaluate";
import { computeAndStoreScore } from "@/lib/retention/visibility-score";

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

  const mock = !providerStatus().isLive;
  const results: Array<Record<string, unknown>> = [];
  for (const p of projects) {
    try {
      const { score, delta } = await computeAndStoreScore(
        p,
        (input) => emitAlert(input),
        async (summary) => {
          await prisma.fileChangeLog.create({
            data: {
              workspaceId: p.workspaceId,
              projectId: p.id,
              connectionId: null,
              filePath: "",
              actor: "system",
              action: "visibility_score_computed",
              summary: summary.slice(0, 280),
            },
          });
        },
        { mock },
      );
      results.push({ projectId: p.id, domain: p.domain, score, delta });
    } catch (err) {
      results.push({
        projectId: p.id,
        domain: p.domain,
        error: err instanceof Error ? err.message.slice(0, 200) : "score computation failed",
      });
    }
  }

  return Response.json({ ok: true, projects: results });
}
