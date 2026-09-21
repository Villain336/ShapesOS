// Marketr — site IDE page (milestone 6): supervised rung of the fix-agent
// trust ladder. Browse/edit client site files over SFTP (or the demo mock
// site), with an AI assistant that proposes diffs the user must approve.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { llmStatus } from "@/lib/llm";
import { publicConnection } from "@/lib/sitefiles";
import SiteIde from "@/components/SiteIde";

export const dynamic = "force-dynamic";

export default async function IdePage({
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
      siteConnections: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!project) notFound();

  return (
    <SiteIde
      projectId={project.id}
      domain={project.domain}
      initialConnections={project.siteConnections.map(publicConnection)}
      llm={llmStatus()}
    />
  );
}
