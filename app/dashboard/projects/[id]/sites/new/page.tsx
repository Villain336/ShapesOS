// Marketr — AI landing-page builder page (milestone 7), server wrapper.
// Fetches content briefs for the optional keyword → brief → page tie-in.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { llmStatus } from "@/lib/llm";
import SiteBuilder from "@/components/SiteBuilder";

export const dynamic = "force-dynamic";

export default async function NewSitePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: { ownerUserId: user.id } },
    include: {
      contentItems: {
        where: { status: { in: ["brief", "draft", "editing"] } },
        include: { keyword: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      },
    },
  });
  if (!project) notFound();

  const briefs = project.contentItems.map((c) => ({
    id: c.id,
    label: `${c.keyword?.phrase ?? "Untitled"} — ${c.status}`,
  }));
  const llm = llmStatus();

  return (
    <SiteBuilder
      projectId={project.id}
      briefs={briefs}
      llmLive={llm.isLive}
      llmModel={llm.model}
    />
  );
}
