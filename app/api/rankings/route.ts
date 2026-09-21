// Marketr — rank-tracking dashboard data (milestone 5).
// GET /api/rankings?projectId=… → {
//   keywords: [{ id, phrase, volume, difficulty, tracked, latest: {position, url, aiOverviewPresent, checkedAt} | null, previous: {position} | null }],
//   visibilityScore, alerts, lastCheck, provider: { name, isLive }
// }

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { providerStatus } from "@/lib/providers";
import { visibilityScore, computeAlerts, type RankAlert } from "@/lib/rankings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = await prisma.project.findFirst({
    where: { id: projectId ?? undefined, workspace: { ownerUserId: user.id } },
    select: { id: true, domain: true },
  });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const keywords = await prisma.keyword.findMany({
    where: { projectId: project.id },
    orderBy: [{ list: "asc" }, { volume: "desc" }],
    include: {
      rankings: { orderBy: { checkedAt: "desc" }, take: 2 },
    },
  });

  const alerts: RankAlert[] = [];
  let lastCheck: string | null = null;

  const rows = keywords.map((kw) => {
    const [latest, previous] = kw.rankings;
    if (latest) {
      const at = latest.checkedAt.toISOString();
      if (!lastCheck || at > lastCheck) lastCheck = at;
    }
    // Alerts come from the two most recent checks.
    if (latest) {
      alerts.push(
        ...computeAlerts(
          kw.id,
          kw.phrase,
          previous?.position ?? null,
          latest.position ?? null,
          latest.checkedAt,
        ),
      );
    }
    return {
      id: kw.id,
      phrase: kw.phrase,
      volume: kw.volume,
      difficulty: kw.difficulty,
      intent: kw.intent,
      list: kw.list,
      tracked: kw.tracked,
      latest: latest
        ? {
            position: latest.position,
            url: latest.url,
            aiOverviewPresent: latest.aiOverviewPresent,
            checkedAt: latest.checkedAt.toISOString(),
          }
        : null,
      previous: previous ? { position: previous.position } : null,
    };
  });

  const trackedRows = keywords.filter((k) => k.tracked);
  const score = visibilityScore(
    trackedRows.map((k) => ({
      volume: k.volume,
      position: k.rankings[0]?.position ?? null,
    })),
  );

  // Newest alerts first; cap the feed.
  alerts.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));

  return Response.json({
    keywords: rows,
    trackedCount: trackedRows.length,
    visibilityScore: score,
    alerts: alerts.slice(0, 50),
    lastCheck,
    provider: providerStatus(),
  });
}
