// ShapesOS — Phase 18.3 (WS=trust): shared guard for /api/trust/*.
//
// The Privacy & Security center. Workspace-wide views (audit timeline,
// workspace data access log, memory controls, agent app access) need the
// role each route names (admin+ for the center, viewer+ to READ the app
// access list so the Store and the agent picker can show what is blocked);
// personal views (sessions, devices, what agents read for you, your
// memories) act on the caller's own rows only: the person is always the
// session subject, never an id from the request.

import type { WorkspaceRole } from "@prisma/client";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";

export interface TrustContext {
  userId: string;
  email: string | null;
  workspaceId: string;
  role: WorkspaceRole;
}

/** The caller's context in the active workspace, or a 401/403 Response to return as is. */
export async function trustGuard(min: WorkspaceRole = "viewer"): Promise<TrustContext | Response> {
  const user = await requireUser();
  if (!user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!membership) {
    return Response.json(
      { error: min === "viewer" ? "You are not a member of this workspace." : `This needs the ${min} role.` },
      { status: 403 },
    );
  }
  return { userId: user.id, email: user.email ?? null, workspaceId: workspace.id, role: membership.role };
}

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;
