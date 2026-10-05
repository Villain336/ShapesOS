// ShapesOS — Phase 10 (finance): the signed-in member for finance server pages.

import { redirect } from "next/navigation";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";

export interface FinancePageActor {
  workspaceId: string;
  userId: string;
  role: string;
  workspaceName: string;
  canEdit: boolean;
  isAdmin: boolean;
}

export async function financePageActor(): Promise<FinancePageActor> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const member = await getMembership(user.id, workspace.id);
  if (!member) redirect("/dashboard");
  return {
    workspaceId: workspace.id,
    userId: user.id,
    role: member.role,
    workspaceName: workspace.name,
    canEdit: roleAtLeast(member.role, "editor"),
    isAdmin: roleAtLeast(member.role, "admin"),
  };
}
