// Marketr — rank tracking dashboard page (milestone 5, spec §5 flow 4).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import RankingsDashboard from "@/components/RankingsDashboard";

export const dynamic = "force-dynamic";

export default async function RankingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
  });
  if (!project) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/dashboard/projects/${project.id}`}
          className="text-sm text-zinc-500 hover:text-zinc-600"
        >
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Rank tracking</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Track positions over time, watch the visibility score, and catch big
          movers.
        </p>
      </div>
      <RankingsDashboard projectId={project.id} domain={project.domain} />
    </div>
  );
}
