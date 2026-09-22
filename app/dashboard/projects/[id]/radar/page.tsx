// Marketr — competitor radar feed (milestone 14).
// Server page with a client feed island (filter by competitor, mark read).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import RadarFeed from "@/components/RadarFeed";

export const dynamic = "force-dynamic";

export default async function RadarPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
  });
  if (!project) notFound();

  const [events, competitors] = await Promise.all([
    prisma.competitorRadarEvent.findMany({
      where: { projectId: project.id },
      orderBy: { detectedAt: "desc" },
      take: 200,
    }),
    prisma.competitor.findMany({
      where: { projectId: project.id },
      orderBy: { domain: "asc" },
      select: { domain: true },
    }),
  ]);

  const unread = events.filter((e) => !e.read).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-600">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Competitor radar</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Weekly movement digest: new competitor keywords, ranking gains, new pages, and head-to-head losses.
          {unread > 0 ? ` ${unread} unread.` : " All caught up."}
        </p>
      </div>
      <RadarFeed
        projectId={project.id}
        initialEvents={events.map((e) => ({
          id: e.id,
          competitorDomain: e.competitorDomain,
          eventType: e.eventType,
          keywordPhrase: e.keywordPhrase,
          details: e.details as Record<string, unknown>,
          detectedAt: e.detectedAt.toISOString(),
          read: e.read,
        }))}
        competitors={competitors.map((c) => c.domain)}
      />
    </div>
  );
}
