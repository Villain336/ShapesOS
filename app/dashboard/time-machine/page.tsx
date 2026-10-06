// ShapesOS — Phase 18.3 (WS=flow): Time Machine (/dashboard/time-machine).
// Snapshots + restore into a new workspace (admins), the version history
// hub (any member: what they can see), and where to undo an agent run.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { tmOverview } from "@/lib/timemachine/service";
import { TimeMachineApp } from "@/components/timemachine/TimeMachineApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("flow.timeMachine.title")} — ShapesOS`, description: t("flow.timeMachine.subtitle") };
}

export default async function TimeMachinePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const isAdmin = roleAtLeast(membership.role, "admin");
  const initial = isAdmin ? await tmOverview({ workspaceId: workspace.id, userId: user.id, role: membership.role }) : null;
  return <TimeMachineApp workspaceId={workspace.id} isAdmin={isAdmin} canEdit={roleAtLeast(membership.role, "editor")} initial={initial} />;
}
