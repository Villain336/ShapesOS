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
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { providerStatus } from "@/lib/providers";
import { emitAlert } from "@/lib/alerts/evaluate";
import { computeAndStoreScore } from "@/lib/retention/visibility-score";

export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  const isCron = cronAuthorized(req);
  const user = isCron ? null : await requireUser();
  if (!isCron && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projects = await prisma.project.findMany({
    where: isCron ? {} : { workspaceId: (await getOrCreateWorkspace(user!.id, user!.email)).id },
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
