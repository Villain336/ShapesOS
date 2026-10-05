// ShapesOS — shared admin gate for the outbound-webhook management routes
// (Phase 4a). Webhook endpoints carry a signing secret and send workspace
// data off-site, so every route here is admin+ (requireWorkspaceRole).

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ForbiddenError, UnauthorizedError } from "@/lib/api/errors";

export async function webhookAdmin(): Promise<{ userId: string; workspaceId: string; plan: string }> {
  const user = await requireUser();
  if (!user) throw new UnauthorizedError();
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) {
    throw new ForbiddenError("Managing webhooks needs the admin role.");
  }
  return { userId: user.id, workspaceId: workspace.id, plan: workspace.plan };
}
