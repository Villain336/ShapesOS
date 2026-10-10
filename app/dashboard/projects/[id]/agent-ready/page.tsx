// ShapesOS — Phase 21A (WS=agentweb): Agent readiness (/dashboard/projects/[id]/agent-ready).
// A tab of the SEO app next to AI search: the score, the fixes and whether an agent can
// complete the site's top tasks. Any member can read it; saving a draft needs editor.

import { notFound } from "next/navigation";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getI18n } from "@/lib/i18n/server";
import { AgentReadyApp } from "@/components/agentready/AgentReadyApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("agentReady.title")} — ShapesOS`, description: t("agentReady.subtitle") };
}

export default async function AgentReadyPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, domain: true },
  });
  if (!project) notFound();
  const [sites, canDraft] = await Promise.all([
    prisma.site.findMany({ where: { projectId: project.id }, select: { id: true, name: true }, orderBy: { createdAt: "asc" }, take: 50 }),
    requireProjectRole(user.id, project.id, "editor").then(Boolean),
  ]);
  return <AgentReadyApp projectId={project.id} domain={project.domain} sites={sites} canDraft={canDraft} />;
}
