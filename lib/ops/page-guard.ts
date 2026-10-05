// ShapesOS Phase 10 (ops-core) — page guard shared by the /dashboard/ops pages.
import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";

/** Signed-in workspace member (viewer+) or redirect. */
export async function requireOpsViewer(): Promise<{ userId: string; workspaceId: string }> {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) redirect("/dashboard");
  return { userId: user.id, workspaceId: workspace.id };
}
