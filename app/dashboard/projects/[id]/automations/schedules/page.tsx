// Marketr — scheduled skills list (Phase B, W2).
// Server page: Automations → Schedules. Viewer+ can read; editors manage.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { accessibleWorkspaceWhere, requireProjectRole, hasPermission } from "@/lib/authz";
import ScheduleList from "@/components/scheduler/ScheduleList";

export const dynamic = "force-dynamic";

export default async function SchedulesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const canManage = !!(await requireProjectRole(user.id, project.id, "editor"));
  const canApprove = await hasPermission(user.id, project.workspaceId, "skills.install");

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            <Link href={`/dashboard/projects/${project.id}/automations`} className="hover:text-accent">
              Automations
            </Link>{" "}
            / Schedules
          </p>
          <h1 className="mt-1 font-display text-3xl">Scheduled skills</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-600">
            Skills that run on a cron schedule or react to workspace events, for{" "}
            <span className="font-medium">{project.domain}</span>. Each run fans out to
            parallel subagents and writes its report to the workspace filesystem.
          </p>
        </div>
        {canManage && (
          <Link
            href={`/dashboard/projects/${project.id}/automations/schedules/new`}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            New schedule
          </Link>
        )}
      </div>
      <ScheduleList
        projectId={project.id}
        workspaceId={project.workspaceId}
        canManage={canManage}
        canApprove={canApprove}
      />
    </div>
  );
}
