// Marketr — internal-linking suggestions dashboard (milestone 15).
// Server page with a client list island (apply/dismiss — supervised).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import InternalLinksList from "@/components/InternalLinksList";

export const dynamic = "force-dynamic";

export default async function InternalLinksPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, domain: true },
  });
  if (!project) notFound();

  const suggestions = await prisma.internalLinkSuggestion.findMany({
    where: { projectId: project.id },
    orderBy: { score: "desc" },
    take: 200,
  });

  const pending = suggestions.filter((s) => s.status === "pending").length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-muted hover:text-ink">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-xl font-heading tracking-heading stretch-heading text-ink">Internal links</h1>
        <p className="mt-1 text-sm text-muted">
          Orphan pages, under-linked money pages, and keyword-relevant link opportunities —
          computed from your ranking data. Applying a suggestion files it in the fix-agent
          inbox for review; pages are never edited automatically.
          {pending > 0 ? ` ${pending} pending.` : " All caught up."}
        </p>
      </div>
      <InternalLinksList
        projectId={project.id}
        initial={suggestions.map((s) => ({
          id: s.id,
          sourceUrl: s.sourceUrl,
          targetUrl: s.targetUrl,
          suggestedAnchor: s.suggestedAnchor,
          reason: s.reason,
          score: s.score,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
