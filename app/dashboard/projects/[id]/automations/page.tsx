// Marketr — automation canvas ("Automations").
// Server page: access check, loads workflows + recent runs, renders the
// client canvas island. Full-bleed: no page header — the canvas carries
// floating palette, toolbar, and inspector (design-v2).

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import WorkflowCanvas from "@/components/WorkflowCanvas";

export const dynamic = "force-dynamic";

export default async function AutomationsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const canEdit = await requireProjectRole(user.id, project.id, "editor");

  const workflows = await prisma.workflow.findMany({
    where: { projectId: project.id },
    orderBy: { updatedAt: "desc" },
    include: {
      nodes: true,
      edges: true,
      _count: { select: { runs: true } },
      runs: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { id: true, status: true, startedAt: true, finishedAt: true },
      },
    },
  });

  const runs = await prisma.workflowRun.findMany({
    where: { projectId: project.id },
    orderBy: { startedAt: "desc" },
    take: 30,
    include: {
      workflow: { select: { id: true, name: true } },
      steps: { orderBy: { startedAt: "asc" } },
    },
  });

  return (
    <div className="h-full">
      <WorkflowCanvas
        projectId={project.id}
        projectDomain={project.domain}
        canEdit={!!canEdit}
        initialWorkflows={JSON.parse(JSON.stringify(workflows))}
        initialRuns={JSON.parse(JSON.stringify(runs))}
      />
    </div>
  );
}
