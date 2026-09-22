// Marketr — weekly content-decay detection (milestone 14).
// POST /api/cron/decay
//
// Auth (either), same pattern as /api/cron/fix-agent (milestone 10):
//   1. Signed-in session — runs detection for the user's workspace projects.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs for every project.
//      Schedule weekly (see DEPLOY.md).
//
// For each project: detect decay from 90 days of ranking history, upsert
// findings, auto-resolve recovered pages, and emit content_decay alerts for
// critical findings (milestone 13 hub, best-effort).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { emitAlert } from "@/lib/alerts/evaluate";
import { detectDecayForProject } from "@/lib/retention/decay";

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

  const results: Array<{ projectId: string; domain: string; error?: string } & Record<string, unknown>> = [];
  for (const p of projects) {
    try {
      const summary = await detectDecayForProject(
        p,
        (input) => emitAlert(input),
        async (action, summaryText) => {
          await prisma.fileChangeLog.create({
            data: {
              workspaceId: p.workspaceId,
              projectId: p.id,
              connectionId: null,
              filePath: "",
              actor: "system",
              action,
              summary: summaryText.slice(0, 280),
            },
          });
        },
      );
      results.push({ projectId: p.id, domain: p.domain, ...summary });
    } catch (err) {
      results.push({
        projectId: p.id,
        domain: p.domain,
        error: err instanceof Error ? err.message.slice(0, 200) : "decay detection failed",
      });
    }
  }

  return Response.json({ ok: true, projects: results });
}
