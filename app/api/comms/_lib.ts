// ShapesOS — Phase 18.2 (WS=comms): the shared guard for /api/comms/*
// (not a route: no HTTP exports).
//
// Every comms app is a member app: any member (viewer+) reads it; writes
// that only touch the member's own things (their reminders, read state,
// their messages) are viewer+ too, while writes that act for the workspace
// (sending mail from the CRM ledger, creating calendar events, confirming a
// contact merge) ask for editor+. Each route names its minimum role.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, requireWorkspaceRole } from "@/lib/authz";
import { ForbiddenError, UnauthorizedError } from "@/lib/api/errors";
import type { WorkspaceRole } from "@prisma/client";

export interface CommsContext {
  userId: string;
  email: string | null;
  name: string | null;
  workspaceId: string;
  role: WorkspaceRole;
}

export async function commsGuard(min: "viewer" | "editor" | "admin"): Promise<CommsContext> {
  const user = await requireUser();
  if (!user?.id) throw new UnauthorizedError();
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, min))) {
    throw new ForbiddenError(min === "viewer" ? "You are not a member of this workspace." : `This needs the ${min} role.`);
  }
  const membership = await getMembership(user.id, workspace.id);
  return {
    userId: user.id,
    email: user.email ?? null,
    name: membership?.name ?? (user as { name?: string | null }).name ?? null,
    workspaceId: workspace.id,
    role: (membership?.role ?? "viewer") as WorkspaceRole,
  };
}

/** The member's time zone preference (UTC until known). */
export async function memberTimeZone(userId: string): Promise<string> {
  try {
    const { getUserPreferences } = await import("@/lib/preferences");
    const p = await getUserPreferences(userId);
    return p.timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
