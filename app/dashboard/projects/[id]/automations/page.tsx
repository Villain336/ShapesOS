// Marketr — automation canvas ("Automations", redesign §2).
// Server page: back link, loads workflows + recent runs, renders the
// client canvas island. Nav wiring is handled by the parent (do not touch
// app/dashboard/projects/[id]/page.tsx).

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import WorkflowCanvas from "@/components/WorkflowCanvas";
import { PageHeader } from "@/components/vault/PageHeader";
import { ArrowLeft } from "lucide-react";

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
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div>
        <Link
          href={`/dashboard/projects/${project.id}`}
          className="inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          {project.domain}
        </Link>
        <PageHeader
          title="Automations"
          description="Build automations as node graphs: triggers → actions, with human approval gates wired into the existing approval queue. Runs fail closed and are fully audit-logged."
          className="mt-1"
        />
      </div>
      <WorkflowCanvas
        projectId={project.id}
        canEdit={!!canEdit}
        initialWorkflows={JSON.parse(JSON.stringify(workflows))}
        initialRuns={JSON.parse(JSON.stringify(runs))}
      />
    </div>
  );
}
