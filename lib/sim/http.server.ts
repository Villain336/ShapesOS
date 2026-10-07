// ShapesOS — Phase 19B (WS=engine): the town routes' actor (server only).
// Every route under app/api/rehearsal/town first runs guardWorkspace()
// (signed in + the current workspace — the M11 battery's authorization
// primitive), then this resolves the member's role; the service gates the
// dress_rehearsal entitlement and the role (viewer reads, editor changes).

import { ForbiddenError } from "@/lib/api/errors";
import { getMembership } from "@/lib/authz";
import type { PanelActor } from "@/lib/panel/service.server";

export async function townActor(userId: string, workspaceId: string): Promise<PanelActor> {
  const m = await getMembership(userId, workspaceId);
  if (!m) throw new ForbiddenError("You are not a member of this workspace.");
  return { workspaceId, userId, role: m.role };
}
