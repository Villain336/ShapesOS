// Marketr — keyword research page (spec §5 flow 1, §7 item 3).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import KeywordResearch from "@/components/KeywordResearch";
import KeywordResearchTask from "@/components/KeywordResearchTask";

export const dynamic = "force-dynamic";

export default async function KeywordsPage({
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
          className="text-sm text-muted hover:text-ink"
        >
          ← {project.domain}
        </Link>
        <h1 className="aos-heading mt-1 text-ink">
          Keyword research
        </h1>
      </div>
      <KeywordResearch projectId={project.id} />
      <KeywordResearchTask projectId={project.id} />
    </div>
  );
}
