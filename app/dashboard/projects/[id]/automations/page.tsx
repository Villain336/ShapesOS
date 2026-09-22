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
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-600">
            ← {project.domain}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-zinc-900">Automations</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Build automations as node graphs: triggers → actions, with human approval gates wired
            into the existing approval queue. Runs fail closed and are fully audit-logged.
          </p>
        </div>
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
