// Marketr — weekly competitor radar (milestone 14).
// POST /api/cron/radar
//
// Auth (either), same pattern as /api/cron/decay:
//   1. Signed-in session — runs for the user's workspace projects.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs for every project.
//      Schedule weekly (see DEPLOY.md).
//
// For each project × competitor: capture a keyword snapshot via the existing
// SEO provider's competitorKeywords() (DataForSEO Labs when live), diff
// against the previous snapshot, persist radar events, and emit one
// competitor_radar summary alert per competitor (best-effort).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getSeoProvider, providerStatus } from "@/lib/providers";
import { emitAlert } from "@/lib/alerts/evaluate";
import { captureAndDiffCompetitor, type SnapshotKeyword } from "@/lib/retention/radar";

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
    select: {
      id: true,
      workspaceId: true,
      domain: true,
      competitors: { select: { domain: true } },
    },
  });

  const provider = getSeoProvider();
  const live = providerStatus().isLive;

  const results: Array<Record<string, unknown>> = [];
  for (const p of projects) {
    for (const c of p.competitors) {
      try {
        const { events } = await captureAndDiffCompetitor(
          { id: p.id, workspaceId: p.workspaceId, domain: p.domain },
          c.domain,
          async (): Promise<SnapshotKeyword[]> => {
            const rows = await provider.competitorKeywords({ domain: c.domain, limit: 50 });
            return rows.map((r) => ({
              phrase: r.phrase,
              position: r.position,
              url: r.url,
              volume: r.volume,
            }));
          },
          !live,
          (input) => emitAlert(input),
          async (action, summary) => {
            await prisma.fileChangeLog.create({
              data: {
                workspaceId: p.workspaceId,
                projectId: p.id,
                connectionId: null,
                filePath: "",
                actor: "system",
                action,
                summary: summary.slice(0, 280),
              },
            });
          },
        );
        results.push({ projectId: p.id, competitor: c.domain, events: events.length });
      } catch (err) {
        results.push({
          projectId: p.id,
          competitor: c.domain,
          error: err instanceof Error ? err.message.slice(0, 200) : "radar failed",
        });
      }
    }
  }

  return Response.json({ ok: true, competitors: results, mock: !live });
}
