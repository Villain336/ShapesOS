// Marketr — backlink intelligence dashboard (milestone 15).
// Server page with a client explorer island (filters, cost-preview modal,
// refresh flow, spend-cap management).

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import BacklinksExplorer from "@/components/BacklinksExplorer";
import { monthlyBacklinkSpendUsd } from "@/lib/seo/backlink-pull";
import { DEFAULT_MONTHLY_SPEND_CAP_USD } from "@/lib/seo/backlinks-cost";

export const dynamic = "force-dynamic";

export default async function BacklinksPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true, backlinksEnabled: true },
  });
  if (!project) notFound();

  const canManageSpend = await requireProjectRole(user.id, project.id, "admin");
  const canToggleBacklinks = await requireProjectRole(user.id, project.id, "editor");

  const [links, summaries, counts, workspace] = await Promise.all([
    prisma.backlink.findMany({
      where: { projectId: project.id },
      orderBy: [{ status: "asc" }, { sourceRank: "desc" }],
      take: 500,
    }),
    prisma.backlinkSummary.findMany({
      where: { projectId: project.id },
      orderBy: { date: "desc" },
      take: 30,
    }),
    prisma.backlink.groupBy({
      by: ["status"],
      where: { projectId: project.id },
      _count: true,
    }),
    prisma.workspace.findUnique({
      where: { id: project.workspaceId },
      select: { backlinksSpendCapUsd: true },
    }),
  ]);

  const spendUsedUsd = await monthlyBacklinkSpendUsd(project.workspaceId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-600">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">Backlinks</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Link profile, lost-link tracking, and cost-controlled refreshes. Every pull shows its
          cost before it runs and counts against the workspace monthly budget.
        </p>
      </div>
      <BacklinksExplorer
        projectId={project.id}
        domain={project.domain}
        canManageSpend={Boolean(canManageSpend)}
        canToggleBacklinks={Boolean(canToggleBacklinks)}
        backlinksEnabled={project.backlinksEnabled}
        initialLinks={links.map((l) => ({
          id: l.id,
          sourceDomain: l.sourceDomain,
          sourceUrl: l.sourceUrl,
          targetUrl: l.targetUrl,
          anchorText: l.anchorText,
          dofollow: l.dofollow,
          sourceRank: l.sourceRank,
          spamScore: l.spamScore,
          firstSeen: l.firstSeen?.toISOString() ?? null,
          lastSeen: l.lastSeen?.toISOString() ?? null,
          status: l.status,
        }))}
        initialSummaries={summaries.map((s) => ({
          id: s.id,
          date: s.date.toISOString(),
          total: s.total,
          referringDomains: s.referringDomains,
          dofollowRatio: s.dofollowRatio,
          snapshot: s.snapshot as Record<string, unknown>,
          mock: s.mock,
        }))}
        counts={Object.fromEntries(counts.map((c) => [c.status, c._count]))}
        spend={{
          usedUsd: spendUsedUsd,
          capUsd: workspace?.backlinksSpendCapUsd ?? DEFAULT_MONTHLY_SPEND_CAP_USD,
          custom: workspace?.backlinksSpendCapUsd != null,
          defaultCapUsd: DEFAULT_MONTHLY_SPEND_CAP_USD,
        }}
      />
    </div>
  );
}
