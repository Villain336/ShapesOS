// ShapesOS — /api/crm/inbox shared guard (not a route: no HTTP exports).
//
// Same role rule as /api/messaging: any member (viewer+) reads threads and
// keeps their own read state; replying queues an outbound message, so it
// needs editor+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ForbiddenError, UnauthorizedError } from "@/lib/api/errors";

export interface InboxContext {
  userId: string;
  workspaceId: string;
}

export async function inboxGuard(min: "viewer" | "editor"): Promise<InboxContext> {
  const user = await requireUser();
  if (!user?.id) throw new UnauthorizedError();
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, min))) {
    throw new ForbiddenError(min === "editor" ? "Editors and above can reply." : "Insufficient role for this action.");
  }
  return { userId: user.id, workspaceId: workspace.id };
}
