// Marketr — competitor keyword-gap analysis (spec §5 flow 2, §7 item 4).
// POST /api/competitors/gap  { projectId, competitorId, limit? }
//   → { competitor, gaps, provider }
// Fetches the competitor's ranked keywords from the swappable
// SeoDataProvider (DataForSEO Labs ranked_keywords live when credentials are
// configured, clearly-marked mock otherwise), then diffs them against the
// project's saved Keyword rows (matched on normalized phrase). Only the gaps
// — keywords they rank for that you don't have — are returned, sorted by
// opportunity score (high volume, low difficulty first).
// Each analysis increments the serp_calls meter (best-effort).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSeoProvider, providerStatus } from "@/lib/providers";
import { normalizePhrase, opportunityScore } from "@/lib/competitors";
import { recordUsage } from "@/lib/usage";
import type { CompetitorKeyword } from "@/lib/providers/types";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; competitorId?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const competitor = await prisma.competitor.findFirst({
    where: {
      id: body.competitorId,
      project: { id: body.projectId, workspace: { ownerUserId: user.id } },
    },
    include: { project: true },
  });
  if (!competitor) {
    return Response.json({ error: "Competitor not found" }, { status: 404 });
  }

  const provider = getSeoProvider();
  const limit = Math.max(1, Math.min(body.limit ?? 50, 200));

  let rows: CompetitorKeyword[];
  try {
    rows = await provider.competitorKeywords({
      domain: competitor.domain,
      limit,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Gap analysis failed";
    return Response.json({ error: message }, { status: 502 });
  }

  const saved = await prisma.keyword.findMany({
    where: { projectId: competitor.project.id },
    select: { phrase: true },
  });
  const savedPhrases = new Set(saved.map((k) => normalizePhrase(k.phrase)));

  const gaps = rows
    .filter((r) => r.phrase && !savedPhrases.has(normalizePhrase(r.phrase)))
    .map((r) => ({
      ...r,
      opportunity: Math.round(opportunityScore(r.volume, r.difficulty)),
    }))
    .sort((a, b) => b.opportunity - a.opportunity);

  await recordUsage(competitor.project.workspaceId, "serp_calls", 1).catch(
    () => {},
  );

  return Response.json({
    competitor: { id: competitor.id, domain: competitor.domain },
    gaps,
    provider: providerStatus(),
  });
}
