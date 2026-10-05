// Marketr — new-schedule wizard page (Phase B, W2). Editor+ only.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import ScheduleWizard from "@/components/scheduler/ScheduleWizard";

export const dynamic = "force-dynamic";

export default async function NewSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();
  // Only skills.install holders/admins and project editors may create schedules.
  const canCreate = await requireProjectRole(user.id, project.id, "editor");
  if (!canCreate) notFound();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <div>
        <p className="text-xs font-semibold text-muted">
          <Link href={`/dashboard/projects/${project.id}/automations`} className="hover:text-ink">
            Automations
          </Link>{" "}
          /{" "}
          <Link href={`/dashboard/projects/${project.id}/automations/schedules`} className="hover:text-ink">
            Schedules
          </Link>{" "}
          / New
        </p>
        <h1 className="mt-1 text-xl font-heading stretch-heading tracking-heading text-ink">New schedule</h1>
        <p className="mt-2 text-sm text-muted">
          For <span className="font-medium">{project.domain}</span>. Schedules are project-scoped; workspace-wide
          schedules are created by admins.
        </p>
      </div>
      <ScheduleWizard projectId={project.id} workspaceId={project.workspaceId} />
    </div>
  );
}
