// Marketr — competitor keyword-gap page (spec §5 flow 2, §7 item 4).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import CompetitorGap from "@/components/CompetitorGap";

export const dynamic = "force-dynamic";

export default async function CompetitorsPage({
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
        <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">
          Competitor keyword gap
        </h1>
      </div>
      <CompetitorGap projectId={project.id} />
    </div>
  );
}
