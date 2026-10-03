// Marketr — schedule detail page (Phase B, W2). Viewer+ reads; editor+ manages.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { accessibleWorkspaceWhere, requireProjectRole, hasPermission } from "@/lib/authz";
import ScheduleDetail from "@/components/scheduler/ScheduleDetail";

export const dynamic = "force-dynamic";

export default async function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ id: string; scheduleId: string }>;
}) {
  const user = await requireUser();
  if (!user) return null;
  const { id, scheduleId } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const schedule = await prisma.scheduledSkill.findFirst({
    where: { id: scheduleId, workspaceId: project.workspaceId, projectId: project.id },
    include: { skill: { select: { id: true, name: true, slug: true } } },
  });
  if (!schedule) notFound();

  const canManage = !!(await requireProjectRole(user.id, project.id, "editor"));
  const canApprove = await hasPermission(user.id, project.workspaceId, "skills.install");

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          <Link href={`/dashboard/projects/${project.id}/automations`} className="hover:text-accent">Automations</Link>
          {" / "}
          <Link href={`/dashboard/projects/${project.id}/automations/schedules`} className="hover:text-accent">Schedules</Link>
          {" / "}Detail
        </p>
        <h1 className="mt-1 font-display text-3xl">Schedule</h1>
      </div>
      <ScheduleDetail
        projectId={project.id}
        workspaceId={project.workspaceId}
        schedule={{
          id: schedule.id,
          triggerType: schedule.triggerType,
          cronExpr: schedule.cronExpr,
          timezone: schedule.timezone,
          eventSource: schedule.eventSource,
          eventConfig: (schedule.eventConfigJson ?? null) as Record<string, unknown> | null,
          approvalMode: schedule.approvalMode,
          concurrencyLimit: schedule.concurrencyLimit,
          status: schedule.status,
          nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
          lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
          skill: schedule.skill,
        }}
        canManage={canManage}
        canApprove={canApprove}
      />
    </div>
  );
}
