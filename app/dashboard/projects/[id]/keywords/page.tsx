// Marketr — keyword research page (spec §5 flow 1, §7 item 3).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import KeywordResearch from "@/components/KeywordResearch";

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
          className="text-sm text-zinc-500 hover:text-zinc-300"
        >
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          Keyword research
        </h1>
      </div>
      <KeywordResearch projectId={project.id} />
    </div>
  );
}
