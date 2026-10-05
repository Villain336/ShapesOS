// ShapesOS — "Schedule a run" (⌘K action, ⌘J). Schedules live on a project,
// so this opens the existing schedule wizard on the workspace's first project
// (the same default the assistant uses), or the projects list when there is
// none yet. No new data: a redirect only; the wizard and its API keep their
// own permission checks.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ScheduleRunPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const project = await prisma.project.findFirst({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!project) redirect("/dashboard/projects");
  redirect(`/dashboard/projects/${project.id}/automations/schedules/new`);
}
