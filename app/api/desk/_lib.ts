// ShapesOS — Phase 18.1 (WS=desk): shared guard for /api/desk/*.
//
// Every desk route acts on the CALLER's own desk in the current workspace
// (layout, dock, recents, briefing opt-in, focus, preferences): the person is
// the session subject, never an id from the request, and the rows are
// owner-only under RLS (lib/desktop/scope.ts). Membership is required
// (requireWorkspaceRole viewer+); workspace-wide actions ask for more
// (Pause all agents: admin+).

import type { WorkspaceRole } from "@prisma/client";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";

export interface DeskContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

/** The caller's desk context, or a 401/403 Response to return as is. */
export async function deskGuard(min: WorkspaceRole = "viewer"): Promise<DeskContext | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!membership) {
    return Response.json(
      { error: min === "viewer" ? "You are not a member of this workspace." : `This needs the ${min} role.` },
      { status: 403 },
    );
  }
  return { userId: user.id, workspaceId: workspace.id, role: membership.role };
}

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;
