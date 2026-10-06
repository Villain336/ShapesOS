// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor (/dashboard/activity).
// Any member sees the workspace's processes (the Runs page shows the same
// runs); Stop is for the person who started it or an admin/owner; the
// system-wide health rows (scheduled jobs, database connections) are admin+.
// The first snapshot is rendered on the server, then the page follows
// /api/activity/stream (SSE).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { prisma } from "@/lib/prisma";
import { loadProcessSnapshot } from "@/lib/aos/activity.server";
import { ActivityMonitor } from "@/components/activity/ActivityMonitor";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("activityApp.title")} — ShapesOS`, description: t("activityApp.subtitle") };
}

export default async function ActivityPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const isAdmin = roleAtLeast(membership.role, "admin");
  const [snapshot, members] = await Promise.all([
    loadProcessSnapshot(workspace.id, { userId: user.id, isAdmin }),
    prisma.workspaceMember.findMany({ where: { workspaceId: workspace.id, userId: { not: null } }, select: { userId: true, name: true, email: true } }),
  ]);
  const people: Record<string, string> = {};
  for (const m of members) if (m.userId) people[m.userId] = m.name || m.email || "";
  return <ActivityMonitor initial={snapshot} people={people} viewerId={user.id} isAdmin={isAdmin} />;
}
