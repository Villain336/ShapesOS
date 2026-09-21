// Marketr — content engine detail page (spec §5 flow 3).
// Server-loads the ContentItem (with its brief), then hands it to the
// interactive ContentDetail component.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import ContentDetail from "@/components/ContentDetail";
import type { ContentBrief } from "@/lib/content/brief";

export const dynamic = "force-dynamic";

export default async function ContentDetailPage({
  params,
}: {
  params: Promise<{ id: string; contentId: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id, contentId } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: { ownerUserId: user.id } },
    select: { id: true, domain: true },
  });
  if (!project) notFound();

  const contentItem = await prisma.contentItem.findFirst({
    where: { id: contentId, projectId: project.id },
    include: { keyword: { select: { phrase: true } } },
  });
  if (!contentItem) notFound();

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/dashboard/projects/${project.id}/content`}
        className="text-sm text-zinc-500 hover:text-zinc-300"
      >
        ← Content engine · {project.domain}
      </Link>
      <ContentDetail
        projectId={project.id}
        item={{
          id: contentItem.id,
          status: contentItem.status,
          bodyMarkdown: contentItem.bodyMarkdown,
          seoScore: contentItem.seoScore,
          outlineJson: contentItem.outlineJson as ContentBrief | null,
        }}
      />
    </div>
  );
}
