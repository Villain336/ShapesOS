// ShapesOS — Phase 9 (apps): the signed-in member as an AppActor (server pages).

import { redirect } from "next/navigation";
import { getMembership } from "@/lib/authz";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import type { AppActor } from "@/lib/apps/service";

export async function pageActor(): Promise<AppActor & { workspaceName: string }> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const member = await getMembership(user.id, workspace.id);
  if (!member) redirect("/dashboard");
  return { workspaceId: workspace.id, userId: user.id, role: member.role, workspaceName: workspace.name };
}
