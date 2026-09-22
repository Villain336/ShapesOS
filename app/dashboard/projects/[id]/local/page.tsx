// Marketr — local SEO dashboard (milestone 16).
// Server page with a client tabbed island (geo-grids, competitors, reviews).
// GBP surfaces are flag-gated backend-side and intentionally not rendered.

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { monthlyLocalSpendUsd } from "@/lib/local/service";
import { DEFAULT_LOCAL_SPEND_CAP_USD } from "@/lib/seo/local-cost";
import LocalSeoTabs from "@/components/LocalSeoTabs";

export const dynamic = "force-dynamic";

export default async function LocalSeoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const canEdit = await requireProjectRole(user.id, project.id, "editor");

  const [grids, competitors, reviewSummary, sentimentCounts, workspace, spendUsedUsd] =
    await Promise.all([
      prisma.localGrid.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: "desc" },
        include: {
          results: { orderBy: { runAt: "desc" }, take: 1 },
          _count: { select: { results: true } },
        },
      }),
      prisma.localCompetitor.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: "desc" },
        include: { snapshots: { orderBy: { date: "desc" }, take: 2 } },
      }),
      prisma.reviewSummary.findFirst({
        where: { projectId: project.id },
        orderBy: { periodStart: "desc" },
      }),
      prisma.review.groupBy({
        by: ["sentiment"],
        where: { projectId: project.id },
        _count: true,
      }),
      prisma.workspace.findUnique({
        where: { id: project.workspaceId },
        select: { localSeoSpendCapUsd: true },
      }),
      monthlyLocalSpendUsd(project.workspaceId),
    ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/dashboard/projects/${project.id}`}
          className="text-sm text-zinc-500 hover:text-zinc-600"
        >
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Local SEO</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Geo-grid rank tracking, local competitor intelligence, and review monitoring.
          Maps SERP runs are metered — every run shows its cost before it runs and counts
          against the workspace monthly budget.
        </p>
      </div>
      <LocalSeoTabs
        projectId={project.id}
        canEdit={Boolean(canEdit)}
        initialGrids={grids.map((g) => ({
          id: g.id,
          name: g.name,
          keyword: g.keyword,
          businessName: g.businessName,
          centerLat: g.centerLat,
          centerLng: g.centerLng,
          radiusMiles: g.radiusMiles,
          gridSize: g.gridSize,
          schedule: g.schedule,
          enabled: g.enabled,
          lastRunAt: g.lastRunAt?.toISOString() ?? null,
          runCount: g._count.results,
          latest: g.results[0]
            ? {
                runAt: g.results[0].runAt.toISOString(),
                coveragePct: g.results[0].coveragePct,
                avgPosition: g.results[0].avgPosition,
                cells: (g.results[0].cells as unknown[]).length,
                mock: g.results[0].mock,
              }
            : null,
        }))}
        initialCompetitors={competitors.map((c) => ({
          id: c.id,
          businessName: c.businessName,
          placeId: c.placeId,
          domain: c.domain,
          lat: c.lat,
          lng: c.lng,
          enabled: c.enabled,
          lastSnapshotAt: c.lastSnapshotAt?.toISOString() ?? null,
          snapshots: c.snapshots.map((s) => ({
            id: s.id,
            date: s.date.toISOString(),
            rating: s.rating,
            reviewCount: s.reviewCount,
            categories: s.categories,
            address: s.address,
            mock: s.mock,
          })),
        }))}
        reviewSummary={
          reviewSummary
            ? {
                avgRating: reviewSummary.avgRating,
                count: reviewSummary.count,
                posCount: reviewSummary.posCount,
                neuCount: reviewSummary.neuCount,
                negCount: reviewSummary.negCount,
                topThemes: (reviewSummary.topThemes as Array<{ theme: string; count: number }>) ?? [],
                periodStart: reviewSummary.periodStart.toISOString(),
              }
            : null
        }
        sentimentCounts={Object.fromEntries(sentimentCounts.map((c) => [c.sentiment, c._count]))}
        spend={{
          usedUsd: spendUsedUsd,
          capUsd: workspace?.localSeoSpendCapUsd ?? DEFAULT_LOCAL_SPEND_CAP_USD,
        }}
      />
    </div>
  );
}
