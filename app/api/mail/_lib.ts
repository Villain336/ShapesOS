// Marketr — /api/mail shared guard (not a route: no HTTP exports).
//
// Mirrors app/api/messaging/_lib.ts: signed-in user → their workspace,
// mutations require editor+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";

export interface MailGuard {
  userId: string;
  workspaceId: string;
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function mailGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<MailGuard | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min === "editor" && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return forbidden();
  }
  return { userId: user.id, workspaceId: workspace.id };
}

export function badRequest(message: string, issues?: unknown) {
  return Response.json({ error: message, ...(issues ? { issues } : {}) }, { status: 400 });
}
